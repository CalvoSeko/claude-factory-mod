import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import { transcriptOf } from '../hooks/actions'
import type { ActivityItem, AgentNode, Graph, NodeRecord, RunIndex, RunRecord, RunView } from '../types'

const node = (id: string, name: string, x: number): AgentNode => ({
  id, name, x, y: 1, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
// Researcher -> Writer.
const flow = (id: string): Graph => ({
  id, name: 'Flow', description: '', backend: 'local', layout: 2,
  nodes: [node('a', 'Researcher', 2), node('b', 'Writer', 40)],
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

const call = (id: string, tool: string, summary: string, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id, tool, summary, status: 'ok', startedAt: 1000, endedAt: 4000, ...over,
})

function record(id: string, ended: number, activity: ActivityItem[], over: Partial<NodeRecord> = {}): RunRecord {
  const g = flow('g-act')
  return {
    id, graphId: g.id, graphName: 'Flow', task: 'Task', mode: 'full', startedAt: ended - 60_000, endedAt: ended, ending: 'finished',
    graph: { nodes: g.nodes.map(({ x: _x, y: _y, ...n }) => n), edges: g.edges },
    nodes: {
      a: { status: 'done', inputs: [], output: 'Found it', files: [], fingerprint: 'fa', startedAt: ended - 60_000, endedAt: ended - 30_000, activity, ...over },
      b: { status: 'done', inputs: ['a'], output: 'Draft', files: [], fingerprint: 'fb', startedAt: ended - 30_000, endedAt: ended },
    },
    result: `Result of ${id}`, outputs: [],
  }
}

function indexOf(r: RunRecord): RunIndex {
  return {
    runs: [{ id: r.id, at: r.endedAt, ending: r.ending, mode: r.mode, taskLine: r.task, costUsd: 0.1 }],
    latest: Object.fromEntries(Object.entries(r.nodes).map(([id, n]) => [id, { runId: r.id, at: r.endedAt, fingerprint: n.fingerprint, task: r.task, status: n.status }])),
  }
}

async function openPane($: Args[0], on: Args[1], g: Graph, records: RunRecord[]) {
  kv = new Map<string, unknown>([['graphs', [{ id: g.id, name: g.name }]], [`graph:${g.id}`, g]])
  if (records.length > 0) kv.set(`runs:${g.id}`, indexOf(records[0]!))
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

const select = (pane: Pane, x: number) => pane.post({ events: [{ kind: 'down', x, y: 2 }] })
const labelOf = async (pane: Pane, key: string) => (await pane.find({ key }))?.props.label

const ACTIVITY: ActivityItem[] = [
  call('c1', 'Bash', 'npm test', { input: '{"command":"npm test"}', result: 'all 12 passed' }),
  call('c2', 'Read', 'src/a.ts', { status: 'failed', error: 'ENOENT: no such file' }),
  call('c3', 'Bash', 'rm -rf /', { status: 'denied', error: 'Blocked by the guard' }),
  call('c4', 'WebFetch', 'a.io/x', { status: 'running', endedAt: undefined }),
  call('d1', 'Agent', 'Helper', { startedAt: 1000, endedAt: 6000, delegate: { name: 'Helper', items: [call('n1', 'Grep', 'TODO in src', { result: '3 matches' })] } }),
]

test('a past run lists the agent calls with glyphs, colours and times; a call opens to its input and result', async ($, on) => {
  const pane = await openPane($, on, flow('g-act'), [record('r1', at(14, 2), ACTIVITY)])
  await pane.press({ key: 'run-r1' })
  await select(pane, 5)
  expect(await pane.find({ text: 'Activity' })).toBeDefined()
  expect(await labelOf(pane, 'act-c1')).toBe('Bash · npm test · 0:03')
  expect(await labelOf(pane, 'act-c2')).toBe('Read · src/a.ts · 0:03')
  expect(await labelOf(pane, 'act-d1')).toBe('Helper · 0:05')
  expect((await pane.find({ type: 'Text', text: '✓' }))?.props.color).toBe('#5aa469')
  expect((await pane.find({ type: 'Text', text: '✗' }))?.props.color).toBe('#d4453b')
  expect(await pane.find({ type: 'Text', text: '⊘' })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: '↳' }))?.props.color).toBe('#7c8db5')
  // A call that never ended in a past run reads 0:00, not a time that keeps growing.
  expect(await labelOf(pane, 'act-c4')).toBe('WebFetch · a.io/x · 0:00')
  // Closed: no detail.
  expect(await pane.find({ text: /all 12 passed/ })).toBeUndefined()
  await pane.press({ key: 'act-c1' })
  expect(await pane.find({ text: /Input/ })).toBeDefined()
  expect(await pane.find({ text: /"command":"npm test"/ })).toBeDefined()
  expect(await pane.find({ text: /all 12 passed/ })).toBeDefined()
  await pane.press({ key: 'act-c2' })
  expect((await pane.find({ type: 'Text', text: /ENOENT/ }))?.props.color).toBe('#d4453b')
  await pane.press({ key: 'act-c1' })
  expect(await pane.find({ text: /all 12 passed/ })).toBeUndefined()
  await pane.unmount()
})

test('a delegate row opens to its nested calls, indented two spaces', async ($, on) => {
  const pane = await openPane($, on, flow('g-act'), [record('r1', at(14, 2), ACTIVITY)])
  await pane.press({ key: 'run-r1' })
  await select(pane, 5)
  expect(await pane.find({ key: 'act-n1' })).toBeUndefined()
  await pane.press({ key: 'act-d1' })
  expect(await labelOf(pane, 'act-n1')).toBe('Grep · TODO in src · 0:03')
  // Its glyph is indented one level (two spaces) more than a top-level row's.
  expect(await pane.find({ type: 'Text', text: /^ {2}✓$/ })).toBeDefined()
  await pane.press({ key: 'act-n1' })
  expect(await pane.find({ text: /3 matches/ })).toBeDefined()
  await pane.press({ key: 'act-d1' })
  expect(await pane.find({ key: 'act-n1' })).toBeUndefined()
  await pane.unmount()
})

test('the newest 30 calls list, and Show all lists every one', async ($, on) => {
  const many = Array.from({ length: 35 }, (_, i) => call(`m${i + 1}`, 'Bash', `step ${i + 1}`))
  const pane = await openPane($, on, flow('g-act'), [record('r1', at(14, 2), many)])
  await pane.press({ key: 'run-r1' })
  await select(pane, 5)
  expect(await pane.find({ key: 'act-m5' })).toBeUndefined()
  expect(await pane.find({ key: 'act-m6' })).toBeDefined()
  expect(await pane.find({ key: 'act-m35' })).toBeDefined()
  expect(await labelOf(pane, 'all-calls')).toBe('Show all (35)')
  await pane.press({ key: 'all-calls' })
  expect(await pane.find({ key: 'act-m1' })).toBeDefined()
  expect(await labelOf(pane, 'all-calls')).toBe('Show fewer')
  await pane.press({ key: 'all-calls' })
  expect(await pane.find({ key: 'act-m1' })).toBeUndefined()
  await pane.unmount()
})

test('the current run (Back to latest) shows the activity of its record too; an agent without calls has no section', async ($, on) => {
  const pane = await openPane($, on, flow('g-act'), [record('r1', at(14, 2), ACTIVITY)])
  await pane.press({ key: 'run-r1' })
  await pane.press({ key: 'back-to-latest' })
  await select(pane, 5)
  expect(await pane.find({ key: 'act-c1' })).toBeDefined()
  await select(pane, 45)
  expect(await pane.find({ text: 'Activity' })).toBeUndefined()
  await pane.unmount()
})

test('opening another run closes the rows that were open', async ($, on) => {
  const pane = await openPane($, on, flow('g-act'), [record('r1', at(14, 2), ACTIVITY)])
  await pane.press({ key: 'run-r1' })
  await select(pane, 5)
  await pane.press({ key: 'act-c1' })
  expect(await pane.find({ text: /all 12 passed/ })).toBeDefined()
  await pane.press({ key: 'back-to-latest' })
  expect(await pane.find({ text: /all 12 passed/ })).toBeUndefined()
  await pane.unmount()
})

test('the transcript gives a delegate helper its own section, marked with its caller', async () => {
  const g = flow('g-act')
  const run: RunView = {
    graphId: g.id, graphName: 'Flow', isRunning: false, task: 'T', result: 'R',
    nodes: {
      a: { status: 'done', output: 'Lead out', startedAt: 1000, endedAt: 9000 },
      b: { status: 'done', output: 'Helper out', startedAt: 2000, endedAt: 5000, calledBy: 'a' },
    },
  }
  const text = transcriptOf(g, run, '2026-10-09')
  expect(text).toContain('## Researcher\n\ndone')
  expect(text).toContain('## Writer (called by Researcher)\n\ndone · 0:03\n\nHelper out')
})

test('a failed delegate call is red, a call that never ended in a past run is dim, and a detail is indented line by line', async ($, on) => {
  const items = [
    call('d1', 'Agent', 'Helper', { status: 'failed', error: 'thread ended', delegate: { name: 'Helper', items: [] } }),
    call('c1', 'Bash', 'cat notes', { status: 'running', endedAt: undefined, result: 'first\nsecond' }),
  ]
  const pane = await openPane($, on, flow('g-act'), [record('r1', at(14, 2), items)])
  await pane.press({ key: 'run-r1' })
  await select(pane, 5)
  expect((await pane.find({ type: 'Text', text: '↳' }))?.props.color).toBe('#d4453b')
  const unfinished = await pane.find({ type: 'Text', text: '●' })
  expect(unfinished).toBeDefined()
  expect(unfinished?.props.color).toBeUndefined()
  await pane.press({ key: 'act-c1' })
  expect(await pane.find({ type: 'Text', text: '  first' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '  second' })).toBeDefined()
  await pane.unmount()
})

// Researcher runs 60 s .. 30 s before the end, calling Helper from 50 s to 40 s before it; Writer runs the last 30 s.
const TIMELINE_ACTIVITY = [call('d1', 'Agent', 'Helper', { startedAt: at(14, 2) - 50_000, endedAt: at(14, 2) - 40_000, delegate: { name: 'Helper', items: [] } })]
// The coloured runs of the bars, row by row, left to right: [cells, colour].
const bars = async (pane: Pane) =>
  (await pane.findAll({ type: 'Text' })).filter(t => /^━+$/.test(t.text)).map(t => ({ n: Array.from(t.text).length, color: t.props.color }))

test('the Timeline button toggles one bar per agent under the canvas; the delegate stretch is blue; a label selects the card', async ($, on) => {
  const pane = await openPane($, on, flow('g-act'), [record('r1', at(14, 2), TIMELINE_ACTIVITY)])
  await pane.press({ key: 'run-r1' })
  expect(await pane.find({ key: 'tl-a' })).toBeUndefined()
  expect(await labelOf(pane, 'timeline')).toBe('Timeline')
  await pane.press({ key: 'timeline' })
  expect(await labelOf(pane, 'tl-a')).toBe('Researcher')
  expect(await labelOf(pane, 'tl-b')).toBe('Writer')
  // Researcher: orange, then the blue delegate stretch, orange again, then green to the end. Writer: blank, orange, a green tip.
  const runs = await bars(pane)
  expect(runs.map(r => r.color)).toEqual(['#d97757', '#7c8db5', '#d97757', '#5aa469', '#d97757', '#5aa469'])
  const [a0, a1, a2, a3, b0, b1] = runs.map(r => r.n) as [number, number, number, number, number, number]
  // In proportion to the minute: 10 s each of orange, blue and orange, then 30 s done; Writer runs the last 30 s.
  const width = a0 + a1 + a2 + a3
  expect(Math.abs(a1 - width / 6)).toBeLessThanOrEqual(1)
  expect(Math.abs(a3 - width / 2)).toBeLessThanOrEqual(1)
  // Writer ends with the run: orange, then one green cell at the tip.
  expect(b1).toBe(1)
  expect(Math.abs(b0 + b1 - width / 2)).toBeLessThanOrEqual(1)
  expect(width).toBeGreaterThan(40)
  // The footer: 0:00 at the left, the run's length (1:00) at the right.
  const footer = (await pane.findAll({ type: 'Text' })).find(t => /^ *0:00 *… *1:00$/.test(t.text))
  expect(footer).toBeDefined()
  // The label column is the longest name (Researcher) and a space.
  expect(footer!.text.length).toBe('Researcher'.length + 1 + width)
  // A label selects the card (the inspector shows that agent's Activity list).
  expect(await pane.find({ text: 'Activity' })).toBeUndefined()
  await pane.press({ key: 'tl-a' })
  expect(await pane.find({ key: 'act-d1' })).toBeDefined()
  await pane.press({ key: 'timeline' })
  expect(await pane.find({ key: 'tl-a' })).toBeUndefined()
  await pane.unmount()
})

test('no timeline without a run to show, even when it is on', async ($, on) => {
  const pane = await openPane($, on, flow('g-act'), [])
  await pane.press({ key: 'timeline' })
  expect(await labelOf(pane, 'timeline')).toBe('Timeline')
  expect(await pane.find({ key: 'tl-a' })).toBeUndefined()
  await pane.unmount()
})

test('opening a call opens it on that agent only, though another agent has a call of the same id', async ($, on) => {
  const r = record('r1', at(14, 2), [call('c1', 'Bash', 'npm test', { result: 'result of a' })])
  r.nodes['b'] = { ...r.nodes['b']!, activity: [call('c1', 'Bash', 'npm run build', { result: 'result of b' })] }
  const pane = await openPane($, on, flow('g-act'), [r])
  await pane.press({ key: 'run-r1' })
  await select(pane, 5)
  await pane.press({ key: 'act-c1' })
  expect(await pane.find({ text: /result of a/ })).toBeDefined()
  await select(pane, 45)
  expect(await labelOf(pane, 'act-c1')).toBe('Bash · npm run build · 0:03')
  expect(await pane.find({ text: /result of b/ })).toBeUndefined()
  await pane.press({ key: 'act-c1' })
  expect(await pane.find({ text: /result of b/ })).toBeDefined()
  await pane.unmount()
})

test('a helper reopened from Runs lists the calls its caller holds for it', async ($, on) => {
  const r = record('r1', at(14, 2), [call('d1', 'Agent', 'Writer', { delegate: { nodeId: 'b', name: 'Writer', items: [call('n1', 'Grep', 'TODO in src')] } })])
  // The helper's entry is saved without a copy of its calls.
  r.nodes['b'] = { ...r.nodes['b']!, calledBy: 'a' }
  const pane = await openPane($, on, flow('g-act'), [r])
  await pane.press({ key: 'run-r1' })
  await select(pane, 45)
  expect(await pane.find({ text: 'Activity' })).toBeDefined()
  expect(await labelOf(pane, 'act-n1')).toBe('Grep · TODO in src · 0:03')
  await pane.unmount()
})
