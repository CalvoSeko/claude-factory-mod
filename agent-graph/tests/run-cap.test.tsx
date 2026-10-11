import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import { toolName } from '../hooks/actions'
import type { AgentNode, Graph, RunIndex, RunRecord } from '../types'

const node = (id: string, name: string, x: number): AgentNode => ({
  id, name, x, y: 1, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
// Alpha -> Bravo -> Charlie, on Cloud: the mocks can answer its REST calls, which they cannot do for a local agent.
const chain = (id: string, runCapUsd?: number): Graph => ({
  id, name: 'Flow', description: '', backend: 'cloud', layout: 2, ...(runCapUsd !== undefined ? { runCapUsd } : {}),
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
// What each agent's session has cost so far, in cents (a session.usage event, as the API reports it).
let spent = new Map<string, number>()
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
    const cents = spent.get(session.name)
    const usage = cents === undefined ? [] : [{ id: `u${cents}`, type: 'session.usage', list_cost: { amount: String(cents), currency: 'USD' } }]
    if (holding.has(session.name)) return json({ data: usage })
    return json({ data: [
      ...usage,
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
  spent = new Map()
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


const CAP_REASON = 'Stopped: the run reached its $1.00 cap.'
const spentText = (pane: Pane, text: RegExp | string) => pane.find({ type: 'Text', text })

// Starts a run of the chain and returns once Bravo is running (held), without waiting for the end.
async function runToBravo(pane: Pane) {
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  await pane.press({ key: 'run' })
  await until(() => sessions.some(s => s.name === 'Bravo'))
}

test('the Run cap input sets a positive number, clears on empty, ignores anything else', async ($, on) => {
  const pane = await openPane($, on, chain('g-input'))
  expect((await pane.find({ key: 'run-cap-g-input' }))?.props).toMatchObject({ label: 'Run cap (USD)', value: '', submitLabel: 'Set' })
  await pane.input({ key: 'run-cap-g-input', text: ' 5 ', kind: 'submit' })
  expect((kv.get('graph:g-input') as Graph).runCapUsd).toBe(5)
  expect((await pane.find({ key: 'run-cap-g-input' }))?.props.value).toBe('5')
  for (const bad of ['lots', '0', '-3', 'Infinity', '1e999']) {
    await pane.input({ key: 'run-cap-g-input', text: bad, kind: 'submit' })
    expect((kv.get('graph:g-input') as Graph).runCapUsd).toBe(5)
  }
  await pane.input({ key: 'run-cap-g-input', text: '0.25', kind: 'submit' })
  expect((kv.get('graph:g-input') as Graph).runCapUsd).toBe(0.25)
  await pane.input({ key: 'run-cap-g-input', text: '   ', kind: 'submit' })
  expect('runCapUsd' in (kv.get('graph:g-input') as Graph)).toBe(false)
  expect((await pane.find({ key: 'run-cap-g-input' }))?.props.value).toBe('')
  await pane.unmount()
})

test('a run without a cap shows no spent/cap text and is never stopped by its cost', async ($, on) => {
  const pane = await openPane($, on, chain('g-nocap'))
  holding.add('Bravo')
  spent = new Map([['Alpha', 900], ['Bravo', 900], ['Charlie', 900]])
  await runToBravo(pane)
  await clock.advance(2000)
  await tick()
  expect(await spentText(pane, /\$\d+\.\d\d \/ \$/)).toBeUndefined()
  holding.delete('Bravo')
  const before = ends
  await untilEnded(before)
  const [record] = recordsOf('g-nocap')
  expect(record).toMatchObject({ ending: 'finished' })
  expect(record!.nodes['c']).toMatchObject({ status: 'done' })
  expect(toasts.filter(t => t.includes('run cap'))).toEqual([])
  expect(toasts).toContain('Agent graph "Flow" finished')
  await pane.unmount()
})

test('the toolbar shows spent / cap while the run goes, orange from 80%, and the 80% toast comes once', async ($, on) => {
  const pane = await openPane($, on, chain('g-warn', 1))
  holding.add('Bravo')
  spent = new Map([['Alpha', 50]])
  await runToBravo(pane)
  // 50 cents of 1 dollar: shown dim after the Run/Stop buttons.
  const early = await spentText(pane, '$0.50 / $1.00')
  expect(early?.props.color).toBeUndefined()
  expect(early?.props.dimColor).toBe(true)
  expect(toasts.filter(t => t.includes('80%'))).toEqual([])
  // Bravo's session reports 35 more: 85 cents is over 80%.
  spent.set('Bravo', 35)
  await until(() => toasts.some(t => t.includes('80%')))
  const warm = await spentText(pane, '$0.85 / $1.00')
  expect(warm?.props.color).toBe('#d97757')
  // More cost under the cap changes nothing else.
  spent.set('Bravo', 45)
  await clock.advance(2000)
  await tick()
  await clock.advance(2000)
  await tick()
  expect((await spentText(pane, '$0.95 / $1.00'))?.props.color).toBe('#d97757')
  expect(toasts.filter(t => t.includes('80%'))).toEqual(['Agent graph "Flow" has used 80% of its $1.00 run cap.'])
  holding.delete('Bravo')
  const before = ends
  await untilEnded(before)
  expect(recordsOf('g-warn')[0]).toMatchObject({ ending: 'finished' })
  expect(sessions.some(s => s.isInterrupted)).toBe(false)
  // Not running any more: the text goes.
  expect(await spentText(pane, /\/ \$1\.00/)).toBeUndefined()
  await pane.unmount()
})

test('reaching the cap stops the run: the agents show the cap text, the record is over-cap, history says over cap, the toast says so', async ($, on) => {
  const pane = await openPane($, on, chain('g-over', 1))
  holding.add('Bravo')
  spent = new Map([['Alpha', 40]])
  const before = ends
  await runToBravo(pane)
  // Bravo's session reports 70 cents: 1.10 dollars in all, over the 1.00 cap.
  spent.set('Bravo', 70)
  await untilEnded(before)

  expect(sessions.filter(s => s.isInterrupted).map(s => s.name)).toEqual(['Bravo'])
  expect(sessions.map(s => s.name)).toEqual(['Alpha', 'Bravo'])
  const [record, ...others] = recordsOf('g-over')
  expect(others).toEqual([])
  expect(record).toMatchObject({ ending: 'over-cap', mode: 'full' })
  expect(record!.nodes['a']).toMatchObject({ status: 'done' })
  expect(record!.nodes['b']).toMatchObject({ status: 'cancelled', error: CAP_REASON })
  expect(record!.nodes['c']).toMatchObject({ status: 'skipped' })
  expect(toasts).toContain('Agent graph "Flow" was stopped at its $1.00 cap')
  expect(toasts.filter(t => t === 'Agent graph "Flow" was stopped')).toEqual([])
  // Crossing the line in one step goes straight to the stop: no 80% warning on the way.
  expect(toasts.filter(t => t.includes('80%'))).toEqual([])
  const index = kv.get('runs:g-over') as RunIndex
  expect(index.runs[0]).toMatchObject({ ending: 'over-cap' })
  expect((await pane.find({ type: 'Button', key: `run-${index.runs[0]!.id}` }))?.props.label).toMatch(/ · over cap · \$1\.10 · full run · "Write it"$/)
  await pane.unmount()
})

test('a plain Stop of a capped run keeps the Stopped. text and the stopped ending', async ($, on) => {
  const pane = await openPane($, on, chain('g-plain', 5))
  holding.add('Alpha')
  const before = ends
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  await pane.press({ key: 'run' })
  await until(() => sessions.length > 0)
  await pane.press({ key: 'stop' })
  await untilEnded(before)
  const [record] = recordsOf('g-plain')
  expect(record).toMatchObject({ ending: 'stopped' })
  expect(record!.nodes['a']).toMatchObject({ status: 'cancelled', error: 'Stopped.' })
  expect(toasts).toContain('Agent graph "Flow" was stopped')
  await pane.unmount()
})

test('a run Claude starts that reaches the cap submits the cap ending with the result', async ($, on) => {
  const g = chain('g-claude', 1)
  const pane = await openPane($, on, g)
  holding.add('Bravo')
  spent = new Map([['Alpha', 30], ['Bravo', 90]])
  const reply = await $.tool.call({ tool: `mcp__agent-graph__${toolName(g)}`, task: 'From Claude' } as never)
  expect(JSON.stringify(reply)).toContain('Started agent graph')
  await untilEnded(0)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/>>>\nAgent graph "Flow" was stopped at its \$1\.00 cap\.\n\n/)
  expect(recordsOf('g-claude')[0]).toMatchObject({ mode: 'tool', ending: 'over-cap' })
  await pane.unmount()
})

test('agents reused by From here are not counted against the cap', async ($, on) => {
  const g = chain('g-reuse')
  const pane = await openPane($, on, g)
  // A full run without a cap: 1.50 dollars in all.
  spent = new Map([['Alpha', 50], ['Bravo', 50], ['Charlie', 50]])
  await run(pane)
  expect(recordsOf('g-reuse')).toHaveLength(1)
  // The cap is set below what the saved agents cost together; only Charlie (50 cents) runs, and reused Alpha and
  // Bravo carry their old cost into the view.
  await pane.input({ key: 'run-cap-g-reuse', text: '0.60', kind: 'submit' })
  sessions = []
  holding.add('Charlie')
  const before = ends
  await pane.post({ events: [{ kind: 'press', node: 'c', action: 'run' }] })
  await until(() => sessions.length === 1)
  await clock.advance(2000)
  await tick()
  // 50 of 60 cents: over 80% (so the toast) but nowhere near the 1.50 the entries add up to.
  expect((await spentText(pane, '$0.50 / $0.60'))?.props.color).toBe('#d97757')
  expect(toasts.filter(t => t.includes('80%'))).toEqual(['Agent graph "Flow" has used 80% of its $0.60 run cap.'])
  holding.delete('Charlie')
  await untilEnded(before)
  const [, second] = recordsOf('g-reuse')
  expect(second).toMatchObject({ mode: 'from-here', ending: 'finished' })
  expect(second!.nodes['b']).toMatchObject({ costUsd: 0.5, reusedFrom: expect.anything() })
  await pane.unmount()
})

test('the toolbar shows the cap the run enforces, also when the graph cap is changed mid-run', async ($, on) => {
  const pane = await openPane($, on, chain('g-mid', 1))
  holding.add('Bravo')
  spent = new Map([['Alpha', 50]])
  const before = ends
  await runToBravo(pane)
  expect(await spentText(pane, '$0.50 / $1.00')).toBeDefined()
  await pane.input({ key: 'run-cap-g-mid', text: '5', kind: 'submit' })
  expect((kv.get('graph:g-mid') as Graph).runCapUsd).toBe(5)
  await clock.advance(2000)
  await tick()
  expect(await spentText(pane, '$0.50 / $1.00')).toBeDefined()
  expect(await spentText(pane, /\/ \$5\.00/)).toBeUndefined()
  // The run still stops at the cap it started with.
  spent.set('Bravo', 70)
  await untilEnded(before)
  expect(recordsOf('g-mid')[0]).toMatchObject({ ending: 'over-cap' })
  expect(toasts).toContain('Agent graph "Flow" was stopped at its $1.00 cap')
  await pane.unmount()
})
