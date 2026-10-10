import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import { toolName } from '../hooks/actions'
import type { AgentNode, Graph, RunRecord } from '../types'

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
  if (method === 'POST' && path === '/v1/environments') return json({ id: 'env1' })
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

async function openPane($: Args[0], on: Args[1], g: Graph, others: Graph[] = []) {
  const all = [g, ...others]
  kv = new Map<string, unknown>([['graphs', all.map(x => ({ id: x.id, name: x.name }))], ...all.map(x => [`graph:${x.id}`, x] as [string, unknown])])
  on('store.get', (_$, e) => ({ value: kv.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    kv.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => ({ value: kv.delete((e as unknown as { key: string }).key) }) as never)
  clock = mock.clock(on, { now: 1_000_000 })
  files = new Map(all.flatMap(x => x.nodes).map(n => [n.instructionsFile, `Instructions of ${n.name}.`] as const))
  failInputWrites = false
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
  // A Local graph registers its agents before the first one starts (no test here starts a local agent).
  on('agent.register', () => ({ value: undefined }) as never)
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

test('the toggle saves pauseBefore and the card shows ‖', async ($, on) => {
  const pane = await openPane($, on, chain('g-toggle'))
  await pane.post({ events: [{ kind: 'down', x: 45, y: 2 }] })
  expect(JSON.stringify((await pane.find({ key: 'pause-b' }))?.props)).toContain('Pause before this agent: off')
  expect(await pane.find({ in: 'canvas', type: 'Text', text: /^‖$/ })).toBeUndefined()
  await pane.press({ key: 'pause-b' })
  expect(JSON.stringify((await pane.find({ key: 'pause-b' }))?.props)).toContain('Pause before this agent: on')
  expect((kv.get('graph:g-toggle') as Graph).nodes.find(n => n.id === 'b')).toMatchObject({ pauseBefore: true })
  expect(await pane.findAll({ in: 'canvas', type: 'Text', text: /^‖$/ })).toHaveLength(1)
  await pane.press({ key: 'pause-b' })
  expect(await pane.find({ in: 'canvas', type: 'Text', text: /^‖$/ })).toBeUndefined()
  await pane.unmount()
})

test('a pane run pauses before the marked agent; Continue starts it with the edited input', async ($, on) => {
  const pane = await openPane($, on, chain('g-pause', ['b']))
  const before = ends
  await startRunning(pane)
  await until(() => isPausedBefore(pane, 'Bravo'))
  // Alpha ran; Bravo did not start; the card says so; the input file holds what Bravo is about to get.
  expect(sessions.map(s => s.name)).toEqual(['Alpha'])
  expect(await cardLine(pane, 'paused · your turn')).toBe(true)
  expect(JSON.stringify((await pane.find({ key: 'canvas' }))?.props)).toContain('paused · your turn')
  expect(files.get(inputPath('g-pause', 'b'))).toContain('ALPHA-OUT')
  expect(await pane.find({ type: 'Text', text: /ALPHA-OUT/ })).toBeDefined()
  // No Step mode: no Continue all, and the toolbar has no Step while running.
  expect(await pane.find({ key: 'continue-all' })).toBeUndefined()
  expect(await pane.find({ key: 'step' })).toBeUndefined()
  // Edit input ↗ opens the file.
  await pane.press({ key: 'input-edit' })
  expect(opened.some(argv => argv.some(a => a.replace(/\\/g, '/').endsWith('/g-pause/inputs/b.md')))).toBe(true)
  files.set(inputPath('g-pause', 'b'), 'EDITED INPUT')
  await pane.press({ key: 'continue' })
  await untilEnded(before)
  expect(sessions.map(s => s.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  expect(sessions[1]!.prompt).toBe('EDITED INPUT')
  expect(await isPausedBefore(pane, 'Bravo')).toBe(false)
  const [record] = recordsOf('g-pause')
  expect(record!.nodes['b']).toMatchObject({ status: 'done', inputEdited: true, prompt: 'EDITED INPUT' })
  expect(record!.nodes['a']!.inputEdited).toBeUndefined()
  await pane.unmount()
})

test('Continue without editing sends the built input unchanged', async ($, on) => {
  const pane = await openPane($, on, chain('g-same', ['b']))
  const before = ends
  await startRunning(pane)
  await until(() => isPausedBefore(pane, 'Bravo'))
  // An editor that adds a final newline did not change the input.
  files.set(inputPath('g-same', 'b'), `${files.get(inputPath('g-same', 'b'))}\n`)
  await pane.press({ key: 'continue' })
  await untilEnded(before)
  expect(sessions[1]!.prompt).toContain('## Handoff from Alpha')
  expect(recordsOf('g-same')[0]!.nodes['b']!.inputEdited).toBeUndefined()
  await pane.unmount()
})

test('an unedited input saved with Windows line endings is not an edit', async ($, on) => {
  const pane = await openPane($, on, chain('g-crlf', ['b']))
  const before = ends
  await startRunning(pane, 'run', 'first line\nsecond line')
  await until(() => isPausedBefore(pane, 'Bravo'))
  files.set(inputPath('g-crlf', 'b'), files.get(inputPath('g-crlf', 'b'))!.split('\n').join('\r\n'))
  await pane.press({ key: 'continue' })
  await untilEnded(before)
  expect(sessions[1]!.prompt).toBe('first line\nsecond line\n\n## Handoff from Alpha\n\nALPHA-OUT')
  expect(recordsOf('g-crlf')[0]!.nodes['b']!.inputEdited).toBeUndefined()
  await pane.unmount()
})

test('a blank input file means the built input, with the notice', async ($, on) => {
  const pane = await openPane($, on, chain('g-blank', ['b']))
  const before = ends
  await startRunning(pane)
  await until(() => isPausedBefore(pane, 'Bravo'))
  files.set(inputPath('g-blank', 'b'), '  \n\n')
  await pane.press({ key: 'continue' })
  expect(await pane.find({ text: 'Could not read the edited input; used the original.' })).toBeDefined()
  await untilEnded(before)
  expect(sessions[1]!.prompt).toBe('Write it\n\n## Handoff from Alpha\n\nALPHA-OUT')
  expect(recordsOf('g-blank')[0]!.nodes['b']!.inputEdited).toBeUndefined()
  await pane.unmount()
})

test('when the input file could not be written, Continue never sends the stale file', async ($, on) => {
  const pane = await openPane($, on, chain('g-stale-file', ['b']))
  const before = ends
  // What an earlier pause left behind.
  files.set(inputPath('g-stale-file', 'b'), 'STALE FROM AN EARLIER PAUSE')
  failInputWrites = true
  await startRunning(pane)
  await until(() => isPausedBefore(pane, 'Bravo'))
  // Edit input has nothing to open.
  await pane.press({ key: 'input-edit' })
  expect(opened).toEqual([])
  await pane.press({ key: 'continue' })
  expect(await pane.find({ text: 'Could not read the edited input; used the original.' })).toBeDefined()
  await untilEnded(before)
  expect(sessions[1]!.prompt).toBe('Write it\n\n## Handoff from Alpha\n\nALPHA-OUT')
  expect(recordsOf('g-stale-file')[0]!.nodes['b']!.inputEdited).toBeUndefined()
  await pane.unmount()
})

test('a long name leaves room for ‖ and the delete button on a marked card', async ($, on) => {
  const g = chain('g-long-name', ['b'])
  const pane = await openPane($, on, { ...g, nodes: g.nodes.map(n => (n.id === 'b' ? { ...n, name: 'Extraordinarily long name' } : n)) })
  // Clipped to 18 cells (not 20) so the mark fits beside ✕.
  expect(await pane.find({ in: 'canvas', type: 'Text', text: /Extraordinarily…$/ })).toBeDefined()
  expect(await pane.find({ in: 'canvas', type: 'Text', text: /^‖$/ })).toBeDefined()
  expect(await pane.find({ in: 'canvas', key: 'card-del-b' })).toBeDefined()
  await pane.unmount()
})

test('the paused input shows 12 lines and Show all reveals the rest', async ($, on) => {
  const pane = await openPane($, on, chain('g-long', ['a']))
  await startRunning(pane, 'run', Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n'))
  await until(() => isPausedBefore(pane, 'Alpha'))
  const shown = async (n: number) => (await pane.find({ type: 'Text', text: new RegExp(`line${n}\\b`) })) !== undefined
  expect([await shown(12), await shown(13)]).toEqual([true, false])
  await pane.press({ key: 'input-more' })
  expect(await shown(20)).toBe(true)
  await pane.press({ key: 'input-more' })
  expect(await shown(13)).toBe(false)
  await pane.press({ key: 'stop' })
  await until(() => ends > 0)
  await pane.unmount()
})

test('Show all on a paused input over 4000 characters says how much more Edit input shows', async ($, on) => {
  const pane = await openPane($, on, chain('g-huge', ['a']))
  const before = ends
  await startRunning(pane, 'run', 'y'.repeat(4500))
  await until(() => isPausedBefore(pane, 'Alpha'))
  const more = () => pane.find({ type: 'Text', text: '500 more characters: Edit input ↗ shows all' })
  expect(await more()).toBeUndefined()
  await pane.press({ key: 'input-more' })
  expect(await pane.find({ type: 'Text', text: /^y{4000}…$/ })).toBeDefined()
  expect((await more())?.props.dimColor).toBe(true)
  await pane.press({ key: 'input-more' })
  expect(await more()).toBeUndefined()
  await pane.press({ key: 'stop' })
  await untilEnded(before)
  await pane.unmount()
})

test('Step pauses before every agent; Continue all lets the rest run', async ($, on) => {
  const pane = await openPane($, on, chain('g-step'))
  const before = ends
  await startRunning(pane, 'step')
  await until(() => isPausedBefore(pane, 'Alpha'))
  expect(sessions).toEqual([])
  expect(await pane.find({ key: 'continue-all' })).toBeDefined()
  await pane.press({ key: 'continue' })
  await until(() => isPausedBefore(pane, 'Bravo'))
  expect(sessions.map(s => s.name)).toEqual(['Alpha'])
  await pane.press({ key: 'continue-all' })
  await untilEnded(before)
  expect(sessions.map(s => s.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  expect(await isPausedBefore(pane, 'Charlie')).toBe(false)
  expect(recordsOf('g-step')).toHaveLength(1)
  await pane.unmount()
})

test('a run Claude starts through a graph tool never pauses', async ($, on) => {
  const g = chain('g-tool', ['b'])
  const pane = await openPane($, on, g)
  await $.tool.call({ tool: `mcp__agent-graph__${toolName(g)}`, task: 'From Claude' } as never)
  await untilEnded(0)
  expect(sessions.map(s => s.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  expect(files.has(inputPath('g-tool', 'b'))).toBe(false)
  expect(submitted[0]).toContain('CHARLIE-OUT')
  await pane.unmount()
})

test('Stop while paused ends the run with the agent skipped', async ($, on) => {
  const pane = await openPane($, on, chain('g-stop', ['b']))
  const before = ends
  await startRunning(pane)
  await until(() => isPausedBefore(pane, 'Bravo'))
  await pane.press({ key: 'stop' })
  await untilEnded(before)
  expect(sessions.map(s => s.name)).toEqual(['Alpha'])
  const [record] = recordsOf('g-stop')
  expect(record).toMatchObject({ ending: 'stopped' })
  expect(record!.nodes['b']!.status).toBe('skipped')
  expect(record!.nodes['c']!.status).toBe('skipped')
  // Nothing is left to continue.
  expect(await isPausedBefore(pane, 'Bravo')).toBe(false)
  expect(await pane.find({ key: 'continue' })).toBeUndefined()
  await pane.unmount()
})

test('a missing input file means the built input, with a notice', async ($, on) => {
  const pane = await openPane($, on, chain('g-missing', ['b']))
  const before = ends
  await startRunning(pane)
  await until(() => isPausedBefore(pane, 'Bravo'))
  files.delete(inputPath('g-missing', 'b'))
  await pane.press({ key: 'continue' })
  expect(await pane.find({ text: 'Could not read the edited input; used the original.' })).toBeDefined()
  await untilEnded(before)
  expect(sessions[1]!.prompt).toBe('Write it\n\n## Handoff from Alpha\n\nALPHA-OUT')
  expect(recordsOf('g-missing')[0]!.nodes['b']!.inputEdited).toBeUndefined()
  await pane.unmount()
})

for (const backend of ['cloud', 'local'] as const) {
  test(`${backend === 'cloud' ? 'Cloud' : 'Local'} graphs say instruction edits apply from the next run`, async ($, on) => {
    const pane = await openPane($, on, { ...chain(`g-note-${backend}`, ['a']), backend })
    await startRunning(pane)
    await until(() => isPausedBefore(pane, 'Alpha'))
    expect(await pane.find({ type: 'Text', text: 'Instruction edits apply from the next run.' })).toBeDefined()
    await pane.press({ key: 'stop' })
    await until(() => ends > 0)
    await pane.unmount()
  })
}

test('while an agent is paused, Last run offers neither Edit input nor Run with this input', async ($, on) => {
  const g = chain('g-last-busy', ['b'])
  const pane = await openPane($, on, g)
  await $.tool.call({ tool: `mcp__agent-graph__${toolName(g)}`, task: 'Old task' } as never)
  await untilEnded(0)
  await pane.post({ events: [{ kind: 'down', x: 45, y: 2 }] })
  expect(await pane.find({ key: 'last-input-edit' })).toBeDefined()
  const before = ends
  await startRunning(pane, 'run', 'New task')
  await until(() => isPausedBefore(pane, 'Bravo'))
  // Only the paused input's own Edit input is offered: the Last run one would overwrite the file the gate reads.
  expect(await pane.find({ key: 'input-edit' })).toBeDefined()
  expect(await pane.find({ key: 'last-input-edit' })).toBeUndefined()
  expect(await pane.find({ key: 'run-with-input' })).toBeUndefined()
  expect(files.get(inputPath('g-last-busy', 'b'))).toContain('New task')
  await pane.press({ key: 'stop' })
  await untilEnded(before)
  expect(await pane.find({ key: 'last-input-edit' })).toBeDefined()
  await pane.unmount()
})

// A second graph, Other, beside the one on show, with its own instruction files.
const other = (): Graph => {
  const g = { ...chain('g-other'), name: 'Other' }
  return { ...g, nodes: g.nodes.map(n => ({ ...n, instructionsFile: `/tmp/other-${n.id}.md` })) }
}

test('deleting a graph while its run is paused ends the run; the next graph can run', async ($, on) => {
  const pane = await openPane($, on, chain('g-del-paused', ['b']), [other()])
  const before = ends
  await startRunning(pane)
  await until(() => isPausedBefore(pane, 'Bravo'))
  // Deselect, then delete the graph: the pane opens Other.
  await pane.post({ events: [{ kind: 'down', x: 30, y: 20 }] })
  await pane.press({ key: 'delete-graph' })
  await untilEnded(before)
  expect(kv.has('graph:g-del-paused')).toBe(false)
  expect(await pane.find({ key: 'stop' })).toBeUndefined()
  sessions = []
  const next = ends
  await startRunning(pane, 'run', 'Other task')
  expect(await pane.find({ type: 'Text', text: /still going/ })).toBeUndefined()
  await untilEnded(next)
  expect(sessions.map(s => s.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  await pane.unmount()
})

test('Stop shows while a run of another graph is going', async ($, on) => {
  const pane = await openPane($, on, chain('g-away', ['b']), [other()])
  // Any saved edit reads the graph list again, so the graph menu offers Other.
  await pane.input({ key: 'gdesc-g-away', text: 'Two graphs' })
  const before = ends
  await startRunning(pane)
  await until(() => isPausedBefore(pane, 'Bravo'))
  await pane.select({ key: 'graph', value: 'g-other' })
  expect((await pane.find({ key: 'graph' }))?.props.value).toBe('g-other')
  expect(await pane.find({ key: 'run' })).toBeUndefined()
  await pane.press({ key: 'stop' })
  await untilEnded(before)
  expect(await pane.find({ key: 'stop' })).toBeUndefined()
  expect(await pane.find({ key: 'run' })).toBeDefined()
  await pane.unmount()
})

test('From here pauses before an agent marked to pause, and reuses the agents before it', async ($, on) => {
  const g = chain('g-from-here', ['b'])
  const pane = await openPane($, on, g)
  await $.tool.call({ tool: `mcp__agent-graph__${toolName(g)}`, task: 'Write it' } as never)
  await untilEnded(0)
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  sessions = []
  const before = ends
  await pane.post({ events: [{ kind: 'press', node: 'b', action: 'run' }] })
  await until(() => isPausedBefore(pane, 'Bravo'))
  // Alpha is reused; Bravo waits for the person.
  expect(sessions).toEqual([])
  expect(files.get(inputPath('g-from-here', 'b'))).toContain('## Handoff from Alpha')
  await pane.press({ key: 'continue' })
  await untilEnded(before)
  expect(sessions.map(s => s.name)).toEqual(['Bravo', 'Charlie'])
  expect(recordsOf('g-from-here')[1]).toMatchObject({ mode: 'from-here', fromNode: 'b' })
  await pane.unmount()
})

// Alpha and Bravo both start the run; Charlie follows Bravo.
const fork = (id: string, paused: string[]): Graph => ({ ...chain(id, paused), edges: [{ id: 'e2', from: 'b', to: 'c', kind: 'handoff' }] })
const A = 5
const C = 83

test('a gate that opens while another paused agent is on show does not take the selection', async ($, on) => {
  const pane = await openPane($, on, fork('g-keep-selection', ['a', 'c']))
  await startRunning(pane)
  await until(() => isPausedBefore(pane, 'Alpha'))
  // Bravo runs and Charlie reaches its gate; Alpha stays on show.
  await until(() => files.has(inputPath('g-keep-selection', 'c')))
  expect(await isPausedBefore(pane, 'Alpha')).toBe(true)
  expect(await isPausedBefore(pane, 'Charlie')).toBe(false)
  await pane.post({ events: [{ kind: 'down', x: C, y: 2 }] })
  expect(await isPausedBefore(pane, 'Charlie')).toBe(true)
  await pane.press({ key: 'stop' })
  await until(() => ends > 0)
  await pane.unmount()
})

test('Continue all lets the agent go and the rest stop pausing, but a gate already open keeps waiting', async ($, on) => {
  const pane = await openPane($, on, fork('g-continue-all', []))
  const before = ends
  await startRunning(pane, 'step')
  await until(() => files.has(inputPath('g-continue-all', 'a')) && files.has(inputPath('g-continue-all', 'b')))
  await pane.post({ events: [{ kind: 'down', x: A, y: 2 }] })
  expect(await isPausedBefore(pane, 'Alpha')).toBe(true)
  await pane.press({ key: 'continue-all' })
  await until(() => sessions.some(s => s.name === 'Alpha'))
  // Bravo's gate was open already: it still waits, and nothing of it has started.
  await pane.post({ events: [{ kind: 'down', x: 45, y: 2 }] })
  expect(await isPausedBefore(pane, 'Bravo')).toBe(true)
  for (let i = 0; i < 5; i++) await clock.advance(2000)
  await tick()
  expect(sessions.map(s => s.name)).toEqual(['Alpha'])
  expect(await isPausedBefore(pane, 'Bravo')).toBe(true)
  await pane.press({ key: 'continue' })
  await untilEnded(before)
  // Charlie came after Bravo and no longer paused.
  expect(sessions.map(s => s.name).sort()).toEqual(['Alpha', 'Bravo', 'Charlie'])
  expect(await isPausedBefore(pane, 'Charlie')).toBe(false)
  await pane.unmount()
})

// The canvas gets the time of the drawing: it moves only when the pane is drawn again.
const drawnAt = async (pane: Pane) => Number(/"drawnAt":(\d+)/.exec(JSON.stringify((await pane.find({ key: 'canvas' }))?.props))?.[1])

test('the timeline redraws every second during a silent stretch of a run, only while it goes', async ($, on) => {
  const pane = await openPane($, on, chain('g-beat', ['b']))
  await pane.press({ key: 'timeline' })
  const before = ends
  await startRunning(pane)
  await until(() => isPausedBefore(pane, 'Bravo'))
  const first = await drawnAt(pane)
  await clock.advance(3000)
  await tick()
  expect(await drawnAt(pane)).toBeGreaterThan(first)
  const second = await drawnAt(pane)
  await clock.advance(1000)
  await tick()
  expect(await drawnAt(pane)).toBeGreaterThan(second)
  // Stop: the run ends, and nothing redraws it after that.
  await pane.press({ key: 'stop' })
  await untilEnded(before)
  await tick()
  const last = await drawnAt(pane)
  await clock.advance(5000)
  await tick()
  expect(await drawnAt(pane)).toBe(last)
  await pane.unmount()
})

test('with the timeline off the run is not redrawn on a clock', async ($, on) => {
  const pane = await openPane($, on, chain('g-nobeat', ['b']))
  await startRunning(pane)
  await until(() => isPausedBefore(pane, 'Bravo'))
  const first = await drawnAt(pane)
  await clock.advance(5000)
  await tick()
  expect(await drawnAt(pane)).toBe(first)
  // Turning it on draws once; the beat then follows.
  await pane.press({ key: 'timeline' })
  const on1 = await drawnAt(pane)
  await clock.advance(2000)
  await tick()
  expect(await drawnAt(pane)).toBeGreaterThan(on1)
  await pane.press({ key: 'stop' })
  await pane.unmount()
})
