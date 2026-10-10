import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph } from '../types'
import { agentType } from '../hooks/compile'
import { createTracker, type Tracker } from '../hooks/activity'
import { createActivityRun, guard, localKey, setActivityRun, trackSpawn, trackToolCall, trackTurnEnd, type ActivityRun } from '../hooks/actions'
import { connect } from '../hooks/model'

const node = (id: string, name: string): AgentNode => ({
  id, name, x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
// Lead delegates to Helper (delegate-only).
const flow: Graph = connect({ id: 'g', name: 'Flow', description: '', backend: 'local', nodes: [node('a', 'Lead'), node('h', 'Helper')], edges: [] }, 'a', 'h', 'delegate')

const helperType = agentType(flow, flow.nodes[1]!)
const leadType = agentType(flow, flow.nodes[0]!)

function setup(): { run: ActivityRun; tracker: Tracker } {
  let t = 0
  const tracker = createTracker(() => {}, () => (t += 1000))
  tracker.watch(localKey('lead-1'), 'a')
  return { run: createActivityRun(flow, tracker), tracker }
}

test('a call of an agent outside the run passes through untouched', async () => {
  const { run, tracker } = setup()
  const reply = { text: 'x', ref: 1 }
  let calls = 0
  const proceed = async () => (calls++, reply)
  expect(await trackToolCall(run, { tool: 'Bash', command: 'ls', agentId: 'stranger' }, proceed)).toBe(reply)
  expect(await trackToolCall(run, { tool: 'Bash', command: 'ls' }, proceed)).toBe(reply)
  expect(await trackToolCall(undefined, { tool: 'Bash', command: 'ls', agentId: 'lead-1' }, proceed)).toBe(reply)
  expect(calls).toBe(3)
  expect(tracker.itemsOf('a')).toEqual([])
})

test('a watched agent call is recorded ok with its summary, input and result', async () => {
  const { run, tracker } = setup()
  let during: string | undefined
  const reply = { ref: 1, result: { stdout: 'passed' }, text: 'all passed' }
  const got = await trackToolCall(run, { tool: 'Bash', tool_use_id: 'u1', agentId: 'lead-1', command: 'npm test\nsecond line' }, async () => {
    during = tracker.currentOf('a')
    return reply
  })
  expect(got).toBe(reply)
  expect(during).toBe('npm test')
  expect(tracker.itemsOf('a')).toMatchObject([{ tool: 'Bash', summary: 'npm test', status: 'ok', result: 'all passed' }])
  expect(tracker.itemsOf('a')[0]!.input).toBe('{"command":"npm test\\nsecond line"}')
  expect(tracker.currentOf('a')).toBeUndefined()
})

test('a result without text is recorded as JSON; a hook answer of a string as it is', async () => {
  const { run, tracker } = setup()
  await trackToolCall(run, { tool: 'Read', agentId: 'lead-1', file_path: '/a.ts' }, async () => ({ result: { n: 1 } }))
  await trackToolCall(run, { tool: 'Read', agentId: 'lead-1', file_path: '/b.ts' }, async () => ({ result: 'plain' }))
  expect(tracker.itemsOf('a').map(i => i.result)).toEqual(['{"n":1}', 'plain'])
})

test('a call the tool reported as an error is failed', async () => {
  const { run, tracker } = setup()
  await trackToolCall(run, { tool: 'Bash', agentId: 'lead-1', command: 'false' }, async () => ({ isError: true, text: 'exit 1', ref: 2 }))
  expect(tracker.itemsOf('a')).toMatchObject([{ status: 'failed', error: 'exit 1' }])
})

test('a call that throws is failed and the error goes on', async () => {
  const { run, tracker } = setup()
  const failing = trackToolCall(run, { tool: 'Bash', agentId: 'lead-1', command: 'x' }, async () => {
    throw new Error('engine broke')
  })
  await expect(failing).rejects.toThrow('engine broke')
  expect(tracker.itemsOf('a')).toMatchObject([{ status: 'failed', error: 'engine broke' }])
})

test('a denied call is recorded denied with the reason', async () => {
  const { run, tracker } = setup()
  guard.allow('lead-1', [])
  try {
    // The Agent guard sits beneath the tracking hook, as in register.
    const got = await trackToolCall(run, { tool: 'Agent', agentId: 'lead-1', subagent_type: 'general-purpose', description: 'search' }, async () => {
      const why = guard.check('lead-1', 'general-purpose')
      return why === undefined ? { text: 'ran' } : { deny: why }
    })
    expect(got).toEqual({ deny: 'This agent has no delegates in its graph, so it cannot start other agents.' })
  } finally {
    guard.forget('lead-1')
  }
  expect(tracker.itemsOf('a')).toMatchObject([{
    tool: 'Agent', summary: 'search', status: 'denied', error: 'This agent has no delegates in its graph, so it cannot start other agents.',
  }])
})

test('a tracker that fails never touches the call', async () => {
  const { run, tracker } = setup()
  const broken: Tracker = {
    ...tracker,
    callStart: () => {
      throw new Error('tracker bug')
    },
    callEnd: () => {
      throw new Error('tracker bug')
    },
    childOf: () => {
      throw new Error('tracker bug')
    },
  }
  const bad: ActivityRun = { ...run, tracker: broken }
  const reply = { text: 'fine' }
  expect(await trackToolCall(bad, { tool: 'Bash', agentId: 'lead-1', command: 'ls' }, async () => reply)).toBe(reply)
  // callStart works but callEnd throws.
  const endBroken: ActivityRun = { ...run, tracker: { ...tracker, callEnd: broken.callEnd } }
  expect(await trackToolCall(endBroken, { tool: 'Bash', agentId: 'lead-1', command: 'ls' }, async () => reply)).toBe(reply)
  const spawned = { model: 'm', agentId: 'helper-1' }
  expect(await trackSpawn(bad, { parentAgentId: 'lead-1', subagentType: helperType }, async () => spawned)).toBe(spawned)
  expect(() => trackTurnEnd(bad, { agentId: 'helper-1', answer: '', reason: 'answer' })).not.toThrow()
})

test('a spawned delegate nests its calls under the parent delegate item, and the helper entry runs then ends', async () => {
  const { run, tracker } = setup()
  const type = helperType
  const seen: Array<{ items: number; helper?: string }> = []
  const snap = () => seen.push({ items: tracker.itemsOf('a').length, helper: tracker.helpersOf('a')[0]?.status })

  // Lead calls the Agent tool; beneath it the engine spawns the child, which then works and answers.
  const outcome = await trackToolCall(run, { tool: 'Agent', agentId: 'lead-1', subagent_type: type, description: 'look it up' }, async () => {
    const spawned = await trackSpawn(run, { parentAgentId: 'lead-1', subagentType: type }, async () => ({ model: 'm', agentId: 'helper-1' }))
    expect(spawned.agentId).toBe('helper-1')
    snap()
    await trackToolCall(run, { tool: 'Grep', agentId: 'helper-1', pattern: 'TODO', path: 'src' }, async () => ({ text: '3 hits' }))
    trackTurnEnd(run, { agentId: 'helper-1', answer: 'found it', reason: 'answer' })
    return { text: 'found it' }
  })
  expect(outcome).toEqual({ text: 'found it' })
  snap()

  const [item, ...rest] = tracker.itemsOf('a')
  expect(rest).toEqual([])
  expect(item).toMatchObject({
    tool: 'Agent', status: 'ok', result: 'found it',
    delegate: { name: 'Helper', nodeId: 'h', items: [{ tool: 'Grep', summary: 'TODO in src', status: 'ok', result: '3 hits' }] },
  })
  expect(seen).toEqual([{ items: 1, helper: 'running' }, { items: 1, helper: 'done' }])
  expect(tracker.helpersOf('a')).toMatchObject([{ nodeId: 'h', name: 'Helper', calledBy: 'a', status: 'done' }])
  // The child is no longer watched once its turn is over.
  expect(tracker.callStart(localKey('helper-1'), 'Bash', {})).toBeUndefined()
})

test('a background delegate stays open after the Agent tool answers, until its own turn ends', async () => {
  for (const [reason, status, helper] of [['answer', 'ok', 'done'], ['error', 'failed', 'failed']] as const) {
    const { run, tracker } = setup()
    const launched = await trackToolCall(run, { tool: 'Agent', agentId: 'lead-1', subagent_type: helperType, description: 'later', run_in_background: true }, async () => {
      await trackSpawn(run, { parentAgentId: 'lead-1', subagentType: helperType }, async () => ({ model: 'm', agentId: 'helper-1' }))
      return { text: 'Async agent launched' }
    })
    expect(launched).toEqual({ text: 'Async agent launched' })
    // The tool has answered, the helper has not.
    expect(tracker.itemsOf('a')).toMatchObject([{ tool: 'Agent', status: 'running' }])
    expect(tracker.helpersOf('a')).toMatchObject([{ nodeId: 'h', status: 'running' }])
    await trackToolCall(run, { tool: 'Bash', agentId: 'helper-1', command: 'npm test' }, async () => {
      expect(tracker.currentOf('a')).toBe('npm test')
      return { text: 'ok' }
    })
    expect(tracker.helpersOf('a')[0]!.status).toBe('running')
    trackTurnEnd(run, { agentId: 'helper-1', answer: 'finished', reason })
    expect(tracker.itemsOf('a')).toMatchObject([{ status, delegate: { items: [{ tool: 'Bash', status: 'ok' }] } }])
    expect(tracker.helpersOf('a')).toMatchObject([{ nodeId: 'h', status: helper }])
  }
})

test('a refused Agent call that had started a delegate ends at once', async () => {
  const { run, tracker } = setup()
  await trackToolCall(run, { tool: 'Agent', agentId: 'lead-1', subagent_type: helperType, description: 'x' }, async () => {
    await trackSpawn(run, { parentAgentId: 'lead-1', subagentType: helperType }, async () => ({ model: 'm', agentId: 'helper-1' }))
    return { isError: true, text: 'could not run' }
  })
  expect(tracker.itemsOf('a')).toMatchObject([{ status: 'failed', error: 'could not run' }])
})

test('a call or spawn of an agent that is not watched does no tracker work', async () => {
  const { run, tracker } = setup()
  const touched: string[] = []
  const spy: Tracker = {
    ...tracker,
    callStart: (...args) => (touched.push('callStart'), tracker.callStart(...args)),
    childOf: (...args) => (touched.push('childOf'), tracker.childOf(...args)),
  }
  const probe: ActivityRun = { ...run, tracker: spy }
  await trackToolCall(probe, { tool: 'Bash', agentId: 'stranger', command: 'ls' }, async () => ({ text: 'x' }))
  await trackSpawn(probe, { parentAgentId: 'stranger', subagentType: helperType }, async () => ({ model: 'm', agentId: 'c' }))
  expect(touched).toEqual([])
  await trackToolCall(probe, { tool: 'Bash', agentId: 'lead-1', command: 'ls' }, async () => ({ text: 'x' }))
  expect(touched).toEqual(['callStart'])
  expect(tracker.isWatched(localKey('lead-1'))).toBe(true)
  expect(tracker.isWatched(localKey('stranger'))).toBe(false)
})

test('a delegate whose turn ends in error closes its item failed', async () => {
  const { run, tracker } = setup()
  const type = helperType
  await trackToolCall(run, { tool: 'Agent', agentId: 'lead-1', subagent_type: type, description: 'try' }, async () => {
    await trackSpawn(run, { parentAgentId: 'lead-1', subagentType: type }, async () => ({ model: 'm', agentId: 'helper-1' }))
    trackTurnEnd(run, { agentId: 'helper-1', answer: '', reason: 'error' })
    return { text: 'agent failed' }
  })
  expect(tracker.itemsOf('a')).toMatchObject([{ status: 'failed', error: 'error' }])
  expect(tracker.helpersOf('a')).toMatchObject([{ nodeId: 'h', status: 'failed' }])
})

test('a spawn by an agent outside the run, or one that failed, is left alone', async () => {
  const { run, tracker } = setup()
  const type = helperType
  const reply = { model: 'm', agentId: 'x-1' }
  expect(await trackSpawn(run, { parentAgentId: 'stranger', subagentType: type }, async () => reply)).toBe(reply)
  expect(await trackSpawn(run, { subagentType: type }, async () => reply)).toBe(reply)
  expect(await trackSpawn(undefined, { parentAgentId: 'lead-1', subagentType: type }, async () => reply)).toBe(reply)
  const denied = { deny: 'no' }
  expect(await trackSpawn(run, { parentAgentId: 'lead-1', subagentType: type }, async () => denied)).toBe(denied)
  expect(tracker.itemsOf('a')).toEqual([])
  expect(tracker.callStart(localKey('x-1'), 'Bash', {})).toBeUndefined()
})

test('a delegate of a type outside the graph is shown under its type name', async () => {
  const { run, tracker } = setup()
  await trackToolCall(run, { tool: 'Agent', agentId: 'lead-1', subagent_type: 'Explore', description: 'x' }, async () => {
    await trackSpawn(run, { parentAgentId: 'lead-1', subagentType: 'Explore' }, async () => ({ model: 'm', agentId: 'ex-1' }))
    return { text: 'ok' }
  })
  expect(tracker.itemsOf('a')[0]!.delegate).toMatchObject({ name: 'Explore', items: [] })
  expect(tracker.itemsOf('a')[0]!.delegate!.nodeId).toBeUndefined()
})

test('a subagent type is matched to the graph agent that has it', async () => {
  const { run } = setup()
  expect(run.nodeOfType(helperType)).toEqual({ nodeId: 'h', name: 'Helper' })
  expect(run.nodeOfType(leadType)).toEqual({ nodeId: 'a', name: 'Lead' })
  expect(run.nodeOfType('general-purpose')).toBeUndefined()
})

test('the hooks of register pass every call through, with or without a run', async ($, on) => {
  const core: string[] = []
  on('tool.call', (_$, e) => {
    core.push(String((e as unknown as { command?: string }).command))
    return { result: 'core ran', text: 'core ran', ref: 1 } as never
  })
  on('agent.spawn', () => ({ model: 'm', agentId: 'child-1' }) as never)
  const { run, tracker } = setup()
  for (const active of [undefined, run]) {
    setActivityRun(active)
    try {
      expect(await $.tool.call({ tool: 'Bash', command: `echo ${active === undefined ? 'one' : 'two'}` } as never)).toMatchObject({ text: 'core ran' })
      expect(await $.agent.spawn({ prompt: 'p', subagentType: helperType } as never)).toMatchObject({ agentId: 'child-1' })
      // The Agent guard answers a main-loop call with next(e), tracked or not.
      expect(await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'd', subagent_type: 'general-purpose' } as never)).toMatchObject({ text: 'core ran' })
    } finally {
      setActivityRun(undefined)
    }
  }
  // The main loop is no agent of the run, and the spawn had no watched parent.
  expect(tracker.itemsOf('a')).toEqual([])
  expect(core).toEqual(['echo one', 'undefined', 'echo two', 'undefined'])
})

test('parallel delegates nest under the Agent call they were spawned by, whichever spawn lands first', async () => {
  // Lead delegates to One and to Two.
  const two = connect(connect({ id: 'g2', name: 'Flow', description: '', backend: 'local', nodes: [node('a', 'Lead'), node('h1', 'One'), node('h2', 'Two')], edges: [] }, 'a', 'h1', 'delegate'), 'a', 'h2', 'delegate')
  const [typeOne, typeTwo] = [agentType(two, two.nodes[1]!), agentType(two, two.nodes[2]!)]
  const tracker = createTracker(() => {}, () => 1)
  tracker.watch(localKey('lead-1'), 'a')
  const run = createActivityRun(two, tracker)
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  // One's spawn waits until Two's has landed and Two has worked.
  const first = trackToolCall(run, { tool: 'Agent', agentId: 'lead-1', tool_use_id: 'tu-1', subagent_type: typeOne, description: 'one' }, async () => {
    await held
    await trackSpawn(run, { parentAgentId: 'lead-1', subagentType: typeOne, tool_use_id: 'tu-1' }, async () => ({ agentId: 'one-1' }))
    await trackToolCall(run, { tool: 'Read', agentId: 'one-1', file_path: '/one' }, async () => ({ text: '1' }))
    trackTurnEnd(run, { agentId: 'one-1', answer: 'one done', reason: 'answer' })
    return { text: 'one done' }
  })
  const second = trackToolCall(run, { tool: 'Agent', agentId: 'lead-1', tool_use_id: 'tu-2', subagent_type: typeTwo, description: 'two' }, async () => {
    await trackSpawn(run, { parentAgentId: 'lead-1', subagentType: typeTwo, tool_use_id: 'tu-2' }, async () => ({ agentId: 'two-1' }))
    await trackToolCall(run, { tool: 'Read', agentId: 'two-1', file_path: '/two' }, async () => ({ text: '2' }))
    trackTurnEnd(run, { agentId: 'two-1', answer: 'two done', reason: 'answer' })
    release()
    return { text: 'two done' }
  })
  await Promise.all([first, second])
  expect(tracker.itemsOf('a').map(i => [i.summary, i.delegate?.nodeId, i.delegate?.items.map(n => n.summary)])).toEqual([
    ['one', 'h1', ['/one']],
    ['two', 'h2', ['/two']],
  ])
  expect(tracker.itemsOf('a').map(i => [i.status, i.result])).toEqual([['ok', 'one done'], ['ok', 'two done']])
})
