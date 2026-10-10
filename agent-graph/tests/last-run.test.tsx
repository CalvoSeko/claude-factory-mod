import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import { clockTime } from '../hooks/grid'
import type { AgentNode, Graph, NodeRecord, RunIndex, RunRecord } from '../types'

const node = (id: string, name: string, x: number): AgentNode => ({
  id, name, x, y: 1, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
// Researcher -> Writer, and a Checker nobody has run.
const flow = (id: string): Graph => ({
  id, name: 'Flow', description: '', backend: 'local', layout: 2,
  nodes: [node('a', 'Researcher', 2), node('b', 'Writer', 40), node('c', 'Checker', 78)],
  edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }],
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

let clock: MockClock
let kv = new Map<string, unknown>()
let files = new Map<string, string>()
const norm = (path: string) => {
  const plain = path.replace(/[\\]/g, '/').replace(/^[A-Za-z]:/, '')
  const at = plain.indexOf('/.claude/agent-graph/')
  return at >= 0 ? `.${plain.slice(at)}` : plain
}

const at = (h: number, m: number) => new Date(2026, 9, 8, h, m).getTime()
const lines = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix} line ${i + 1}`).join('\n')

// A record as the actions write it: Researcher then Writer, the Writer having received the Researcher's output.
function record(id: string, task: string, ended: number, over: Partial<RunRecord> = {}, nodes: Record<string, Partial<NodeRecord>> = {}): RunRecord {
  const g = flow('g-hist')
  return {
    id, graphId: g.id, graphName: 'Flow', task, mode: 'full', startedAt: ended - 60_000, endedAt: ended, ending: 'finished',
    graph: { nodes: g.nodes.map(({ x: _x, y: _y, ...n }) => n), edges: g.edges },
    nodes: {
      a: { status: 'done', inputs: [], output: lines('Research', 4), files: [], fingerprint: 'fa', startedAt: ended - 60_000, endedAt: ended - 30_000, costUsd: 0.05, ...nodes['a'] },
      b: { status: 'done', inputs: ['a'], output: lines('Draft', 12), files: [], fingerprint: 'fb', startedAt: ended - 42_000, endedAt: ended, costUsd: 0.12, ...nodes['b'] },
    },
    result: `Result of ${id}`, outputs: [],
    ...over,
  }
}

function indexOf(records: RunRecord[], newest: RunRecord): RunIndex {
  return {
    runs: records.map(r => ({ id: r.id, at: r.endedAt, ending: r.ending, mode: r.mode, ...(r.fromNode === 'b' ? { fromName: 'Writer' } : {}), taskLine: r.task, costUsd: 0.84, ...(Object.values(r.nodes).some(n => n.costEstimated === true) ? { costEstimated: true } : {}) })),
    latest: Object.fromEntries(Object.entries(newest.nodes).map(([id, n]) => [id, { runId: newest.id, at: newest.endedAt, fingerprint: n.fingerprint, task: newest.task, status: n.status }])),
  }
}

async function openPane($: Args[0], on: Args[1], g: Graph, records: RunRecord[]) {
  kv = new Map<string, unknown>([['graphs', [{ id: g.id, name: g.name }]], [`graph:${g.id}`, g]])
  if (records.length > 0) kv.set(`runs:${g.id}`, indexOf(records, records[0]!))
  files = new Map(g.nodes.map(n => [n.instructionsFile, `Instructions of ${n.name}.`] as const))
  for (const r of records) files.set(`./.claude/agent-graph/${g.id}/runs/${r.id}.json`, JSON.stringify(r))
  on('store.get', (_$, e) => ({ value: kv.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    kv.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => ({ value: kv.delete((e as unknown as { key: string }).key) }) as never)
  clock = mock.clock(on, { now: at(15, 0) })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.message', () => ({ value: undefined }) as never)
  on('fs.write', (_$, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    files.set(norm(path), text)
    return { value: undefined } as never
  })
  on('fs.exists', (_$, e) => ({ value: files.has(norm((e as unknown as { path: string }).path)) }) as never)
  on('fs.read', (_$, e) => ({ value: files.get(norm((e as unknown as { path: string }).path)) ?? '' }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'agent-graph' })
  await band.unmount()
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}
type Pane = Awaited<ReturnType<typeof openPane>>

// Selects an agent by pressing its card on the canvas.
const select = (pane: Pane, x: number) => pane.post({ events: [{ kind: 'down', x, y: 2 }] })
const taskOf = async (pane: Pane) => (await pane.find({ key: 'task' }))?.props.value

test('the inspector shows the status line, the input and the first lines of the output', async ($, on) => {
  const pane = await openPane($, on, flow('g-hist'), [record('r2', 'Write the brief', at(14, 2)), record('r1', 'Older', at(13, 50))])
  await select(pane, 45)
  expect(await pane.find({ text: `Last run · done · 0:42 · $0.12 · ${clockTime(at(14, 2))}` })).toBeDefined()
  // The Writer received the Researcher's output: its first three lines, not the fourth.
  expect(await pane.find({ text: 'From Researcher:' })).toBeDefined()
  expect(await pane.find({ text: /Research line 3/ })).toBeDefined()
  expect(await pane.find({ text: /Research line 4/ })).toBeUndefined()
  // Its own output: ten lines, then Show all.
  expect(await pane.find({ text: /Draft line 10/ })).toBeDefined()
  expect(await pane.find({ text: /Draft line 11/ })).toBeUndefined()
  expect((await pane.find({ key: 'last-run-more' }))?.props.label).toBe('Show all')
  await pane.press({ key: 'last-run-more' })
  expect(await pane.find({ text: /Draft line 12/ })).toBeDefined()
  expect((await pane.find({ key: 'last-run-more' }))?.props.label).toBe('Show less')
  await pane.press({ key: 'last-run-more' })
  expect(await pane.find({ text: /Draft line 11/ })).toBeUndefined()
  await pane.unmount()
})

test('a failed entry shows its error in red, and an agent with no input shows none', async ($, on) => {
  const failed = record('r1', 'Task', at(14, 2), {}, { a: { status: 'failed', output: undefined, error: 'It broke' } })
  const pane = await openPane($, on, flow('g-hist'), [failed])
  await select(pane, 5)
  expect(await pane.find({ text: /Last run · failed/ })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: /It broke/ }))?.props.color).toBe('#d4453b')
  expect(await pane.find({ text: /^From / })).toBeUndefined()
  await pane.unmount()
})

test('an agent that has not run shows Not run yet', async ($, on) => {
  const pane = await openPane($, on, flow('g-hist'), [record('r1', 'Task', at(14, 2))])
  await select(pane, 80)
  expect(await pane.find({ text: /Not run yet/ })).toBeDefined()
  expect(await pane.find({ text: /Last run · / })).toBeUndefined()
  await pane.unmount()
})

test('an entry that was reused says where it came from', async ($, on) => {
  const reused = record('r2', 'Task', at(14, 2), { mode: 'from-here', fromNode: 'b' }, { a: { reusedFrom: { runId: 'r1', at: at(13, 50) } } })
  const pane = await openPane($, on, flow('g-hist'), [reused])
  await select(pane, 5)
  expect(await pane.find({ text: new RegExp(`^Last run · done · .*reused from ${clockTime(at(13, 50))}$`) })).toBeDefined()
  await pane.unmount()
})

test('the Runs list shows each run; a past one opens as a historic view that can go back or lend its task', async ($, on) => {
  const second = record('r2', 'Summarise the second thing', at(14, 2), { mode: 'from-here', fromNode: 'b' })
  const first = record('r1', 'First task', at(13, 50))
  const pane = await openPane($, on, flow('g-hist'), [second, first])
  expect(await pane.find({ text: 'Runs' })).toBeDefined()
  expect((await pane.find({ key: 'run-r2' }))?.props.label).toBe(`${clockTime(at(14, 2))} · finished · $0.84 · from Writer · "Summarise the second thing"`)
  expect((await pane.find({ key: 'run-r1' }))?.props.label).toBe(`${clockTime(at(13, 50))} · finished · $0.84 · full run · "First task"`)
  expect(await pane.find({ text: /Viewing the run from/ })).toBeUndefined()

  await pane.press({ key: 'run-r1' })
  expect(await pane.find({ text: `Viewing the run from ${clockTime(at(13, 50))}` })).toBeDefined()
  expect(await pane.find({ text: /Result of r1/ })).toBeDefined()
  await pane.press({ key: 'use-run-task' })
  expect(await taskOf(pane)).toBe('First task')
  // The newest run is the current one, not a past one: no banner.
  await pane.press({ key: 'back-to-latest' })
  expect(await pane.find({ text: /Viewing the run from/ })).toBeUndefined()
  expect(await pane.find({ text: /Result of r2/ })).toBeDefined()
  await pane.unmount()
})

test('only the newest five runs list until Show all runs', async ($, on) => {
  const many = Array.from({ length: 7 }, (_, i) => record(`r${7 - i}`, `Task ${7 - i}`, at(16 - i, 0)))
  const pane = await openPane($, on, flow('g-hist'), many)
  const shown = async () => (await Promise.all(many.map(r => pane.find({ key: `run-${r.id}` })))).filter(x => x !== undefined).length
  expect(await shown()).toBe(5)
  expect((await pane.find({ key: 'all-runs' }))?.props.label).toBe('Show all runs (7)')
  await pane.press({ key: 'all-runs' })
  expect(await shown()).toBe(7)
  expect((await pane.find({ key: 'all-runs' }))?.props.label).toBe('Show fewer runs')
  await pane.press({ key: 'all-runs' })
  expect(await shown()).toBe(5)
  await pane.unmount()
})

test('a graph that has never run lists no runs', async ($, on) => {
  const pane = await openPane($, on, flow('g-hist'), [])
  expect(await pane.find({ text: 'Runs' })).toBeUndefined()
  await pane.unmount()
})

test('opening a graph with saved runs fills a blank task box with the newest run\'s task, and no card is stale for it', async ($, on) => {
  const long = `Write the brief\n${'and more detail '.repeat(10)}`
  const pane = await openPane($, on, flow('g-hist'), [record('r2', long, at(14, 2)), record('r1', 'Older', at(13, 50))])
  expect(await taskOf(pane)).toBe(long)
  expect(await pane.find({ in: 'canvas', text: /stale · task changed/ })).toBeUndefined()
  await pane.unmount()
})

test('a collapsed output of one long line is clipped by characters too', async ($, on) => {
  const huge = 'x'.repeat(5000)
  const pane = await openPane($, on, flow('g-hist'), [record('r1', 'Task', at(14, 2), {}, { b: { output: huge } })])
  await select(pane, 45)
  expect(await pane.find({ type: 'Text', text: /^x{1500}…$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^x{1501}/ })).toBeUndefined()
  // Long by characters alone, so it can still be shown in full (up to the expanded limit).
  expect((await pane.find({ key: 'last-run-more' }))?.props.label).toBe('Show all')
  await pane.press({ key: 'last-run-more' })
  expect(await pane.find({ type: 'Text', text: /^x{4000}…$/ })).toBeDefined()
  await pane.unmount()
})

test('an agent with several inputs shows one Input heading above them', async ($, on) => {
  const base = record('r1', 'Task', at(14, 2))
  const checked: RunRecord = {
    ...base,
    nodes: { ...base.nodes, c: { status: 'done', inputs: ['a', 'b'], output: 'Checked.', files: [], fingerprint: 'fc', startedAt: at(14, 1), endedAt: at(14, 2), costUsd: 0.01 } },
  }
  const pane = await openPane($, on, flow('g-hist'), [checked])
  await select(pane, 80)
  expect(await pane.findAll({ type: 'Text', text: 'Input' })).toHaveLength(1)
  expect(await pane.find({ text: 'From Researcher:' })).toBeDefined()
  expect(await pane.find({ text: 'From Writer:' })).toBeDefined()
  await pane.unmount()
})

test('a collapsed output is clipped by characters, not by the halves of a pair', async ($, on) => {
  // U+1D538 takes two UTF-16 code units: slicing by code unit would cut one in half.
  const huge = '\u{1D538}'.repeat(5000)
  const pane = await openPane($, on, flow('g-hist'), [record('r1', 'Task', at(14, 2), {}, { b: { output: huge } })])
  await select(pane, 45)
  expect(await pane.find({ type: 'Text', text: /^(\u{1D538}){1500}…$/u })).toBeDefined()
  await pane.unmount()
})

test('an estimated cost is printed with ≈ in the status line of the last run and in the history', async ($, on) => {
  const estimated = record('r1', 'Write the brief', at(14, 2), {}, { b: { costEstimated: true } })
  const exact = record('r2', 'Older', at(13, 50))
  const pane = await openPane($, on, flow('g-hist'), [estimated, exact])
  await select(pane, 45)
  expect(await pane.find({ text: `Last run · done · 0:42 · ≈$0.12 · ${clockTime(at(14, 2))}` })).toBeDefined()
  // The Researcher's entry of the same run is exact.
  await select(pane, 5)
  expect(await pane.find({ text: `Last run · done · 0:30 · $0.05 · ${clockTime(at(14, 2) - 30_000)}` })).toBeDefined()
  expect(await pane.find({ text: /· finished · ≈\$0\.84 · full run · "Write the brief"/ })).toBeDefined()
  expect(await pane.find({ text: /· finished · \$0\.84 · full run · "Older"/ })).toBeDefined()
  // Opened as the run on show, the agent's status line says so too.
  await pane.press({ key: 'run-r1' })
  await select(pane, 45)
  expect(await pane.find({ text: /^● done · ≈\$0\.12$/ })).toBeDefined()
  await select(pane, 5)
  expect(await pane.find({ text: /^● done · \$0\.05$/ })).toBeDefined()
  await pane.unmount()
})

// Keep this test last in the file: its run is left going, and while it is the module's
// active-run slot refuses any later run.
test('the run list is not clickable while a run is going', async ($, on) => {
  on('agent.register', () => ({ value: undefined }) as never)
  on('agent.spawn', () => new Promise(() => {}) as never)
  const pane = await openPane($, on, flow('g-hist'), [record('r1', 'Task', at(13, 50))])
  expect(await pane.find({ key: 'run-r1' })).toBeDefined()
  await pane.input({ key: 'task', text: 'Go', kind: 'change' })
  await pane.press({ key: 'run' })
  // The run starts in the background: move the clock until the Stop button shows.
  for (let i = 0; i < 100 && (await pane.find({ key: 'stop' })) === undefined; i++) {
    await clock.advance(16)
    await new Promise<void>(resolve => setTimeout(resolve, 2))
  }
  expect(await pane.find({ key: 'stop' })).toBeDefined()
  expect(await pane.find({ key: 'run-r1' })).toBeUndefined()
  expect(await pane.find({ text: /· finished · \$0\.84 · full run · "Task"/ })).toBeDefined()
  await pane.unmount()
})
