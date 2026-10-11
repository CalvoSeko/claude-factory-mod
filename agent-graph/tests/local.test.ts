import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph } from '../types'
import { VERDICT_SECTION, type LocalAgentSpec } from '../hooks/compile'
import { createGuard } from '../hooks/guard'
import { createCompletions, createLocalBackend, localKey, outcomeOf, type LocalDeps } from '../hooks/local'
import { createTracker } from '../hooks/activity'
import { connect } from '../hooks/model'
import { createMeter, type Usage } from '../hooks/cost'
import { runGraph } from '../hooks/runner'
import { completions } from '../hooks/actions'
import { register } from '../hooks/register'

declare const setTimeout: (run: () => void, ms?: number) => unknown

const node = (id: string, name: string, contextFiles: string[] = []): AgentNode => ({
  id, name, x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles, tools: [], model: null, budgetUsd: 2,
})
const graph = (nodes: AgentNode[]): Graph => ({ id: 'g', name: 'Flow', description: '', backend: 'local', nodes, edges: [] })

function deps(over: Partial<LocalDeps> = {}) {
  const registered: LocalAgentSpec[] = []
  const stopped: string[] = []
  const d: LocalDeps = {
    register: async spec => void registered.push(spec),
    spawn: async () => ({ agentId: 'agent-1' }),
    stopAgent: async id => void stopped.push(id),
    instructions: async n => `I am ${n.name}.`,
    context: { kind: async () => 'missing', read: async () => '', files: async () => [] },
    completions: createCompletions(),
    guard: createGuard(),
    ...over,
  }
  return { d, registered, stopped }
}

test('the guard allows only listed delegates for agents in a run', async () => {
  const guard = createGuard()
  guard.allow('a1', ['agent-graph:flow--reader'])
  expect(guard.check(undefined, 'anything')).toBeUndefined()
  expect(guard.check('other', 'anything')).toBeUndefined()
  expect(guard.check('a1', 'agent-graph:flow--reader')).toBeUndefined()
  expect(guard.check('a1', 'general-purpose')).toBe('This agent may only delegate to: agent-graph:flow--reader.')
  guard.forget('a1')
  expect(guard.check('a1', 'general-purpose')).toBeUndefined()
  guard.allow('a2', [])
  expect(guard.check('a2', 'x')).toBe('This agent has no delegates in its graph, so it cannot start other agents.')
})

test('completions resolve whether the turn ends before or after the wait', async () => {
  const completions = createCompletions()
  completions.complete({ agentId: 'early', answer: 'A', reason: 'answer' })
  expect(await completions.wait('early')).toEqual({ agentId: 'early', answer: 'A', reason: 'answer' })
  const later = completions.wait('late')
  completions.complete({ agentId: 'late', answer: 'B', reason: 'answer' })
  expect((await later).answer).toBe('B')
})

test('turn endings map to outcomes', async () => {
  expect(outcomeOf({ agentId: 'x', answer: 'A', reason: 'answer' })).toEqual({ ok: true, text: 'A', files: [] })
  expect(outcomeOf({ agentId: 'x', answer: '', reason: 'aborted' })).toEqual({ ok: false, reason: 'Stopped.' })
  expect(outcomeOf({ agentId: 'x', answer: '', reason: 'refusal', refusal: 'cyber' })).toEqual({ ok: false, reason: 'Refused: cyber' })
  expect(outcomeOf({ agentId: 'x', answer: '', reason: 'refusal' })).toEqual({ ok: false, reason: 'Refused.' })
  expect(outcomeOf({ agentId: 'x', answer: '', reason: 'error' })).toEqual({ ok: false, reason: 'The agent stopped with an error.' })
})

test('prepare registers every node and reports missing context', async () => {
  const g = graph([node('a', 'Lead'), node('b', 'Reader', ['gone.md'])])
  const { d, registered } = deps()
  const problems = await createLocalBackend(g, d).prepare(g)
  expect(registered.map(s => s.name)).toEqual(['flow--lead-a'])
  expect(problems).toEqual([{ target: { kind: 'node', id: 'b' }, message: 'Context path not found: gone.md' }])
})

test('start spawns the node type, guards its delegates and resolves on its turn end', async () => {
  const g = connect(graph([node('a', 'Lead'), node('b', 'Reader')]), 'a', 'b', 'delegate')
  const spawned: string[] = []
  const { d, stopped } = deps({ spawn: async args => { spawned.push(args.subagentType); return { agentId: 'run-a' } } })
  const run = await createLocalBackend(g, d).start(g.nodes[0]!, 'go', [], () => {})
  expect(spawned).toEqual(['agent-graph:flow--lead-a'])
  expect(d.guard.check('run-a', 'agent-graph:flow--reader-b')).toBeUndefined()
  expect(d.guard.check('run-a', 'general-purpose')).toBeDefined()
  await run.stop()
  expect(stopped).toEqual(['run-a'])
  d.completions.complete({ agentId: 'run-a', answer: 'done!', reason: 'answer' })
  expect(await run.done).toEqual({ ok: true, text: 'done!', files: [] })
  expect(d.guard.check('run-a', 'general-purpose')).toBeUndefined()
})

test('a refused spawn fails the node', async () => {
  const g = graph([node('a', 'Lead')])
  const { d } = deps({ spawn: async () => ({ deny: 'blocked by policy' }) })
  const run = await createLocalBackend(g, d).start(g.nodes[0]!, 'go', [], () => {})
  expect(await run.done).toEqual({ ok: false, reason: 'blocked by policy' })
})

test('the backend watches each started agent for activity and unwatches it when its turn ends', async () => {
  const g = graph([node('a', 'Lead')])
  const tracker = createTracker(() => {}, () => 1)
  const { d } = deps({ spawn: async () => ({ agentId: 'run-a' }), tracker: () => tracker })
  const run = await createLocalBackend(g, d).start(g.nodes[0]!, 'go', [], () => {})
  expect(localKey('run-a')).toBe('local:run-a')
  const id = tracker.callStart(localKey('run-a'), 'Bash', { command: 'ls' })
  expect(id).toBeDefined()
  expect(tracker.itemsOf('a')).toMatchObject([{ tool: 'Bash', status: 'running' }])
  d.completions.complete({ agentId: 'run-a', answer: 'A', reason: 'answer' })
  await run.done
  expect(tracker.callStart(localKey('run-a'), 'Bash', {})).toBeUndefined()
  // The call that was open when the turn ended can still be closed.
  tracker.callEnd(id!, { ok: true })
  expect(tracker.itemsOf('a')).toMatchObject([{ status: 'ok' }])
})

test('a refused spawn is not watched, and a backend without a tracker starts as before', async () => {
  const g = graph([node('a', 'Lead')])
  const tracker = createTracker(() => {}, () => 1)
  const refused = deps({ spawn: async () => ({ deny: 'no' }), tracker: () => tracker })
  await createLocalBackend(g, refused.d).start(g.nodes[0]!, 'go', [], () => {})
  expect(tracker.callStart(localKey('run-a'), 'Bash', {})).toBeUndefined()
  const bare = deps({ spawn: async () => ({ agentId: 'run-b' }), tracker: () => undefined })
  const run = await createLocalBackend(g, bare.d).start(g.nodes[0]!, 'go', [], () => {})
  bare.d.completions.complete({ agentId: 'run-b', answer: 'B', reason: 'answer' })
  expect(await run.done).toEqual({ ok: true, text: 'B', files: [] })
})

test('prepare reports context files that add up to more than 200 KB, and registers nothing for them', async () => {
  const g = graph([node('a', 'Lead', ['big.md']), node('b', 'Reader')])
  const { d, registered } = deps({
    context: { kind: async p => (p === 'big.md' ? 'file' : 'missing'), read: async () => 'x'.repeat(200 * 1024 + 1), files: async () => [] },
  })
  const problems = await createLocalBackend(g, d).prepare(g)
  expect(problems).toEqual([{ target: { kind: 'node', id: 'a' }, message: 'Context files add up to more than 200 KB; trim them or use fewer.' }])
  expect(registered.map(s => s.name)).toEqual(['flow--reader-b'])
})

test('prepare reports an agent that cannot be registered and goes on with the others', async () => {
  const g = graph([node('a', 'Lead'), node('b', 'Reader')])
  const registered: string[] = []
  const { d } = deps({
    register: async spec => {
      if (spec.name === 'flow--lead-a') throw new Error('name taken')
      registered.push(spec.name)
    },
  })
  const problems = await createLocalBackend(g, d).prepare(g)
  expect(problems).toEqual([{ target: { kind: 'node', id: 'a' }, message: 'Could not register this agent: name taken' }])
  expect(registered).toEqual(['flow--reader-b'])
})

test('a stopped run may start nothing more; its guard entry goes with its turn end', async () => {
  const g = connect(graph([node('a', 'Lead'), node('b', 'Reader')]), 'a', 'b', 'delegate')
  const { d } = deps({ spawn: async () => ({ agentId: 'run-a' }) })
  const run = await createLocalBackend(g, d).start(g.nodes[0]!, 'go', [], () => {})
  expect(d.guard.check('run-a', 'general-purpose')).toBeDefined()
  await run.stop()
  expect(d.guard.check('run-a', 'general-purpose')).toBe('This agent was stopped, so it cannot start other agents.')
  expect(d.guard.check('run-a', 'agent-graph:flow--reader-b')).toBeDefined()
  d.completions.complete({ agentId: 'run-a', answer: '', reason: 'aborted' })
  expect(await run.done).toEqual({ ok: false, reason: 'Stopped.' })
  expect(d.guard.check('run-a', 'general-purpose')).toBeUndefined()
})

test('stopping a run that already ended leaves no guard entry behind', async () => {
  const g = graph([node('a', 'Lead')])
  const { d } = deps({ spawn: async () => ({ agentId: 'run-a' }) })
  const run = await createLocalBackend(g, d).start(g.nodes[0]!, 'go', [], () => {})
  d.completions.complete({ agentId: 'run-a', answer: 'A', reason: 'answer' })
  await run.done
  await run.stop()
  expect(d.guard.check('run-a', 'general-purpose')).toBeUndefined()
})

test('waits that never get a turn end are capped, the oldest ending as an error', async () => {
  const completions = createCompletions()
  const first = completions.wait('run-0')
  for (let i = 1; i <= 50; i++) void completions.wait(`run-${i}`)
  expect(await first).toEqual({ agentId: 'run-0', answer: '', reason: 'error' })
  completions.complete({ agentId: 'run-1', answer: 'A', reason: 'answer' })
  completions.complete({ agentId: 'run-0', answer: 'late', reason: 'answer' })
  expect(await completions.wait('run-0')).toEqual({ agentId: 'run-0', answer: 'late', reason: 'answer' })
})

// ---- temporary failures ----

test('a reported API error goes with the agent\'s error turn end, and is used up by its turn end', async () => {
  const completions = createCompletions()
  completions.fail('a1', { error: 'rate_limit', details: 'slow down' })
  completions.complete({ agentId: 'a1', answer: '', reason: 'error' })
  expect(await completions.wait('a1')).toEqual({ agentId: 'a1', answer: '', reason: 'error', failure: { error: 'rate_limit', details: 'slow down' } })
  completions.complete({ agentId: 'a1', answer: '', reason: 'error' })
  expect((await completions.wait('a1')).failure).toBeUndefined()
  // An end that is not an error drops it too.
  completions.fail('a2', { error: 'overloaded' })
  completions.complete({ agentId: 'a2', answer: 'ok', reason: 'answer' })
  expect(await completions.wait('a2')).toEqual({ agentId: 'a2', answer: 'ok', reason: 'answer' })
  completions.complete({ agentId: 'a2', answer: '', reason: 'error' })
  expect((await completions.wait('a2')).failure).toBeUndefined()
})

test('an error turn end with an API error of a limit, an overload, a server or the network is temporary, and says why', async () => {
  const end = (error: string, details?: string) =>
    outcomeOf({ agentId: 'x', answer: '', reason: 'error', failure: { error, ...(details !== undefined ? { details } : {}) } })
  expect(end('rate_limit', 'API Error: 429 rate_limit_error')).toEqual({
    ok: false, reason: 'The agent stopped with an error: API Error: 429 rate_limit_error', transient: { kind: 'rate-limit', text: 'API Error: 429 rate_limit_error' },
  })
  expect(end('overloaded')).toEqual({ ok: false, reason: 'The agent stopped with an error: overloaded', transient: { kind: 'overloaded', text: 'overloaded' } })
  expect(end('server_error')).toMatchObject({ transient: { kind: 'server' } })
  expect(end('unknown', 'read ECONNRESET')).toMatchObject({ reason: 'The agent stopped with an error: read ECONNRESET', transient: { kind: 'network' } })
  expect(end('invalid_request', 'prompt is too long')).toEqual({ ok: false, reason: 'The agent stopped with an error: prompt is too long' })
  expect(end('authentication_failed', '429')).toEqual({ ok: false, reason: 'The agent stopped with an error: 429' })
})

test('without a reported kind, only an error end whose answer is the engine\'s API Error text is read', async () => {
  expect(outcomeOf({ agentId: 'x', answer: 'API Error: 529 {"type":"overloaded_error"}', reason: 'error' })).toEqual({
    ok: false, reason: 'The agent stopped with an error: API Error: 529 {"type":"overloaded_error"}', transient: { kind: 'overloaded', text: 'API Error: 529 {"type":"overloaded_error"}' },
  })
  expect(outcomeOf({ agentId: 'x', answer: 'The server returned 500 rows, ECONNRESET aside.', reason: 'error' })).toEqual({ ok: false, reason: 'The agent stopped with an error.' })
  // An answer is never read as an error, whatever it says.
  expect(outcomeOf({ agentId: 'x', answer: 'API Error: 529', reason: 'answer' })).toEqual({ ok: true, text: 'API Error: 529', files: [] })
  expect(outcomeOf({ agentId: 'x', answer: 'API Error: 529', reason: 'aborted' })).toEqual({ ok: false, reason: 'Stopped.' })
  expect(outcomeOf({ agentId: 'x', answer: 'API Error: 529', reason: 'refusal', refusal: 'cyber' })).toEqual({ ok: false, reason: 'Refused: cyber' })
})

test('the engine\'s StopFailure of a sub-agent goes with its turn end; the main thread\'s is ignored', async () => {
  // register's two hooks, taken from a registration that keeps only them, run with this file's completions.
  const hooks = new Map<string, (...args: unknown[]) => unknown>()
  register(((name: string, ...rest: unknown[]) => void hooks.set(name, rest[rest.length - 1] as (...args: unknown[]) => unknown)) as never, {})
  const next = () => undefined
  const ended = completions.wait('ag-sf')
  hooks.get('classic.StopFailure')!({}, { hook_event_name: 'StopFailure', error: 'rate_limit', error_details: 'API Error: 429' }, next)
  hooks.get('classic.StopFailure')!({}, { hook_event_name: 'StopFailure', error: 'overloaded', agent_id: 'ag-sf' }, next)
  hooks.get('turn.complete')!({}, { agentId: 'ag-sf', answer: '', reason: 'error' }, next)
  expect(outcomeOf(await ended)).toMatchObject({ ok: false, transient: { kind: 'overloaded' } })
})

test('a Local run starts the agent again after a rate limit; the first agent is let go', async () => {
  const g = connect(graph([node('a', 'Lead'), node('b', 'Reader')]), 'a', 'b', 'delegate')
  const spawned: string[] = []
  const { d } = deps({
    spawn: async () => {
      const agentId = `ag-${spawned.length + 1}`
      spawned.push(agentId)
      // The engine ends the turn after the spawn has returned: the first with a rate limit, the second with an answer.
      setTimeout(() => {
        if (agentId === 'ag-1') d.completions.fail(agentId, { error: 'rate_limit', details: 'API Error: 429' })
        d.completions.complete(agentId === 'ag-1' ? { agentId, answer: '', reason: 'error' } : { agentId, answer: 'All done', reason: 'answer' })
      }, 1)
      return { agentId }
    },
  })
  const waits: number[] = []
  const result = await runGraph(g, 'Go', createLocalBackend(g, d), { onUpdate: () => {}, wait: async ms => void waits.push(ms), now: () => 0 })
  expect('outputs' in result && result.outputs).toEqual({ a: 'All done' })
  expect(spawned).toEqual(['ag-1', 'ag-2'])
  expect(waits).toEqual([30_000])
  expect(d.guard.check('ag-1', 'general-purpose')).toBeUndefined()
})

// 100 000 input and 20 000 output tokens of Sonnet 4.6: $0.60.
const request: Usage = { model: 'claude-sonnet-4-6', input_tokens: 100_000, output_tokens: 20_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const cents = (usd: number) => Math.round(usd * 100)

test('the Local backend estimates its costs and reports each total of the agent through onCost', async () => {
  const g = graph([node('a', 'Lead')])
  const meter = createMeter()
  const { d, stopped } = deps({ meter: () => meter })
  const backend = createLocalBackend(g, d)
  expect(backend.estimatesCost).toBe(true)
  const costs: number[] = []
  const run = await backend.start(g.nodes[0]!, 'go', [], usd => costs.push(usd))
  meter.add('agent-1', request, 0)
  meter.add('agent-1', request, 1)
  expect(costs.map(cents)).toEqual([60, 121])
  // Under the $2 budget: not stopped.
  expect(stopped).toEqual([])
  d.completions.complete({ agentId: 'agent-1', answer: 'A', reason: 'answer' })
  expect(await run.done).toEqual({ ok: true, text: 'A', files: [] })
  // Its turn is over: it is no longer watched.
  meter.add('agent-1', request, 0)
  expect(costs).toHaveLength(2)
})

test('an agent at or over its budget is stopped once and ends failed with the budget as entered', async () => {
  const g = graph([{ ...node('a', 'Lead'), budgetUsd: 1.2 }])
  const meter = createMeter()
  const { d, stopped } = deps({ meter: () => meter })
  const costs: number[] = []
  const run = await createLocalBackend(g, d).start(g.nodes[0]!, 'go', [], usd => costs.push(usd))
  meter.add('agent-1', request, 0)
  expect(stopped).toEqual([])
  // Exactly at the budget counts: $1.20.
  meter.add('agent-1', request, 0)
  expect(await run.done).toEqual({ ok: false, reason: 'Hit its $1.2 budget.' })
  expect(stopped).toEqual(['agent-1'])
  // The node has its ending, but the agent has not ended: it starts nothing more, and is still counted.
  expect(d.guard.check('agent-1', 'general-purpose')).toBe('This agent was stopped, so it cannot start other agents.')
  meter.add('agent-1', request, 0)
  expect(costs.map(cents)).toEqual([60, 120, 180])
  // The engine's own turn end changes nothing but the cleanup: no second stop, the guard entry goes, the meter lets go.
  d.completions.complete({ agentId: 'agent-1', answer: '', reason: 'aborted' })
  await run.stop()
  expect(stopped).toEqual(['agent-1'])
  expect(d.guard.check('agent-1', 'general-purpose')).toBeUndefined()
  meter.add('agent-1', request, 0)
  expect(costs).toHaveLength(3)
})

test('an agent whose budget stop failed stays guarded and counted until its turn really ends', async () => {
  const g = graph([{ ...node('a', 'Lead'), budgetUsd: 0.5 }])
  const meter = createMeter()
  const { d } = deps({
    meter: () => meter,
    stopAgent: async () => {
      throw new Error('engine said no')
    },
  })
  const costs: number[] = []
  const run = await createLocalBackend(g, d).start(g.nodes[0]!, 'go', [], usd => costs.push(usd))
  meter.add('agent-1', request, 0)
  expect(await run.done).toEqual({ ok: false, reason: 'Hit its $0.5 budget.' })
  expect(d.guard.check('agent-1', 'general-purpose')).toBe('This agent was stopped, so it cannot start other agents.')
  meter.add('agent-1', request, 0)
  expect(costs.map(cents)).toEqual([60, 120])
  d.completions.complete({ agentId: 'agent-1', answer: 'late', reason: 'answer' })
  await Promise.resolve()
  expect(d.guard.check('agent-1', 'general-purpose')).toBeUndefined()
})

test('a request that crosses the budget after the person stopped the agent keeps the Stopped ending', async () => {
  const g = graph([{ ...node('a', 'Lead'), budgetUsd: 0.5 }])
  const meter = createMeter()
  const { d, stopped } = deps({ meter: () => meter })
  const costs: number[] = []
  const run = await createLocalBackend(g, d).start(g.nodes[0]!, 'go', [], usd => costs.push(usd))
  await run.stop()
  meter.add('agent-1', request, 0)
  d.completions.complete({ agentId: 'agent-1', answer: '', reason: 'aborted' })
  expect(await run.done).toEqual({ ok: false, reason: 'Stopped.' })
  expect(stopped).toEqual(['agent-1'])
  expect(costs.map(cents)).toEqual([60])
})

test('the budget covers the delegates an agent started', async () => {
  const g = graph([{ ...node('a', 'Lead'), budgetUsd: 1 }])
  const meter = createMeter()
  const { d, stopped } = deps({ meter: () => meter })
  const run = await createLocalBackend(g, d).start(g.nodes[0]!, 'go', [], () => {})
  meter.childOf('agent-1', 'helper-1')
  meter.childOf('helper-1', 'deeper-1')
  meter.add('helper-1', request, 0)
  expect(stopped).toEqual([])
  meter.add('deeper-1', request, 0)
  expect(await run.done).toEqual({ ok: false, reason: 'Hit its $1 budget.' })
  expect(stopped).toEqual(['agent-1'])
})

test('the budget stop does not wait for the engine to confirm it, and a failing onCost or stop changes nothing', async () => {
  const g = graph([{ ...node('a', 'Lead'), budgetUsd: 0.5 }])
  const meter = createMeter()
  const { d } = deps({
    meter: () => meter,
    stopAgent: async () => {
      throw new Error('engine said no')
    },
  })
  const run = await createLocalBackend(g, d).start(g.nodes[0]!, 'go', [], () => {
    throw new Error('display bug')
  })
  expect(() => meter.add('agent-1', request, 0)).not.toThrow()
  expect(await run.done).toEqual({ ok: false, reason: 'Hit its $0.5 budget.' })
})

test('a budget stop is shown failed, a person stop cancelled, and the cost is marked estimated', async () => {
  const g = graph([{ ...node('a', 'Lead'), budgetUsd: 0.5 }])
  const settings = async (hit: boolean) => {
    const meter = createMeter()
    const controller = new AbortController()
    let started!: () => void
    const hasStarted = new Promise<void>(resolve => (started = resolve))
    const { d } = deps({
      meter: () => meter,
      spawn: async () => (started(), { agentId: 'agent-1' }),
    })
    d.stopAgent = async id => d.completions.complete({ agentId: id, answer: '', reason: 'aborted' })
    const views: Array<{ status: string; error?: string; costUsd?: number; costEstimated?: boolean }> = []
    const finished = runGraph(g, 'task', createLocalBackend(g, d), { onUpdate: v => void views.push(v.nodes['a']!), signal: controller.signal })
    await hasStarted
    for (let i = 0; i < 20; i++) await Promise.resolve()
    if (hit) meter.add('agent-1', request, 0)
    else {
      meter.add('agent-1', { ...request, input_tokens: 1, output_tokens: 1 }, 0)
      controller.abort()
    }
    await finished
    return views[views.length - 1]!
  }
  expect(await settings(true)).toMatchObject({ status: 'failed', error: 'Hit its $0.5 budget.', costEstimated: true })
  expect(await settings(false)).toMatchObject({ status: 'cancelled', error: 'Stopped.', costEstimated: true })
})

test('prepare registers no agent type for a check card and reads none of its context', async () => {
  const k: AgentNode = { ...node('k', 'Check', ['gone.md']), instructionsFile: '', check: { command: 'npm test', timeoutMin: 10 } }
  const g = connect(graph([node('a', 'Lead'), k]), 'a', 'k', 'handoff')
  const read: string[] = []
  const { d, registered } = deps({
    instructions: async n => { read.push(n.id); return `I am ${n.name}.` },
    context: { kind: async () => 'missing', read: async () => '', files: async () => [] },
  })
  const problems = await createLocalBackend(g, d).prepare(g)
  expect(problems).toEqual([])
  expect(registered.map(s => s.name)).toEqual(['flow--lead-a'])
  expect(read).not.toContain('k')
})

test('a reviewer\'s prompt ends with the verdict section, after its context files', async () => {
  const g = connect(connect(graph([node('a', 'Lead'), node('b', 'Judge', ['notes.md'])]), 'a', 'b', 'handoff'), 'b', 'a', 'retry')
  const { d, registered } = deps({ context: { kind: async () => 'file', read: async () => 'NOTES', files: async () => [] } })
  expect(await createLocalBackend(g, d).prepare(g)).toEqual([])
  const judge = registered.find(s => s.name.includes('judge'))!
  expect(judge.prompt.endsWith(`## Context: notes.md\n\nNOTES\n\n${VERDICT_SECTION}`)).toBe(true)
  expect(judge.prompt.split('## Verdict')).toHaveLength(2)
  expect(registered.find(s => s.name.includes('lead'))!.prompt).not.toContain('## Verdict')
  expect(judge.description).toBe('I am Judge.')
})
