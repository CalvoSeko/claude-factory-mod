import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph } from '../types'
import type { Api, SessionEvent } from '../hooks/cloud/api'
import { createTracker } from '../hooks/activity'
import { createCloudBackend, type CloudDeps } from '../hooks/cloud/backend'
import { handoffDir } from '../hooks/model'
import { runGraph } from '../hooks/runner'

declare const setTimeout: (run: () => void, ms?: number) => unknown

const node = (over: Partial<AgentNode> = {}): AgentNode => ({
  id: 'a', name: 'Lead', x: 0, y: 0, instructionsFile: 'a.md', skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 3,
  cloud: { agentId: 'agent_1', version: 4, hash: 'h' }, ...over,
})
const graph = (n = node()): Graph => ({ id: 'g', name: 'Flow', description: '', backend: 'cloud', nodes: [n], edges: [] })

// A script entry that is an Error makes that poll throw. failing.threads: per thread id, what each read of
// its events returns (the last entry stays).
function harness(script: Array<SessionEvent[] | Error>, over: Partial<CloudDeps> = {}, failing: { sends?: number; files?: boolean; listings?: Array<Array<{ id: string; filename: string }>>; threads?: Record<string, Array<SessionEvent[] | Error>> } = {}) {
  const sessions: Array<Record<string, unknown>> = []
  const sent: unknown[] = []
  const uploads: string[] = []
  const waits: number[] = []
  let sendFailures = failing.sends ?? 0
  let listings = 0
  const threadReads: string[] = []
  const api = {
    createEnvironment: async () => ({ id: 'env_1' }),
    createSession: async (body: Record<string, unknown>) => { sessions.push(body); return { id: 'sesn_1' } },
    listEvents: async () => {
      const next = script.shift()
      if (next instanceof Error) throw next
      return next ?? []
    },
    listThreadEvents: async (_id: string, threadId: string) => {
      threadReads.push(threadId)
      const queue = failing.threads?.[threadId] ?? []
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next instanceof Error) throw next
      return next ?? []
    },
    sendEvents: async (_id: string, events: unknown[]) => {
      if (sendFailures > 0) { sendFailures--; throw new Error('429 Too Many Requests') }
      sent.push(...events)
    },
    listSessionFiles: async () => {
      listings++
      if (failing.files === true) throw new Error('500 files')
      if (failing.listings !== undefined) return failing.listings.shift() ?? []
      return [{ id: 'file_out', filename: 'report.md' }]
    },
    uploadFile: async (name: string) => { uploads.push(name); return { id: `file_${name}` } },
    createAgent: async () => ({ id: 'agent_1', version: 4 }),
    updateAgent: async () => ({ id: 'agent_1', version: 4 }),
    createSkill: async () => ({ id: 'skill_1' }),
    createSkillVersion: async () => undefined,
  } as unknown as Api
  const kv = new Map<string, unknown>([['cloud:environment', 'env_1']])
  const deps: CloudDeps = {
    api,
    store: { get: async k => kv.get(k), set: async (k, v) => void kv.set(k, v), delete: async k => void kv.delete(k) },
    instructions: async () => 'I lead.',
    skillFiles: async () => ({ error: 'none' }),
    hash: async text => `h${text.length}`,
    context: { kind: async p => (p === 'spec.md' ? 'file' : 'missing'), read: async () => 'SPEC', files: async () => [] },
    wait: async ms => void waits.push(ms),
    workspaceId: 'default',
    onGraph: async () => {},
    ...over,
  }
  return { deps, sessions, sent, uploads, waits, threadReads, listings: () => listings }
}

const idle = (id: string, type: string): SessionEvent => ({ id, type: 'session.status_idle', stop_reason: { type } })
const said = (id: string, text: string): SessionEvent => ({ id, type: 'agent.message', content: [{ type: 'text', text }] })

test('a node runs as a budgeted session and finishes on end_turn with its last message and files', async () => {
  const h = harness([[said('1', 'thinking out loud')], [said('1', 'thinking out loud'), said('2', 'Final answer'), idle('3', 'end_turn')]])
  const g = graph(node({ contextFiles: ['spec.md'] }))
  const backend = createCloudBackend(g, h.deps)
  expect(await backend.prepare(g)).toEqual([])
  const handoff = [{ from: 'z', text: 'x', files: [{ id: 'file_up', name: 'notes.md', fromNode: 'z' }] }]
  const run = await backend.start(g.nodes[0]!, 'Do it', handoff, () => {})
  expect(run.link).toBe('https://platform.claude.com/workspaces/default/sessions/sesn_1')
  expect(await run.done).toEqual({ ok: true, text: 'Final answer', files: [{ id: 'file_out', name: 'report.md', fromNode: 'a' }] })
  const body = h.sessions[0]!
  expect(body['agent']).toEqual({ type: 'agent', id: 'agent_1', version: 4 })
  expect(body['environment_id']).toBe('env_1')
  expect(body['budget']).toEqual({ type: 'limit', max_list_cost: { amount: '300', currency: 'USD' } })
  expect(body['resources']).toEqual([
    { type: 'file', file_id: 'file_spec.md', mount_path: '/workspace/context/spec.md' },
    { type: 'file', file_id: 'file_up', mount_path: '/workspace/handoff/z-z/notes.md' },
  ])
  expect(body['initial_events']).toEqual([{ type: 'user.message', content: [{ type: 'text', text: 'Do it' }] }])
  expect(h.uploads).toEqual(['spec.md'])
})

test('budget, errors and approvals fail the node with a reason', async () => {
  for (const [events, reason] of [
    [[idle('1', 'budget_reached')], 'Hit its $3 budget.'],
    [[{ id: '1', type: 'session.error', error: { message: 'boom' } }], 'Session error: boom'],
    [[idle('1', 'requires_action')], 'Waiting for a tool approval; open its Console link to answer it.'],
  ] as const) {
    const h = harness([[...events]])
    const run = await createCloudBackend(graph(), h.deps).start(node(), 'x', [], () => {})
    expect(await run.done).toEqual({ ok: false, reason })
  }
})

test('cost comes from session.usage and stop sends an interrupt', async () => {
  const costs: number[] = []
  const h = harness([[{ id: 'u', type: 'session.usage', list_cost: { amount: '125', currency: 'USD' } }], [idle('2', 'end_turn')]])
  const run = await createCloudBackend(graph(), h.deps).start(node(), 'x', [], usd => void costs.push(usd))
  await run.stop()
  expect(h.sent).toEqual([{ type: 'user.interrupt' }])
  expect(await run.done).toEqual({ ok: false, reason: 'Stopped.' })
  expect(costs).toEqual([1.25])
})

test('a poll that throws twice then succeeds still finishes ok', async () => {
  const h = harness([new Error('503'), new Error('blip'), [said('1', 'Answer'), idle('2', 'end_turn')]])
  const run = await createCloudBackend(graph(), h.deps).start(node(), 'x', [], () => {})
  expect(await run.done).toEqual({ ok: true, text: 'Answer', files: [{ id: 'file_out', name: 'report.md', fromNode: 'a' }] })
  expect(h.sent).toEqual([])
})

test('a poll that always throws ends failed after backing off and asks the session to stop', async () => {
  const h = harness(Array.from({ length: 10 }, () => new Error('502 Bad Gateway')))
  const run = await createCloudBackend(graph(), h.deps).start(node(), 'x', [], () => {})
  expect(await run.done).toEqual({ ok: false, reason: 'Lost contact with the cloud session (502 Bad Gateway); it was asked to stop.' })
  expect(h.waits).toEqual([2000, 2000, 4000, 8000, 16000])
  expect(h.sent).toEqual([{ type: 'user.interrupt' }])
})

test('a stop whose first interrupt throws retries and does not reject', async () => {
  const h = harness([[idle('1', 'end_turn')]], {}, { sends: 1 })
  const run = await createCloudBackend(graph(), h.deps).start(node(), 'x', [], () => {})
  await run.stop()
  expect(h.sent).toEqual([{ type: 'user.interrupt' }])
  expect(await run.done).toEqual({ ok: false, reason: 'Stopped.' })
  const dead = harness([[idle('1', 'end_turn')]], {}, { sends: 5 })
  const deadRun = await createCloudBackend(graph(), dead.deps).start(node(), 'x', [], () => {})
  await deadRun.stop()
  expect(dead.sent).toEqual([])
})

test('a failed output listing after end_turn still succeeds, without files', async () => {
  const h = harness([[said('1', 'Done'), idle('2', 'end_turn')]], {}, { files: true })
  const run = await createCloudBackend(graph(), h.deps).start(node(), 'x', [], () => {})
  expect(await run.done).toEqual({ ok: true, text: 'Done', files: [] })
})

test('a reused predecessor\'s files mount in the folder the prompt names', async () => {
  const h = harness([[said('1', 'Done'), idle('2', 'end_turn')]])
  const g: Graph = {
    ...graph(),
    nodes: [node({ id: 'alpha1', name: 'Alpha' }), node({ id: 'bravo1', name: 'Bravo', instructionsFile: 'b.md' })],
    edges: [{ id: 'e1', from: 'alpha1', to: 'bravo1', kind: 'handoff' }],
  }
  const notes = { id: 'file_notes', name: 'notes.md', fromNode: 'alpha1' }
  // Alpha is seeded from a saved run, so the graph the backend prepares has no Alpha.
  const seed = { alpha1: { output: 'ALPHA-OUT', files: [notes], runId: 'r0', at: 1 } }
  const outcome = await runGraph(g, 'Task', createCloudBackend(g, h.deps), { onUpdate: () => {} }, seed)
  expect('problems' in outcome).toBe(false)
  expect(h.sessions).toHaveLength(1)
  const folder = `/workspace/handoff/${handoffDir('Alpha', 'alpha1')}`
  const body = h.sessions[0]!
  expect(body['resources']).toEqual([{ type: 'file', file_id: 'file_notes', mount_path: `${folder}/notes.md` }])
  expect(JSON.stringify(body['initial_events'])).toContain(`Files from Alpha are at ${folder}/: notes.md`)
})

test('an end_turn with no text fails the node, like a terminated session without an answer', async () => {
  const h = harness([[idle('1', 'end_turn')]])
  const run = await createCloudBackend(graph(), h.deps).start(node(), 'x', [], () => {})
  expect(await run.done).toEqual({ ok: false, reason: 'The session ended without an answer.' })
})

test('a terminated session keeps its last answer, or fails without one', async () => {
  const withAnswer = harness([[said('1', 'Partial but complete'), { id: '2', type: 'session.status_terminated' }]])
  const a = await createCloudBackend(graph(), withAnswer.deps).start(node(), 'x', [], () => {})
  expect(await a.done).toEqual({ ok: true, text: 'Partial but complete', files: [{ id: 'file_out', name: 'report.md', fromNode: 'a' }] })
  const without = harness([[{ id: '1', type: 'session.status_terminated' }]])
  const b = await createCloudBackend(graph(), without.deps).start(node(), 'x', [], () => {})
  expect(await b.done).toEqual({ ok: false, reason: 'The session ended without an answer.' })
})

test('an agent that was not synced, a missing context path and a binary context file fail the node without a session', async () => {
  const unsynced = harness([])
  const loose = graph(node({ cloud: undefined }))
  const a = await createCloudBackend(loose, unsynced.deps).start(loose.nodes[0]!, 'x', [], () => {})
  expect(await a.done).toEqual({ ok: false, reason: 'This agent was not synced.' })
  const missing = harness([])
  const g = graph(node({ contextFiles: ['nope.md'] }))
  const b = await createCloudBackend(g, missing.deps).start(g.nodes[0]!, 'x', [], () => {})
  expect(await b.done).toEqual({ ok: false, reason: 'Context path not found: nope.md' })
  const binary = harness([], { context: { kind: async () => 'file', read: async () => 'a\u0000b', files: async () => [] } })
  const h = graph(node({ contextFiles: ['spec.md'] }))
  const c = await createCloudBackend(h, binary.deps).start(h.nodes[0]!, 'x', [], () => {})
  expect(await c.done).toEqual({ ok: false, reason: 'Binary context files are not supported on Cloud yet: spec.md' })
  expect([unsynced, missing, binary].flatMap(x => x.sessions)).toEqual([])
})

test('a context file is uploaded once and reused by the next start', async () => {
  const finished = () => [said('1', 'Done'), idle('2', 'end_turn')]
  const h = harness([finished(), finished()])
  const g = graph(node({ contextFiles: ['spec.md'] }))
  const backend = createCloudBackend(g, h.deps)
  await (await backend.start(g.nodes[0]!, 'one', [], () => {})).done
  await (await backend.start(g.nodes[0]!, 'two', [], () => {})).done
  expect(h.uploads).toEqual(['spec.md'])
  expect(h.sessions).toHaveLength(2)
  expect(h.sessions[1]!['resources']).toEqual([{ type: 'file', file_id: 'file_spec.md', mount_path: '/workspace/context/spec.md' }])
})

test('an empty output listing is retried once, a POLL_MS later', async () => {
  const found = harness([[said('1', 'Done'), idle('2', 'end_turn')]], {}, { listings: [[], [{ id: 'file_late', filename: 'late.md' }]] })
  const a = await createCloudBackend(graph(), found.deps).start(node(), 'x', [], () => {})
  expect(await a.done).toEqual({ ok: true, text: 'Done', files: [{ id: 'file_late', name: 'late.md', fromNode: 'a' }] })
  expect(found.waits).toEqual([2000, 2000])
  const none = harness([[said('1', 'Done'), idle('2', 'end_turn')]], {}, { listings: [] })
  const b = await createCloudBackend(graph(), none.deps).start(node(), 'x', [], () => {})
  expect(await b.done).toEqual({ ok: true, text: 'Done', files: [] })
  expect(none.listings()).toBe(2)
  expect(none.waits).toEqual([2000, 2000])
})

test('a handoff file name is reduced to a plain name in its mount path', async () => {
  const h = harness([[said('1', 'Done'), idle('2', 'end_turn')]])
  const handoff = [{ from: 'z', text: 'x', files: [{ id: 'file_up', name: '../../etc/evil.md', fromNode: 'z' }] }]
  await (await createCloudBackend(graph(), h.deps).start(node(), 'x', handoff, () => {})).done
  expect(h.sessions[0]!['resources']).toEqual([{ type: 'file', file_id: 'file_up', mount_path: '/workspace/handoff/z-z/evil.md' }])
})

test('handoff names that reduce to the same name are numbered, as the prompt lists them', async () => {
  const h = harness([[said('1', 'Done'), idle('2', 'end_turn')]])
  const files = [{ id: 'f1', name: 'a/x.md', fromNode: 'z' }, { id: 'f2', name: 'b/x.md', fromNode: 'z' }]
  await (await createCloudBackend(graph(), h.deps).start(node(), 'x', [{ from: 'z', text: 'x', files }], () => {})).done
  expect(h.sessions[0]!['resources']).toEqual([
    { type: 'file', file_id: 'f1', mount_path: '/workspace/handoff/z-z/x.md' },
    { type: 'file', file_id: 'f2', mount_path: '/workspace/handoff/z-z/x-2.md' },
  ])
})

test('a stopped session whose interrupts keep failing is asked again on each poll', async () => {
  const h = harness(Array.from({ length: 50 }, () => []), { wait: () => new Promise<void>(resolve => setTimeout(resolve, 0)) }, { sends: 4 })
  const run = await createCloudBackend(graph(), h.deps).start(node(), 'x', [], () => {})
  await run.stop()
  await run.done
  expect(h.sent).toEqual([{ type: 'user.interrupt' }])
})

test('after a stop whose interrupts both fail, the poll ends as Stopped within a few polls', async () => {
  const h = harness(Array.from({ length: 50 }, () => []), { wait: () => new Promise<void>(resolve => setTimeout(resolve, 0)) }, { sends: 100 })
  const run = await createCloudBackend(graph(), h.deps).start(node(), 'x', [], () => {})
  await run.stop()
  expect(h.sent).toEqual([])
  expect(await run.done).toEqual({ ok: false, reason: 'Stopped (the session may still be running; open its Console link).' })
})

// ---- activity ----

const use = (id: string, name: string, input: unknown, type = 'agent.tool_use'): SessionEvent => ({ id, type, name, input })
const result = (id: string, of: string, text: string, isError = false, type = 'agent.tool_result'): SessionEvent => ({ id, type, tool_use_id: of, content: [{ type: 'text', text }], is_error: isError })
const sentTo = (id: string, thread: string, to = 'Flow / Helper'): SessionEvent => ({ id, type: 'agent.thread_message_sent', to_session_thread_id: thread, to_agent_name: to, content: [{ type: 'text', text: 'Please help' }] })
const received = (id: string, thread: string): SessionEvent => ({ id, type: 'agent.thread_message_received', from_session_thread_id: thread, from_agent_name: 'Flow / Helper', content: [{ type: 'text', text: 'Helped' }] })
const withHelper = (): Graph => ({
  ...graph(),
  nodes: [node(), node({ id: 'h', name: 'Helper', cloud: { agentId: 'agent_2', version: 1, hash: 'h2' } })],
  edges: [{ id: 'e', from: 'a', to: 'h', kind: 'delegate' }],
})

function tracked(script: Array<SessionEvent[] | Error>, threads: Record<string, Array<SessionEvent[] | Error>> = {}, g: Graph = graph()) {
  let t = 0
  const tracker = createTracker(() => {}, () => ++t)
  const h = harness(script, { tracker: () => tracker }, { threads })
  return { tracker, h, start: () => createCloudBackend(g, h.deps).start(g.nodes[0]!, 'x', [], () => {}) }
}

test('a cloud agent\'s tool calls are recorded: ok with a result, failed with an error, MCP tools by server', async () => {
  const run = tracked([
    [use('t1', 'bash', { command: 'npm test\nmore' }), { ...use('m1', 'search', { q: 'x' }, 'agent.mcp_tool_use'), mcp_server_name: 'github' }],
    [
      use('t1', 'bash', { command: 'npm test\nmore' }), result('r1', 't1', '3 passed'),
      { ...use('m1', 'search', { q: 'x' }, 'agent.mcp_tool_use'), mcp_server_name: 'github' }, result('r2', 'm1', 'boom', true, 'agent.mcp_tool_result'),
      use('c1', 'lookup', { id: 7 }, 'agent.custom_tool_use'),
      said('9', 'Done'), idle('10', 'end_turn'),
    ],
  ])
  expect(await (await run.start()).done).toMatchObject({ ok: true })
  const items = run.tracker.itemsOf('a')
  expect(items.map(i => [i.tool, i.status])).toEqual([['Bash', 'ok'], ['mcp__github__search', 'failed'], ['lookup', 'failed']])
  expect(items[0]).toMatchObject({ summary: 'npm test', result: '3 passed' })
  expect(items[0]!.input).toContain('npm test')
  expect(items[1]).toMatchObject({ summary: 'github/search x', error: 'boom' })
  // A call still open when the session ended is not left running.
  expect(items[2]!.error).toBeDefined()
  expect(run.tracker.isWatched('cloud:sesn_1')).toBe(false)
})

test('events seen in an earlier poll are not applied again', async () => {
  const first = [use('t1', 'read', { file_path: 'a.md' }), result('r1', 't1', 'A')]
  const second = [...first, use('t2', 'read', { file_path: 'b.md' })]
  const run = tracked([first, second, [...second, result('r2', 't2', 'B'), said('3', 'Done'), idle('4', 'end_turn')]])
  expect(await (await run.start()).done).toMatchObject({ ok: true })
  expect(run.tracker.itemsOf('a').map(i => [i.summary, i.status])).toEqual([['a.md', 'ok'], ['b.md', 'ok']])
})

test('a delegate thread opens on the message sent, nests its own calls, and closes on the message received', async () => {
  const g = withHelper()
  const threadCalls = [use('n1', 'grep', { pattern: 'TODO', path: 'src' }), result('nr1', 'n1', 'src/a.ts')]
  const main = [use('t1', 'bash', { command: 'ls' }), result('r1', 't1', 'a'), sentTo('s1', 'sthr_1')]
  const run = tracked(
    [main, main, [...main, received('s2', 'sthr_1'), said('3', 'Done'), idle('4', 'end_turn')]],
    { sthr_1: [threadCalls.slice(0, 1), [...threadCalls, use('n2', 'write', { file_path: 'out.md' }), result('nr2', 'n2', 'ok')]] },
    g,
  )
  expect(await (await run.start()).done).toMatchObject({ ok: true })
  const items = run.tracker.itemsOf('a')
  expect(items.map(i => [i.tool, i.status])).toEqual([['Bash', 'ok'], ['Helper', 'ok']])
  const delegate = items[1]!
  expect(delegate.delegate).toMatchObject({ name: 'Helper', nodeId: 'h' })
  expect(delegate.result).toBe('Helped')
  expect(delegate.delegate!.items.map(i => [i.tool, i.summary, i.status])).toEqual([['Grep', 'TODO in src', 'ok'], ['Write', 'out.md', 'ok']])
  expect(run.tracker.helpersOf('a').map(h => [h.nodeId, h.status])).toEqual([['h', 'done']])
  expect(run.h.threadReads.every(t => t === 'sthr_1')).toBe(true)
  expect(run.h.threadReads.length).toBeGreaterThanOrEqual(2)
})

test('a thread whose reply arrives in the same poll still gets its calls before it closes', async () => {
  const g = withHelper()
  const run = tracked(
    [[sentTo('s1', 'sthr_1'), received('s2', 'sthr_1'), said('3', 'Done'), idle('4', 'end_turn')]],
    { sthr_1: [[use('n1', 'bash', { command: 'make' }), result('nr1', 'n1', 'built')]] },
    g,
  )
  expect(await (await run.start()).done).toMatchObject({ ok: true })
  expect(run.tracker.itemsOf('a')[0]!.delegate!.items.map(i => [i.summary, i.status])).toEqual([['make', 'ok']])
})

test('a thread that cannot be read leaves its delegate without nested calls and does not fail the node', async () => {
  const g = withHelper()
  const run = tracked(
    [[sentTo('s1', 'sthr_1')], [sentTo('s1', 'sthr_1'), received('s2', 'sthr_1'), said('3', 'Done'), idle('4', 'end_turn')]],
    { sthr_1: [new Error('500 threads')] },
    g,
  )
  expect(await (await run.start()).done).toEqual({ ok: true, text: 'Done', files: [{ id: 'file_out', name: 'report.md', fromNode: 'a' }] })
  const delegate = run.tracker.itemsOf('a')[0]!
  expect(delegate).toMatchObject({ status: 'ok' })
  expect(delegate.delegate!.items).toEqual([])
})

test('a thread that terminates with an error closes its delegate failed', async () => {
  const g = withHelper()
  const run = tracked(
    [[sentTo('s1', 'sthr_1'), { id: 'x1', type: 'session.thread_status_terminated', session_thread_id: 'sthr_1', error: { message: 'model overloaded' } }, said('3', 'Partial'), idle('4', 'end_turn')]],
    {},
    g,
  )
  expect(await (await run.start()).done).toMatchObject({ ok: true })
  const delegate = run.tracker.itemsOf('a')[0]!
  expect(delegate).toMatchObject({ status: 'failed', error: 'model overloaded' })
  expect(run.tracker.helpersOf('a')[0]).toMatchObject({ nodeId: 'h', status: 'failed' })
})

test('a message to an agent that is not in the graph is a delegate item without a node', async () => {
  const run = tracked([[sentTo('s1', 'sthr_9', 'Stranger'), received('s2', 'sthr_9'), said('3', 'Done'), idle('4', 'end_turn')]])
  expect(await (await run.start()).done).toMatchObject({ ok: true })
  expect(run.tracker.itemsOf('a')[0]!.delegate).toMatchObject({ name: 'Stranger' })
  expect(run.tracker.itemsOf('a')[0]!.delegate!.nodeId).toBeUndefined()
})

test('activity does not change a poll: no tracker, or a tracker that throws, gives the same outcome', async () => {
  const events = [use('t1', 'bash', { command: 'ls' }), result('r1', 't1', 'a'), sentTo('s1', 'sthr_1'), said('3', 'Done'), idle('4', 'end_turn')]
  const plain = harness([events])
  const a = await (await createCloudBackend(withHelper(), plain.deps).start(node(), 'x', [], () => {})).done
  const real = createTracker(() => {}, () => 1)
  const boom = () => { throw new Error('tracker broke') }
  const h = harness([events], { tracker: () => ({ ...real, callStart: boom, callEnd: boom, childOf: boom, watch: boom, unwatch: boom }) })
  const b = await (await createCloudBackend(withHelper(), h.deps).start(node(), 'x', [], () => {})).done
  expect(b).toEqual(a)
  expect(a).toMatchObject({ ok: true })
})

test('a cloud call still open when the session ends is failed: "Stopped." after a stop, else "Not finished when the run ended."', async () => {
  const ended = tracked([[use('t1', 'bash', { command: 'sleep 9' }), said('2', 'Done'), idle('3', 'end_turn')]])
  expect(await (await ended.start()).done).toMatchObject({ ok: true })
  expect(ended.tracker.itemsOf('a')).toMatchObject([{ status: 'failed', error: 'Not finished when the run ended.' }])

  const tracker = createTracker(() => {}, () => 1)
  let stop: (() => Promise<void>) | undefined
  let polls = 0
  const h = harness([[use('t1', 'bash', { command: 'sleep 9' })], [idle('9', 'interrupted')]], {
    tracker: () => tracker,
    wait: async () => { if (++polls === 2) await stop?.() },
  })
  const g = withHelper()
  const run = await createCloudBackend(g, h.deps).start(g.nodes[0]!, 'x', [], () => {})
  stop = run.stop
  expect(await run.done).toEqual({ ok: false, reason: 'Stopped.' })
  expect(tracker.itemsOf('a')).toMatchObject([{ status: 'failed', error: 'Stopped.' }])
})

test('a stopped session ends its open delegate and the delegate\'s calls as "Stopped."; the helper is cancelled', async () => {
  const tracker = createTracker(() => {}, () => 1)
  let stop: (() => Promise<void>) | undefined
  let polls = 0
  const h = harness([[sentTo('s1', 'sthr_1')], [idle('9', 'interrupted')]], {
    tracker: () => tracker,
    wait: async () => { if (++polls === 2) await stop?.() },
  }, { threads: { sthr_1: [[use('n1', 'bash', { command: 'make' })]] } })
  const g = withHelper()
  const run = await createCloudBackend(g, h.deps).start(g.nodes[0]!, 'x', [], () => {})
  stop = run.stop
  expect(await run.done).toEqual({ ok: false, reason: 'Stopped.' })
  expect(tracker.itemsOf('a')).toMatchObject([{ status: 'failed', error: 'Stopped.', delegate: { items: [{ status: 'failed', error: 'Stopped.' }] } }])
  expect(tracker.helpersOf('a')).toMatchObject([{ nodeId: 'h', status: 'cancelled' }])
})

test('the coordinator\'s send_to_agent and list_agents calls are not rows: the delegate row stands for them', async () => {
  const g = withHelper()
  const run = tracked(
    [[
      use('l1', 'list_agents', {}), result('lr1', 'l1', '[Helper]'),
      use('x1', 'send_to_agent', { agent: 'Helper', message: 'go' }), result('xr1', 'x1', 'sent'),
      sentTo('s1', 'sthr_1'), received('s2', 'sthr_1'), said('3', 'Done'), idle('4', 'end_turn'),
    ]],
    {},
    g,
  )
  expect(await (await run.start()).done).toMatchObject({ ok: true })
  expect(run.tracker.itemsOf('a').map(i => [i.tool, i.status])).toEqual([['Helper', 'ok']])
})
