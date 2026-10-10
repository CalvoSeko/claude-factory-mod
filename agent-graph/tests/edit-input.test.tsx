import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import { toolName } from '../hooks/actions'
import type { AgentNode, Graph, RunIndex, RunRecord } from '../types'

const node = (id: string, name: string, x: number, pauseBefore = false): AgentNode => ({
  id, name, x, y: 1, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
  ...(pauseBefore ? { pauseBefore: true } : {}),
})
// Alpha -> Bravo -> Charlie on Cloud (the mocks can answer its REST calls, which they cannot do for a local agent).
const chain = (id: string, paused: string[] = []): Graph => ({
  id, name: 'Flow', description: '', backend: 'cloud', layout: 2,
  nodes: [node('a', 'Alpha', 2, paused.includes('a')), node('b', 'Bravo', 40, paused.includes('b')), node('c', 'Charlie', 78, paused.includes('c'))],
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
let files = new Map<string, string>()
// A path may arrive as given or resolved against the working folder: the mod's own files are keyed from `.claude/agent-graph/` on.
const norm = (path: string) => {
  const plain = path.replace(/[\\]/g, '/').replace(/^[A-Za-z]:/, '')
  const at = plain.indexOf('/.claude/agent-graph/')
  return at >= 0 ? `.${plain.slice(at)}` : plain
}
const inputPath = (graphId: string, nodeId: string) => `./.claude/agent-graph/${graphId}/inputs/${nodeId}.md`
let failInputWrites = false
let failEnvironment = false
const toasts: string[] = []
const submitted: string[] = []
const opened: string[][] = []
let ends = 0

type Session = { id: string; name: string; prompt: string; isInterrupted: boolean }
let sessions: Session[] = []
let agentsMade = 0
let kv = new Map<string, unknown>()

const json = (body: unknown, status = 200) => ({ status, ok: status < 300, headers: {}, text: JSON.stringify(body) })

function cloud(url: string, method: string, body: string | undefined) {
  const path = url.replace('https://api.anthropic.com', '')
  const parsed = body === undefined ? {} : JSON.parse(body)
  if (method === 'POST' && path === '/v1/environments') return failEnvironment ? json({ error: { type: 'api_error', message: 'down' } }, 500) : json({ id: 'env1' })
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
    return json({ data: [
      { id: '1', type: 'agent.message', content: [{ type: 'text', text: `${session.name.toUpperCase()}-OUT` }] },
      { id: '2', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ] })
  }
  if (path.startsWith('/v1/files')) return json({ data: [] })
  return json({ error: { type: 'not_found', message: path } }, 404)
}

async function openPane($: Args[0], on: Args[1], g: Graph) {
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
  failInputWrites = false
  failEnvironment = false
  toasts.length = 0
  submitted.length = 0
  opened.length = 0
  ends = 0
  sessions = []
  agentsMade = 0
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
    if (failInputWrites && norm(path).includes('/inputs/')) throw new Error('disk full')
    files.set(norm(path), text)
    return { value: undefined } as never
  })
  on('fs.exists', (_$, e) => ({ value: files.has(norm((e as unknown as { path: string }).path)) }) as never)
  on('fs.read', (_$, e) => ({ value: files.get(norm((e as unknown as { path: string }).path)) ?? '' }) as never)
  on('process.run', (_$, e) => {
    opened.push((e as unknown as { argv: string[] }).argv)
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

async function untilEnded(before: number) {
  for (let i = 0; i < 300 && ends <= before; i++) {
    await clock.advance(2000)
    await tick()
  }
  expect(ends).toBeGreaterThan(before)
}

// Moves the clock until `done` holds.
async function until(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300 && !(await done()); i++) {
    await clock.advance(2000)
    await tick()
  }
  expect(await done()).toBe(true)
}

const recordsOf = (graphId: string): RunRecord[] =>
  [...files.keys()].filter(p => p.includes(`/${graphId}/runs/`) && p.endsWith('.json')).map(p => JSON.parse(files.get(p)!) as RunRecord).sort((x, y) => x.startedAt - y.startedAt)

const isPausedBefore = async (pane: Pane, name: string) => (await pane.find({ type: 'Text', text: `Paused before ${name}` })) !== undefined
const cardLine = async (pane: Pane, text: string | RegExp) => (await pane.find({ in: 'canvas', type: 'Text', text })) !== undefined

async function startRunning(pane: Pane, key = 'run', task = 'Write it') {
  await pane.input({ key: 'task', text: task, kind: 'change' })
  await pane.press({ key })
}

const noticeIs = async (pane: Pane, text: string | RegExp) => (await pane.find({ type: 'Text', text })) !== undefined
const selectNode = (pane: Pane, x: number) => pane.post({ events: [{ kind: 'down', x, y: 2 }] })
const B = 45

// A tool run never pauses: it leaves a record of every agent without any Continue.
async function runByTool($: Args[0], g: Graph, task = 'Write it') {
  const before = ends
  await $.tool.call({ tool: `mcp__agent-graph__${toolName(g)}`, task } as never)
  await untilEnded(before)
}

test('Edit input writes what the agent last got; Run from here with this input uses the edited text', async ($, on) => {
  const g = chain('g-edit')
  const pane = await openPane($, on, g)
  await runByTool($, g)
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  await selectNode(pane, B)
  expect(await pane.find({ key: 'run-with-input' })).toBeUndefined()
  expect((await pane.find({ key: 'last-input-edit' }))?.props.label).toBe('Edit input ↗')
  await pane.press({ key: 'last-input-edit' })
  expect(files.get(inputPath('g-edit', 'b'))).toBe('Write it\n\n## Handoff from Alpha\n\nALPHA-OUT')
  expect(opened.some(argv => argv.some(a => a.replace(/[\\]/g, '/').endsWith('/g-edit/inputs/b.md')))).toBe(true)
  expect((await pane.find({ key: 'run-with-input' }))?.props.label).toBe('Run from here with this input')

  files.set(inputPath('g-edit', 'b'), 'MY INPUT FOR BRAVO')
  sessions = []
  const before = ends
  await pane.press({ key: 'run-with-input' })
  expect(await noticeIs(pane, 'Uses your input for Bravo · reuses Alpha · runs Bravo, Charlie')).toBe(true)
  await untilEnded(before)
  // Alpha was not started; Bravo got the file's text; Charlie got Bravo's new output.
  expect(sessions.map(s => s.name)).toEqual(['Bravo', 'Charlie'])
  expect(sessions[0]!.prompt).toBe('MY INPUT FOR BRAVO')
  expect(sessions[1]!.prompt).toContain('BRAVO-OUT')
  const records = recordsOf('g-edit')
  expect(records).toHaveLength(2)
  expect(records[1]).toMatchObject({ mode: 'from-here', fromNode: 'b' })
  expect(records[1]!.nodes['b']).toMatchObject({ status: 'done', inputEdited: true, prompt: 'MY INPUT FOR BRAVO' })
  expect(records[1]!.nodes['a']).toMatchObject({ reusedFrom: { runId: records[0]!.id } })
  expect(records[1]!.nodes['c']!.inputEdited).toBeUndefined()
  // The button goes once the run started, and Last run says the input was edited.
  expect(await pane.find({ key: 'run-with-input' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^Last run · done · .*· input edited by you$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Input (edited):' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'MY INPUT FOR BRAVO' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'From Alpha:' })).toBeUndefined()
  // Edit input again starts from the stored prompt.
  files.set(inputPath('g-edit', 'b'), 'something else')
  await pane.press({ key: 'last-input-edit' })
  expect(files.get(inputPath('g-edit', 'b'))).toBe('MY INPUT FOR BRAVO')
  await pane.unmount()
})

test('the edited agent never pauses; the others follow their pause marks', async ($, on) => {
  const g = chain('g-pauses', ['b', 'c'])
  const pane = await openPane($, on, g)
  await runByTool($, g)
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  await selectNode(pane, B)
  await pane.press({ key: 'last-input-edit' })
  files.set(inputPath('g-pauses', 'b'), 'EDITED B')
  sessions = []
  const before = ends
  await pane.press({ key: 'run-with-input' })
  await until(() => isPausedBefore(pane, 'Charlie'))
  expect(sessions.map(s => s.name)).toEqual(['Bravo'])
  expect(sessions[0]!.prompt).toBe('EDITED B')
  expect(await isPausedBefore(pane, 'Bravo')).toBe(false)
  await pane.press({ key: 'continue' })
  await untilEnded(before)
  expect(sessions.map(s => s.name)).toEqual(['Bravo', 'Charlie'])
  await pane.unmount()
})

test('a predecessor with no saved entry is left out of the run', async ($, on) => {
  const base = chain('g-noentry')
  const g = { ...base, nodes: base.nodes.map(n => (n.id === 'a' ? { ...n, disabled: true } : n)) }
  const pane = await openPane($, on, g)
  const before0 = ends
  await startRunning(pane)
  await untilEnded(before0)
  expect(sessions.map(s => s.name)).toEqual(['Bravo', 'Charlie'])
  await selectNode(pane, B)
  await pane.press({ key: 'last-input-edit' })
  expect(files.get(inputPath('g-noentry', 'b'))).toBe('Write it')
  // Alpha comes back, but it has never run.
  await selectNode(pane, 5)
  await pane.press({ key: 'disable-a' })
  await selectNode(pane, B)
  files.set(inputPath('g-noentry', 'b'), 'JUST THIS')
  sessions = []
  const before = ends
  await pane.press({ key: 'run-with-input' })
  expect(await noticeIs(pane, 'Uses your input for Bravo · runs Bravo, Charlie')).toBe(true)
  await untilEnded(before)
  expect(sessions.map(s => s.name)).toEqual(['Bravo', 'Charlie'])
  expect(sessions[0]!.prompt).toBe('JUST THIS')
  expect(recordsOf('g-noentry')[1]!.nodes['a']).toBeUndefined()
  await pane.unmount()
})

test('a run with the input that fails in setup keeps the input ready to try again', async ($, on) => {
  const g = chain('g-setup-fail')
  const pane = await openPane($, on, g)
  await runByTool($, g)
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  await selectNode(pane, B)
  await pane.press({ key: 'last-input-edit' })
  files.set(inputPath('g-setup-fail', 'b'), 'MY INPUT')
  // The cloud environment cannot be made: the run ends before any agent starts, so no record is made.
  kv.delete('cloud:environment')
  failEnvironment = true
  sessions = []
  const before = ends
  await pane.press({ key: 'run-with-input' })
  await untilEnded(before)
  expect(sessions).toEqual([])
  expect(recordsOf('g-setup-fail')).toHaveLength(1)
  expect((await pane.find({ key: 'run-with-input' }))?.props.label).toBe('Run from here with this input')
  // Once the setup works, the same input runs.
  failEnvironment = false
  const again = ends
  await pane.press({ key: 'run-with-input' })
  await untilEnded(again)
  expect(sessions[0]!.prompt).toBe('MY INPUT')
  await pane.unmount()
})

test('an empty or unreadable input file starts nothing', async ($, on) => {
  const g = chain('g-empty')
  const pane = await openPane($, on, g)
  await runByTool($, g)
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  await selectNode(pane, B)
  await pane.press({ key: 'last-input-edit' })
  sessions = []
  files.set(inputPath('g-empty', 'b'), ' \n\n')
  await pane.press({ key: 'run-with-input' })
  expect(await noticeIs(pane, 'The edited input is empty.')).toBe(true)
  files.delete(inputPath('g-empty', 'b'))
  await pane.press({ key: 'run-with-input' })
  expect(await noticeIs(pane, 'Could not read the edited input.')).toBe(true)
  await clock.advance(16)
  await tick()
  expect(sessions).toEqual([])
  expect(recordsOf('g-empty')).toHaveLength(1)
  // Still ready: a fixed file runs.
  files.set(inputPath('g-empty', 'b'), 'FIXED')
  const before = ends
  await pane.press({ key: 'run-with-input' })
  await untilEnded(before)
  expect(sessions[0]!.prompt).toBe('FIXED')
  await pane.unmount()
})

test('a stale predecessor reused by Run from here with this input stays stale', async ($, on) => {
  const g = chain('g-stale-pred')
  const pane = await openPane($, on, g)
  await runByTool($, g)
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  const marks = async (line: string) => (await pane.findAll({ in: 'canvas', type: 'Text', text: new RegExp(`stale · ${line}`) })).length
  // Alpha's setup changes after the run: Alpha is stale, Bravo and Charlie were fed by it.
  await selectNode(pane, 5)
  await pane.select({ key: 'add-tool-a', value: 'Read' })
  expect([await marks('setup changed'), await marks('input changed')]).toEqual([1, 2])
  await selectNode(pane, B)
  await pane.press({ key: 'last-input-edit' })
  files.set(inputPath('g-stale-pred', 'b'), 'MY INPUT FOR BRAVO')
  sessions = []
  const before = ends
  await pane.press({ key: 'run-with-input' })
  await untilEnded(before)
  expect(sessions.map(s => s.name)).toEqual(['Bravo', 'Charlie'])
  // Alpha's saved output still comes from its old setup: it stays stale, and what it fed is marked too.
  const [first] = recordsOf('g-stale-pred')
  const latest = (kv.get('runs:g-stale-pred') as RunIndex).latest
  expect(latest['a']).toMatchObject({ fingerprint: first!.nodes['a']!.fingerprint, task: first!.task, producedAt: first!.endedAt })
  expect([await marks('setup changed'), await marks('input changed')]).toEqual([1, 2])
  await pane.unmount()
})

test('a pause that writes the input file takes the Run with this input offer away', async ($, on) => {
  const g = chain('g-gate-takes', ['b'])
  const pane = await openPane($, on, g)
  await runByTool($, g)
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  await selectNode(pane, B)
  await pane.press({ key: 'last-input-edit' })
  expect(await pane.find({ key: 'run-with-input' })).toBeDefined()
  // A new run pauses before Bravo and writes what Bravo is about to get over the file.
  const before = ends
  await pane.press({ key: 'run' })
  await until(() => isPausedBefore(pane, 'Bravo'))
  await pane.press({ key: 'stop' })
  await untilEnded(before)
  await selectNode(pane, B)
  expect(await pane.find({ key: 'last-input-edit' })).toBeDefined()
  expect(await pane.find({ key: 'run-with-input' })).toBeUndefined()
  await pane.unmount()
})

test('a stopped run with your input leaves the button to try again; one that ends takes it', async ($, on) => {
  const g = chain('g-ready-stop', ['c'])
  const pane = await openPane($, on, g)
  await runByTool($, g)
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  await selectNode(pane, B)
  await pane.press({ key: 'last-input-edit' })
  files.set(inputPath('g-ready-stop', 'b'), 'MY INPUT')
  const first = ends
  await pane.press({ key: 'run-with-input' })
  await until(() => isPausedBefore(pane, 'Charlie'))
  await pane.press({ key: 'stop' })
  await untilEnded(first)
  await selectNode(pane, B)
  expect((await pane.find({ key: 'run-with-input' }))?.props.label).toBe('Run from here with this input')
  // Once more, to the end.
  const second = ends
  await pane.press({ key: 'run-with-input' })
  await until(() => isPausedBefore(pane, 'Charlie'))
  await pane.press({ key: 'continue' })
  await untilEnded(second)
  await selectNode(pane, B)
  expect(await pane.find({ key: 'run-with-input' })).toBeUndefined()
  await pane.unmount()
})

test('a reused agent keeps showing the input you edited, and Edit input falls back to its own record when the origin is gone', async ($, on) => {
  const g = chain('g-reused-edit')
  const pane = await openPane($, on, g)
  await runByTool($, g)
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  await selectNode(pane, B)
  await pane.press({ key: 'last-input-edit' })
  files.set(inputPath('g-reused-edit', 'b'), 'MY INPUT FOR BRAVO')
  const first = ends
  await pane.press({ key: 'run-with-input' })
  await untilEnded(first)
  // From Charlie on, Bravo (edited above) is reused: its card still says the input was yours.
  sessions = []
  const second = ends
  await pane.post({ events: [{ kind: 'press', node: 'c', action: 'run' }] })
  expect(await noticeIs(pane, 'Reuses Bravo · runs Charlie')).toBe(true)
  await untilEnded(second)
  expect(sessions.map(s => s.name)).toEqual(['Charlie'])
  await selectNode(pane, B)
  expect(await pane.find({ type: 'Text', text: /^Last run · done · .*· reused from .*· input edited by you$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'MY INPUT FOR BRAVO' })).toBeDefined()
  // Alpha was reused from the first run; once that record is gone Edit input still opens its own entry.
  const [firstRecord] = recordsOf('g-reused-edit')
  files.delete(`./.claude/agent-graph/g-reused-edit/runs/${firstRecord!.id}.json`)
  await selectNode(pane, 5)
  await pane.press({ key: 'last-input-edit' })
  expect(files.get(inputPath('g-reused-edit', 'a'))).toBe('Write it')
  await pane.unmount()
})

test('a gate that could not write the input file leaves the edited input and its offer alone', async ($, on) => {
  const g = chain('g-gate-nowrite', ['b'])
  const pane = await openPane($, on, g)
  await runByTool($, g)
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  await selectNode(pane, B)
  await pane.press({ key: 'last-input-edit' })
  failInputWrites = true
  const before = ends
  await pane.press({ key: 'run' })
  await until(() => isPausedBefore(pane, 'Bravo'))
  await pane.press({ key: 'stop' })
  await untilEnded(before)
  await selectNode(pane, B)
  expect(await pane.find({ key: 'run-with-input' })).toBeDefined()
  await pane.unmount()
})
