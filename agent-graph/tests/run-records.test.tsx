import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import { toolName } from '../hooks/actions'
import type { AgentNode, Graph, RunIndex, RunRecord } from '../types'

const node = (id: string, name: string, x: number): AgentNode => ({
  id, name, x, y: 1, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
// Alpha -> Bravo -> Charlie, on Cloud: the mocks can answer its REST calls, which they cannot do for a local agent.
const chain = (id: string): Graph => ({
  id, name: 'Flow', description: '', backend: 'cloud', layout: 2,
  nodes: [node('a', 'Alpha', 2), node('b', 'Bravo', 40), node('c', 'Charlie', 78)],
  edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }, { id: 'e2', from: 'b', to: 'c', kind: 'handoff' }],
})
const BAND = {
  plugin: 'agent-graph', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const
const PANE = {
  plugin: 'agent-graph', component: 'Pane', requestId: 'agent-graph',
  props: { title: 'Agent Graph', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

declare const setTimeout: (run: () => void, ms?: number) => unknown

type Args = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>
type Pane = Awaited<ReturnType<typeof openPane>>

let clock: MockClock
// Instructions and record files by path (the mock file system answers Windows-style paths; the map is keyed by plain ones).
let files = new Map<string, string>()
// A path may arrive as given or resolved against the working folder: records are keyed from `.claude/agent-graph/` on.
const norm = (path: string) => {
  const plain = path.replace(/[\\]/g, '/').replace(/^[A-Za-z]:/, '')
  const at = plain.indexOf('/.claude/agent-graph/')
  return at >= 0 ? `.${plain.slice(at)}` : plain
}
const toasts: string[] = []
const submitted: string[] = []
let ends = 0

// The Managed Agents API as the mocks answer it: one session per agent that runs, ended at once unless held.
type Session = { id: string; name: string; prompt: string; isInterrupted: boolean }
let sessions: Session[] = []
let holding = new Set<string>()
let environmentFails = false
let agentsMade = 0
// Tool calls a session makes before its answer, by agent name.
let toolEvents = new Map<string, unknown[]>()
let kv = new Map<string, unknown>()

const json = (body: unknown, status = 200) => ({ status, ok: status < 300, headers: {}, text: JSON.stringify(body) })

function cloud(url: string, method: string, body: string | undefined) {
  const path = url.replace('https://api.anthropic.com', '')
  const parsed = body === undefined ? {} : JSON.parse(body)
  if (method === 'POST' && path === '/v1/environments') return environmentFails ? json({ error: { type: 'api_error', message: 'down' } }, 500) : json({ id: 'env1' })
  if (method === 'POST' && path.startsWith('/v1/agents')) return json({ id: `agent${++agentsMade}`, version: 1 })
  if (method === 'POST' && path === '/v1/sessions') {
    const session = {
      id: `s${sessions.length + 1}`,
      name: String(parsed.title).split(' / ')[1]!,
      prompt: String(parsed.initial_events[0].content[0].text),
      isInterrupted: false,
    }
    sessions.push(session)
    return json({ id: session.id })
  }
  const events = path.match(/^\/v1\/sessions\/(\w+)\/events/)
  if (events !== null) {
    const session = sessions.find(s => s.id === events[1])!
    if (method === 'POST') {
      session.isInterrupted = true
      return json({})
    }
    if (session.isInterrupted) return json({ data: [{ id: '9', type: 'session.status_idle', stop_reason: { type: 'interrupted' } }] })
    if (holding.has(session.name)) return json({ data: [] })
    return json({ data: [
      ...(toolEvents.get(session.name) ?? []),
      { id: '1', type: 'agent.message', content: [{ type: 'text', text: `${session.name.toUpperCase()}-OUT` }] },
      { id: '2', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ] })
  }
  if (path.startsWith('/v1/files')) return json({ data: [] })
  return json({ error: { type: 'not_found', message: path } }, 404)
}

async function openPane($: Args[0], on: Args[1], g: Graph, options: { failWrites?: boolean; failWritesWith?: string } = {}) {
  kv = new Map<string, unknown>([['graphs', [{ id: g.id, name: g.name }]], [`graph:${g.id}`, g]])
  on('store.get', (_$, e) => ({ value: kv.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    kv.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => ({ value: kv.delete((e as unknown as { key: string }).key) }) as never)
  clock = mock.clock(on, { now: 1_000_000 })
  files = new Map(g.nodes.map(n => [n.instructionsFile, `Instructions of ${n.name}.`] as const))
  toasts.length = 0
  submitted.length = 0
  ends = 0
  sessions = []
  holding = new Set()
  environmentFails = false
  agentsMade = 0
  toolEvents = new Map()
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as unknown as { text: string }).text))
    if (/finished|was stopped|could not start/.test(toasts[toasts.length - 1]!)) ends++
    return { value: undefined } as never
  })
  on('prompt.submit', (_$, e) => {
    submitted.push(String((e as unknown as { text: string }).text))
    ends++
    return { text: e.text }
  })
  on('fs.write', (_$, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    if (options.failWrites === true && norm(path).includes('/runs/')) throw new Error('disk full')
    if (options.failWritesWith !== undefined && norm(path).includes('/runs/') && text.includes(options.failWritesWith)) throw new Error('too large')
    files.set(norm(path), text)
    return { value: undefined } as never
  })
  on('fs.exists', (_$, e) => ({ value: files.has(norm((e as unknown as { path: string }).path)) }) as never)
  on('fs.read', (_$, e) => ({ value: files.get(norm((e as unknown as { path: string }).path)) ?? '' }) as never)
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    const target = norm(argv[argv.length - 1]!)
    files.delete(target)
    // A folder (rm -rf) takes everything in it along.
    if (argv.includes('-rf')) for (const path of [...files.keys()]) if (path.startsWith(`${target}/`)) files.delete(path)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('tool.register', () => ({ value: undefined }) as never)
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'api-key' } }) as never)
  on('http.fetch', (_$, e) => {
    const { url, init } = e as unknown as { url: string; init?: { method?: string; body?: string } }
    return { value: cloud(url, init?.method ?? 'GET', init?.body) } as never
  })
  on('env.get', () => ({ value: undefined }) as never)
  on('ui.message', () => ({ value: undefined }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'agent-graph' })
  await band.unmount()
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))

// Moves the clock until the run in flight reports its ending (a toast, or a message for a tool run).
async function untilEnded(before: number) {
  for (let i = 0; i < 300 && ends <= before; i++) {
    await clock.advance(2000)
    await tick()
  }
  expect(ends).toBeGreaterThan(before)
}

// Moves the clock until `done` holds.
async function until(done: () => boolean) {
  for (let i = 0; i < 300 && !done(); i++) {
    await clock.advance(2000)
    await tick()
  }
  expect(done()).toBe(true)
}

const recordFiles = (graphId: string) => [...files.keys()].filter(p => p.includes(`/${graphId}/runs/`) && p.endsWith('.json')).sort()
const recordsOf = (graphId: string): RunRecord[] =>
  recordFiles(graphId).map(p => JSON.parse(files.get(p)!) as RunRecord).sort((x, y) => x.startedAt - y.startedAt)

async function run(pane: Pane, task = 'Write it') {
  const before = ends
  await pane.input({ key: 'task', text: task, kind: 'change' })
  await pane.press({ key: 'run' })
  await untilEnded(before)
}

async function runFrom(pane: Pane, id: string) {
  const before = ends
  await pane.post({ events: [{ kind: 'press', node: id, action: 'run' }] })
  await untilEnded(before)
}

test('a full run writes one record and indexes it', async ($, on) => {
  const pane = await openPane($, on, chain('g-full'))
  await run(pane)
  const records = recordsOf('g-full')
  expect(records).toHaveLength(1)
  const [record] = records
  expect(record).toMatchObject({ graphId: 'g-full', graphName: 'Flow', task: 'Write it', mode: 'full', ending: 'finished' })
  expect(record!.fromNode).toBeUndefined()
  expect(record!.startedAt).toBeLessThanOrEqual(record!.endedAt)
  expect(record!.nodes['a']).toMatchObject({ status: 'done', output: 'ALPHA-OUT', inputs: [] })
  expect(record!.nodes['c']).toMatchObject({ status: 'done', output: 'CHARLIE-OUT', inputs: ['b'] })
  // A fingerprint for every agent.
  for (const id of ['a', 'b', 'c']) expect(record!.nodes[id]!.fingerprint).toMatch(/^[0-9a-f]{8}$/)
  expect(record!.result).toContain('CHARLIE-OUT')
  expect(JSON.stringify(kv.get('runs:g-full'))).toContain(record!.id)
  await pane.unmount()
})

test('a stopped run writes a record that ended stopped', async ($, on) => {
  const pane = await openPane($, on, chain('g-stop'))
  holding.add('Alpha')
  const before = ends
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  await pane.press({ key: 'run' })
  await until(() => sessions.length > 0)
  await pane.press({ key: 'stop' })
  await untilEnded(before)
  const [record, ...others] = recordsOf('g-stop')
  expect(others).toEqual([])
  expect(record).toMatchObject({ mode: 'full', ending: 'stopped' })
  expect(record!.nodes['a']!.status).toBe('cancelled')
  expect(toasts).toContain('Agent graph "Flow" was stopped')
  await pane.unmount()
})

test('a run Claude starts through a graph tool is recorded with mode tool', async ($, on) => {
  const g = chain('g-tool')
  const pane = await openPane($, on, g)
  const reply = await $.tool.call({ tool: `mcp__agent-graph__${toolName(g)}`, task: 'From Claude' } as never)
  expect(JSON.stringify(reply)).toContain('Started agent graph')
  await untilEnded(0)
  const [record] = recordsOf('g-tool')
  expect(record).toMatchObject({ mode: 'tool', task: 'From Claude', ending: 'finished' })
  expect(submitted[0]).toContain('CHARLIE-OUT')
  await pane.unmount()
})

test('a run that never starts writes nothing', async ($, on) => {
  const pane = await openPane($, on, chain('g-never'))
  environmentFails = true
  await run(pane)
  expect(toasts).toContain('Agent graph "Flow" could not start')
  expect(recordFiles('g-never')).toEqual([])
  expect(kv.get('runs:g-never')).toBeUndefined()
  await pane.unmount()
})

test('a record that cannot be written is a toast, and the run still finishes', async ($, on) => {
  const pane = await openPane($, on, chain('g-fail'), { failWrites: true })
  await run(pane)

  expect(toasts.some(t => t.startsWith('Could not save this run: '))).toBe(true)
  expect(toasts).toContain('Agent graph "Flow" finished')
  expect(recordFiles('g-fail')).toEqual([])
  await pane.unmount()
})

test('From here on the last agent reuses the saved output of the one before it', async ($, on) => {
  const pane = await openPane($, on, chain('g-from'))
  await run(pane)
  const [first] = recordsOf('g-from')
  sessions = []
  await runFrom(pane, 'c')
  // The plan is information, not an error: it draws dim.
  const plan = await pane.find({ type: 'Text', text: /Reuses Bravo · runs Charlie/ })
  expect(plan?.props).toMatchObject({ dimColor: true })
  expect(plan?.props.color).toBeUndefined()
  // Bravo did not run; Charlie got Bravo's saved output.
  expect(sessions.map(s => s.name)).toEqual(['Charlie'])
  expect(sessions[0]!.prompt).toContain('## Handoff from Bravo')
  expect(sessions[0]!.prompt).toContain('BRAVO-OUT')
  const [, second] = recordsOf('g-from')
  expect(second).toMatchObject({ mode: 'from-here', fromNode: 'c', task: 'Write it', ending: 'finished' })
  expect(second!.nodes['b']).toMatchObject({ status: 'done', output: 'BRAVO-OUT', reusedFrom: { runId: first!.id } })
  expect(second!.nodes['c']).toMatchObject({ status: 'done', output: 'CHARLIE-OUT' })
  expect(second!.nodes['a']).toBeUndefined()
  // Every agent in the run has a fingerprint, the reused one included, and it is the one from the full graph.
  expect(second!.nodes['b']!.fingerprint).toBe(first!.nodes['b']!.fingerprint)
  expect(second!.nodes['c']!.fingerprint).toBe(first!.nodes['c']!.fingerprint)
  await pane.unmount()
})

test('after editing an agent, From here also runs it and what depends on it', async ($, on) => {
  const pane = await openPane($, on, chain('g-edit'))
  await run(pane)
  files.set('/tmp/b.md', 'Instructions of Bravo, rewritten.')
  sessions = []
  await runFrom(pane, 'c')
  expect(await pane.find({ text: /Reuses Alpha · runs Bravo, Charlie/ })).toBeDefined()
  expect(sessions.map(s => s.name)).toEqual(['Bravo', 'Charlie'])
  expect(sessions[0]!.prompt).toContain('ALPHA-OUT')
  const [first, second] = recordsOf('g-edit')
  expect(second!.nodes['a']).toMatchObject({ reusedFrom: { runId: first!.id } })
  expect(second!.nodes['b']!.fingerprint).not.toBe(first!.nodes['b']!.fingerprint)
  await pane.unmount()
})

test('a different task makes every saved output out of date', async ($, on) => {
  const pane = await openPane($, on, chain('g-task'))
  await run(pane)
  sessions = []
  await pane.input({ key: 'task', text: 'Something else', kind: 'change' })
  await runFrom(pane, 'c')
  expect(await pane.find({ text: /^Runs Alpha, Bravo, Charlie$/ })).toBeDefined()
  expect(sessions.map(s => s.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  await pane.unmount()
})

test('an unreadable record file makes that agent run instead of being reused', async ($, on) => {
  const pane = await openPane($, on, chain('g-bad'))
  await run(pane)
  // A second run that reuses Bravo and runs Charlie: Bravo's newest entry now lives in it, Alpha's still in the first.
  files.set('/tmp/c.md', 'Instructions of Charlie, rewritten.')
  await runFrom(pane, 'c')
  const [first, second] = recordsOf('g-bad')
  expect(recordFiles('g-bad')).toHaveLength(2)
  files.set(recordFiles('g-bad').find(p => p.includes(second!.id))!, '{ not json')
  sessions = []
  await runFrom(pane, 'c')
  // Bravo's entry cannot be read, so Bravo runs again; Alpha's still can, from the first run.
  expect(await pane.find({ text: /Reuses Alpha · runs Bravo, Charlie/ })).toBeDefined()
  expect(sessions.map(s => s.name)).toEqual(['Bravo', 'Charlie'])
  const third = JSON.parse(files.get(recordFiles('g-bad').find(p => !p.includes(first!.id) && !p.includes(second!.id))!)!) as RunRecord
  expect(third.nodes['a']).toMatchObject({ status: 'done', output: 'ALPHA-OUT', reusedFrom: { runId: first!.id } })
  await pane.unmount()
})

test('deleting the graph removes its records and the index', async ($, on) => {
  const pane = await openPane($, on, chain('g-del'))
  await run(pane)
  await run(pane, 'Again')
  expect(recordFiles('g-del')).toHaveLength(2)
  await pane.press({ key: 'delete-graph' })
  expect(recordFiles('g-del')).toEqual([])
  expect(kv.get('runs:g-del')).toBeUndefined()
  await pane.unmount()
})

test('after a run, editing an agent marks it and what follows; a new task marks every card', async ($, on) => {
  const pane = await openPane($, on, chain('g-stale'))
  await run(pane)
  // Up to date: no marks, and the finished statuses show.
  expect(await pane.find({ in: 'canvas', text: /stale ·/ })).toBeUndefined()
  // Bravo's setup changes: it and Charlie, which follows it, are out of date; Alpha is not.
  await pane.post({ events: [{ kind: 'down', x: 45, y: 2 }] })
  await pane.select({ key: 'add-tool-b', value: 'Read' })
  const count = async (line: string) => (await pane.findAll({ in: 'canvas', type: 'Text', text: new RegExp(`stale · ${line}`) })).length
  expect([await count('setup changed'), await count('input changed'), await count('task changed')]).toEqual([1, 1, 0])
  expect((await pane.find({ in: 'canvas', key: 'card-b' }))?.props).toMatchObject({ borderColor: '#d97757' })
  expect((await pane.find({ in: 'canvas', key: 'card-a' }))?.props.borderColor).toBe('#5aa469')
  // A different task: every card is out of date for that reason first.
  await pane.input({ key: 'task', text: 'Something else', kind: 'change' })
  expect([await count('setup changed'), await count('input changed'), await count('task changed')]).toEqual([0, 0, 3])
  await pane.unmount()
})

test('a card whose output was reused shows ✓, a dim border and when it was made', async ($, on) => {
  const pane = await openPane($, on, chain('g-reuse'))
  await run(pane)
  await runFrom(pane, 'c')
  const [first] = recordsOf('g-reuse')
  const time = new Date(first!.endedAt)
  const label = `reused · ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  expect(await pane.find({ in: 'canvas', text: label })).toBeDefined()
  // The name keeps full strength; the border is what dims.
  expect((await pane.find({ in: 'canvas', type: 'Text', text: /✓ Bravo/ }))?.props.dimColor).toBeFalsy()
  expect((await pane.find({ in: 'canvas', key: 'card-b' }))?.props).toMatchObject({ borderDimColor: true })
  await pane.unmount()
})

// Stale marks on the canvas, by wording.
const marks = async (pane: Pane, line: string) => (await pane.findAll({ in: 'canvas', type: 'Text', text: new RegExp(`stale · ${line}`) })).length
const allMarks = async (pane: Pane) => (await pane.findAll({ in: 'canvas', type: 'Text', text: /stale ·/ })).length

test('instructions rewritten outside the pane mark the card at the next click; From here clears the marks', async ($, on) => {
  const pane = await openPane($, on, chain('g-outside'))
  await run(pane)
  // The external editor rewrites Bravo's file; a click on the empty canvas reads it again.
  files.set('/tmp/b.md', 'Instructions of Bravo, rewritten outside.')
  await pane.post({ events: [{ kind: 'down', x: 30, y: 20 }] })
  expect([await marks(pane, 'setup changed'), await marks(pane, 'input changed')]).toEqual([1, 1])
  await runFrom(pane, 'c')
  expect(sessions.slice(-2).map(s => s.name)).toEqual(['Bravo', 'Charlie'])
  expect(await allMarks(pane)).toBe(0)
  await pane.unmount()
})

test('Back to latest shows the newest run as the current one: no banner, and edits mark the cards', async ($, on) => {
  const pane = await openPane($, on, chain('g-back'))
  await run(pane)
  await run(pane)
  const [, older] = (kv.get('runs:g-back') as RunIndex).runs
  await pane.press({ key: `run-${older!.id}` })
  expect(await pane.find({ text: /Viewing the run from/ })).toBeDefined()
  await pane.press({ key: 'back-to-latest' })
  expect(await pane.find({ text: /Viewing the run from/ })).toBeUndefined()
  await pane.post({ events: [{ kind: 'down', x: 45, y: 2 }] })
  await pane.select({ key: 'add-tool-b', value: 'Read' })
  expect([await marks(pane, 'setup changed'), await marks(pane, 'input changed')]).toEqual([1, 1])
  await pane.unmount()
})

// Alpha -> Bravo -> Charlie, and Bravo -> Delta below Charlie.
const forked = (id: string): Graph => ({
  ...chain(id),
  nodes: [...chain(id).nodes, { ...node('d', 'Delta', 78), y: 12 }],
  edges: [...chain(id).edges, { id: 'e3', from: 'b', to: 'd', kind: 'handoff' }],
})

test('after From here runs a shared agent again, the other branch below it stays marked', async ($, on) => {
  const pane = await openPane($, on, forked('g-fork'))
  await run(pane)
  await pane.post({ events: [{ kind: 'down', x: 45, y: 2 }] })
  await pane.select({ key: 'add-tool-b', value: 'Read' })
  expect([await marks(pane, 'setup changed'), await marks(pane, 'input changed')]).toEqual([1, 2])
  await runFrom(pane, 'c')
  // Bravo and Charlie are up to date; Delta was made from Bravo's old output.
  expect([await marks(pane, 'setup changed'), await marks(pane, 'input changed')]).toEqual([0, 1])
  expect((await pane.find({ in: 'canvas', key: 'card-d' }))?.props).toMatchObject({ borderColor: '#d97757' })
  expect((await pane.find({ in: 'canvas', key: 'card-c' }))?.props.borderColor).toBe('#5aa469')
  await pane.unmount()
})

const bashCall = (result: string) => [
  { id: 't1', type: 'agent.tool_use', name: 'bash', input: { command: 'npm test' } },
  { id: 't2', type: 'agent.tool_result', tool_use_id: 't1', content: [{ type: 'text', text: result }] },
]

test('a record whose write fails is saved again without the call details, and no run is lost', async ($, on) => {
  const pane = await openPane($, on, chain('g-slim'), { failWritesWith: 'HUGE-RESULT' })
  toolEvents.set('Alpha', bashCall('HUGE-RESULT'))
  await run(pane)
  expect(toasts.some(t => t.startsWith('Could not save this run'))).toBe(false)
  const [record, ...others] = recordsOf('g-slim')
  expect(others).toEqual([])
  expect(record!.nodes['a']).toMatchObject({ status: 'done', output: 'ALPHA-OUT', activity: [{ tool: 'Bash', summary: 'npm test', status: 'ok' }] })
  expect(record!.nodes['a']!.activity![0]!.input).toBeUndefined()
  expect(record!.nodes['a']!.activity![0]!.result).toBeUndefined()
  expect(JSON.stringify(kv.get('runs:g-slim'))).toContain(record!.id)
  await pane.unmount()
})

test('From here keeps the activity of the agents it reuses', async ($, on) => {
  const pane = await openPane($, on, chain('g-keep'))
  toolEvents.set('Bravo', bashCall('3 passed'))
  await run(pane)
  const [first] = recordsOf('g-keep')
  expect(first!.nodes['b']!.activity).toMatchObject([{ tool: 'Bash', result: '3 passed' }])
  toolEvents = new Map()
  await runFrom(pane, 'c')
  const [, second] = recordsOf('g-keep')
  expect(second!.nodes['b']).toMatchObject({ reusedFrom: { runId: first!.id }, activity: first!.nodes['b']!.activity })
  await pane.unmount()
})
