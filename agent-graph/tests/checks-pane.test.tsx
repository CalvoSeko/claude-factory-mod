import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import type { AgentNode, Edge, Graph, RunRecord, RunView } from '../types'
import { createGuard } from '../hooks/guard'
import { createCompletions, createLocalBackend, type CommandChunk, type CommandEnd, type LocalDeps } from '../hooks/local'
import { recordOf, withRecord } from '../hooks/records'
import { runGraph } from '../hooks/runner'

const agent = (id: string, name: string, x: number, y = 1): AgentNode => ({
  id, name, x, y, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
const checkCard = (id: string, name: string, x: number, command = 'npm test', y = 1): AgentNode => ({
  id, name, x, y, instructionsFile: '', skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2, check: { command, timeoutMin: 10 },
})
const edge = (id: string, from: string, to: string, kind: Edge['kind'], retries?: number): Edge => ({ id, from, to, kind, ...(retries !== undefined ? { retries } : {}) })

// Implementer -> Check 1 -> Writer on Local; Check 1 sends work back to Implementer (2 retries: up to three rounds).
const loop = (id: string, retries = 2): Graph => ({
  id, name: 'Flow', description: '', backend: 'local', layout: 2,
  nodes: [agent('a', 'Implementer', 2), checkCard('k', 'Check 1', 40), agent('w', 'Writer', 78)],
  edges: [edge('e1', 'a', 'k', 'handoff'), edge('e2', 'k', 'w', 'handoff'), edge('e3', 'k', 'a', 'retry', retries)],
})
// Two agents, for the arrows' own tests.
const pair = (id: string, edges: Edge[] = [edge('e1', 'a', 'b', 'handoff')], backend: Graph['backend'] = 'local'): Graph => ({
  id, name: 'Flow', description: '', backend, layout: 2, nodes: [agent('a', 'Implementer', 2), agent('b', 'Reviewer', 40)], edges,
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
let kv = new Map<string, unknown>()
const norm = (path: string) => {
  const plain = path.replace(/[\\]/g, '/').replace(/^[A-Za-z]:/, '')
  const at = plain.indexOf('/.claude/agent-graph/')
  return at >= 0 ? `.${plain.slice(at)}` : plain
}
let ends = 0
const toasts: string[] = []
// The agents the pane's own runs tried to start (the mocks start none: a run of this pane ends at once, with its first agent failed).
let spawns: string[] = []

// Saved runs the pane is given to open, the way a run saves them.
async function openPane($: Args[0], on: Args[1], g: Graph, surface: 'terminal' | 'desktop' = 'terminal', saved: RunRecord[] = []) {
  kv = new Map<string, unknown>([['graphs', [{ id: g.id, name: g.name }]], [`graph:${g.id}`, g]])
  on('store.get', (_$, e) => ({ value: kv.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    kv.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => ({ value: kv.delete((e as unknown as { key: string }).key) }) as never)
  clock = mock.clock(on, { now: 1_000_000 })
  files = new Map(g.nodes.filter(n => n.instructionsFile !== '').map(n => [n.instructionsFile, `Instructions of ${n.name}.`] as const))
  toasts.length = 0
  ends = 0
  spawns = []
  const index = saved.reduce((sofar, record) => withRecord(sofar, record).index, { runs: [], latest: {} } as import('../types').RunIndex)
  if (saved.length > 0) kv.set(`runs:${g.id}`, index)
  for (const record of saved) files.set(`./.claude/agent-graph/${g.id}/runs/${record.id}.json`, JSON.stringify(record))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as unknown as { text: string }).text))
    if (/finished|was stopped|could not start/.test(toasts[toasts.length - 1]!)) ends++
    return { value: undefined } as never
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('fs.write', (_$, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    files.set(norm(path), text)
    return { value: undefined } as never
  })
  on('fs.exists', (_$, e) => ({ value: files.has(norm((e as unknown as { path: string }).path)) }) as never)
  on('fs.read', (_$, e) => ({ value: files.get(norm((e as unknown as { path: string }).path)) ?? '' }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'api-key' } }) as never)
  on('agent.register', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$, e) => {
    spawns.push(String((e as unknown as { subagent_type?: string }).subagent_type ?? ''))
    return { model: 'm' } as never
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
  return $.ui.mount({ ...PANE, surface })
}

const stored = (id: string) => kv.get(`graph:${id}`) as Graph
const cardsOfPane = async (pane: Pane) =>
  JSON.parse(JSON.stringify((await pane.find({ key: 'canvas' }))?.props)).props.cards as Array<{ id: string; name: string; line: string; lineTone: string; runFrom?: string; round?: string; canRunFrom: boolean }>
const edgesOfPane = async (pane: Pane) =>
  JSON.parse(JSON.stringify((await pane.find({ key: 'canvas' }))?.props)).props.edges as Array<{ id: string; kind: string; flow: string; tag?: { x: number; y: number; t: string } }>
const select = (pane: Pane, x: number, y = 2) => pane.post({ events: [{ kind: 'down', x, y }] })
const texts = async (pane: Pane, text: RegExp | string) => (await pane.findAll({ type: 'Text', text })).map(t => t.text)

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))

async function untilEnded(before: number) {
  for (let i = 0; i < 300 && ends <= before; i++) {
    await clock.advance(2000)
    await tick()
  }
  expect(ends).toBeGreaterThan(before)
}

const recordsOf = (graphId: string): RunRecord[] =>
  [...files.keys()].filter(p => p.includes(`/${graphId}/runs/`) && p.endsWith('.json')).map(p => JSON.parse(files.get(p)!) as RunRecord).sort((x, y) => x.startedAt - y.startedAt)

test('+ Check shows on Local and Headless graphs, not on Cloud', async ($, on) => {
  const pane = await openPane($, on, pair('g-btn'))
  expect(await pane.find({ key: 'add-check' })).toBeDefined()
  expect((await pane.find({ key: 'add-check' }))?.props.label).toBe('+ Check')
  // Headless runs checks too (the button next to it switches).
  await pane.press({ key: 'backend' })
  expect(stored('g-btn').backend).toBe('headless')
  expect(await pane.find({ key: 'add-check' })).toBeDefined()
  // Cloud has none.
  await pane.press({ key: 'backend' })
  expect(stored('g-btn').backend).toBe('cloud')
  expect(await pane.find({ key: 'add-check' })).toBeUndefined()
  await pane.press({ key: 'backend' })
  expect(await pane.find({ key: 'add-check' })).toBeDefined()
  await pane.unmount()
})

test('the backend button cycles Local, Headless, Cloud and back', async ($, on) => {
  const pane = await openPane($, on, pair('g-cycle'))
  const label = async () => (await pane.find({ key: 'backend' }))?.props.label
  expect(await label()).toBe('Local')
  await pane.press({ key: 'backend' })
  expect(await label()).toBe('Headless')
  await pane.press({ key: 'backend' })
  expect(await label()).toBe('Cloud')
  await pane.press({ key: 'backend' })
  expect(await label()).toBe('Local')
  expect(stored('g-cycle').backend).toBe('local')
  await pane.unmount()
})

test('+ Check adds a check card on a Headless graph', async ($, on) => {
  const pane = await openPane($, on, pair('g-head', undefined, 'headless'))
  expect((await pane.find({ key: 'backend' }))?.props.label).toBe('Headless')
  await pane.press({ key: 'add-check' })
  expect(stored('g-head').nodes[2]).toMatchObject({ name: 'Check 1', check: { command: '', timeoutMin: 10 } })
  await pane.unmount()
})

test('+ Check adds a selected check card named Check <n>, with an empty command and the smallest free number', async ($, on) => {
  const pane = await openPane($, on, { ...pair('g-add'), nodes: [agent('a', 'Implementer', 2), agent('b', 'Check 2', 40)] })
  await pane.press({ key: 'add-check' })
  const first = stored('g-add').nodes[2]!
  expect(first).toMatchObject({
    name: 'Check 1', check: { command: '', timeoutMin: 10 }, instructionsFile: '', skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
  })
  expect(first.x).toBeGreaterThanOrEqual(0)
  // Selected: its inspector is open.
  expect(await pane.find({ key: `check-cmd-${first.id}` })).toBeDefined()
  expect(await pane.find({ key: `name-${first.id}` })).toBeDefined()
  // No instructions file is made for it.
  expect([...files.keys()].some(p => p.includes(first.id))).toBe(false)
  // "Check 2" is taken (by an agent), so the next is 3; a freed number is reused.
  await pane.press({ key: 'add-check' })
  expect(stored('g-add').nodes[3]!.name).toBe('Check 3')
  await select(pane, first.x + 1, first.y + 1)
  await pane.input({ key: `name-${first.id}`, text: 'Gate' })
  await pane.press({ key: 'add-check' })
  expect(stored('g-add').nodes[4]!.name).toBe('Check 1')
  // The card says it has no command yet.
  expect((await cardsOfPane(pane)).filter(c => c.id !== 'a' && c.id !== 'b').map(c => [c.line, c.lineTone])).toEqual([['$ (no command)', 'dim'], ['$ (no command)', 'dim'], ['$ (no command)', 'dim']])
  await pane.unmount()
})

test('the check inspector has a command and a timeout, the name, Disable and Pause before, and none of the agent fields', async ($, on) => {
  const g: Graph = { ...pair('g-insp'), nodes: [agent('a', 'Implementer', 2), checkCard('k', 'Check 1', 40, 'npm test')], edges: [] }
  const pane = await openPane($, on, g)
  await select(pane, 45)
  const cmd = await pane.find({ key: 'check-cmd-k' })
  expect(cmd?.props).toMatchObject({ label: 'Command', value: 'npm test', submitLabel: 'Save' })
  const timeout = await pane.find({ key: 'check-timeout-k' })
  expect(timeout?.props).toMatchObject({ label: 'Timeout (min)', value: '10', submitLabel: 'Set' })
  for (const key of ['name-k', 'disable-k', 'pause-k']) expect(await pane.find({ key }), key).toBeDefined()
  for (const key of ['model-k', 'add-tool-k', 'add-skill-k', 'add-ctx-k', 'when-k', 'edit-k', 'budget-k']) expect(await pane.find({ key }), key).toBeUndefined()
  for (const title of ['Tools', 'Skills', 'Context', 'Instructions']) expect(await pane.find({ type: 'Text', text: title }), title).toBeUndefined()
  // An agent has them all.
  await select(pane, 5)
  for (const key of ['name-a', 'disable-a', 'pause-a', 'model-a', 'add-tool-a', 'add-skill-a', 'add-ctx-a', 'when-a', 'edit-a', 'budget-a']) expect(await pane.find({ key }), key).toBeDefined()
  expect(await pane.find({ key: 'check-cmd-a' })).toBeUndefined()
  await pane.unmount()
})

test('Save keeps the command trimmed, an empty one included (the graph then names the problem); the card shows it', async ($, on) => {
  const pane = await openPane($, on, { ...pair('g-cmd'), nodes: [agent('a', 'Implementer', 2), checkCard('k', 'Check 1', 40, '')], edges: [] })
  await select(pane, 45)
  expect(await pane.find({ type: 'Text', text: '$ (no command)' })).toBeUndefined()
  expect(await pane.find({ in: 'canvas', type: 'Text', text: '$ (no command)' })).toBeDefined()
  expect(await pane.find({ key: 'problem-0' })).toBeDefined()
  expect((await pane.find({ key: 'problem-0' }))?.props.label).toBe('! Check 1: Give this check a command.')
  await pane.input({ key: 'check-cmd-k', text: '  npm test && npm run lint  ' })
  expect(stored('g-cmd').nodes[1]!.check).toEqual({ command: 'npm test && npm run lint', timeoutMin: 10 })
  expect(await pane.find({ key: 'problem-0' })).toBeUndefined()
  expect((await cardsOfPane(pane))[1]).toMatchObject({ line: '$ npm test && npm run…', lineTone: 'plain' })
  expect((await pane.find({ key: 'check-cmd-k' }))?.props.value).toBe('npm test && npm run lint')
  await pane.input({ key: 'check-cmd-k', text: '   ' })
  expect(stored('g-cmd').nodes[1]!.check).toEqual({ command: '', timeoutMin: 10 })
  expect((await pane.find({ key: 'problem-0' }))?.props.label).toBe('! Check 1: Give this check a command.')
  await pane.unmount()
})

test('the timeout takes whole minutes from 1 to 60 and ignores anything else', async ($, on) => {
  const pane = await openPane($, on, { ...pair('g-time'), nodes: [agent('a', 'Implementer', 2), checkCard('k', 'Check 1', 40)], edges: [] })
  await select(pane, 45)
  const timeoutMin = () => stored('g-time').nodes[1]!.check!.timeoutMin
  for (const [text, expected] of [['25', 25], [' 7 ', 7], ['60', 60], ['1', 1], ['0', 1], ['61', 1], ['2.5', 1], ['abc', 1], ['', 1], ['-3', 1], ['1e1', 10]] as const) {
    await pane.input({ key: 'check-timeout-k', text })
    expect(timeoutMin(), `"${text}"`).toBe(expected)
  }
  expect((await pane.find({ key: 'check-timeout-k' }))?.props.value).toBe('10')
  await pane.unmount()
})

test('Disable and Pause before work on a check card as on an agent', async ($, on) => {
  const pane = await openPane($, on, { ...pair('g-dis'), nodes: [agent('a', 'Implementer', 2), checkCard('k', 'Check 1', 40)], edges: [] })
  await select(pane, 45)
  await pane.press({ key: 'disable-k' })
  expect(stored('g-dis').nodes[1]).toMatchObject({ disabled: true })
  expect((await pane.find({ key: 'disable-k' }))?.props.label).toBe('Enable')
  await pane.press({ key: 'pause-k' })
  expect(stored('g-dis').nodes[1]).toMatchObject({ pauseBefore: true })
  await pane.input({ key: 'name-k', text: 'Lint' })
  expect(stored('g-dis').nodes[1]!.name).toBe('Lint')
  await pane.unmount()
})

test('the arrows list shows a retry arrow as ↺ <target> · retries <n> with a Retries input (1 to 10)', async ($, on) => {
  const pane = await openPane($, on, loop('g-retries', 2))
  // The agent's handoff keeps its form.
  await select(pane, 5)
  expect(await texts(pane, /━►/)).toEqual(['━► Check 1'])
  expect(await pane.find({ key: 'retries-e1' })).toBeUndefined()
  await select(pane, 45)
  expect(await texts(pane, /↺/)).toEqual(['↺ Implementer · retries 2'])
  expect(await texts(pane, /━►/)).toEqual(['━► Writer'])
  const input = await pane.find({ key: 'retries-e3' })
  expect(input?.props).toMatchObject({ label: 'Retries', value: '2', submitLabel: 'Set' })
  expect(await pane.find({ key: 'retries-e2' })).toBeUndefined()
  expect((await pane.find({ key: 'kind-e3' }))?.props.label).toBe('retry')
  const retries = () => stored('g-retries').edges.find(e => e.id === 'e3')!.retries
  for (const [text, expected] of [['5', 5], ['10', 10], ['1', 1], ['0', 1], ['11', 1], ['2.5', 1], ['x', 1], ['', 1], ['  4 ', 4]] as const) {
    await pane.input({ key: 'retries-e3', text })
    expect(retries(), `"${text}"`).toBe(expected)
  }
  expect(await texts(pane, /↺/)).toEqual(['↺ Implementer · retries 4'])
  expect((await pane.find({ key: 'retries-e3' }))?.props.value).toBe('4')
  await pane.unmount()
})

test('the kind picker offers Retry ↺ on t, beside Handoff on h and Delegate on d', async ($, on) => {
  const chain: Graph = { ...pair('g-pick'), nodes: [agent('a', 'Implementer', 2), agent('b', 'Reviewer', 40), agent('c', 'Writer', 78)], edges: [edge('e1', 'a', 'b', 'handoff'), edge('e2', 'b', 'c', 'handoff')] }
  const pane = await openPane($, on, chain)
  // Back to the start of the chain: a delegate or a retry arrow can go there, a handoff would close a loop.
  await pane.post({ events: [{ kind: 'wire', from: 'c', to: 'a' }] })
  expect((await pane.find({ key: 'as-retry' }))?.props).toMatchObject({ label: 'Retry ↺', hotkey: 't' })
  expect((await pane.find({ key: 'as-delegate' }))?.props).toMatchObject({ label: 'Delegate ┄►', hotkey: 'd' })
  expect(await pane.find({ key: 'as-handoff' })).toBeUndefined()
  await pane.press({ key: 'cancel-connect' })
  // Forward: a handoff or a delegate arrow can, a retry arrow cannot.
  await pane.post({ events: [{ kind: 'wire', from: 'a', to: 'c' }] })
  expect((await pane.find({ key: 'as-handoff' }))?.props).toMatchObject({ label: 'Handoff ━►', hotkey: 'h' })
  expect(await pane.find({ key: 'as-retry' })).toBeUndefined()
  await pane.unmount()
})

test('the kind picker: a valid retry connects with the default number of retries', async ($, on) => {
  const g: Graph = { ...loop('g-pick2'), edges: [edge('e1', 'a', 'k', 'handoff'), edge('e2', 'k', 'w', 'handoff')] }
  const pane = await openPane($, on, g)
  await pane.post({ events: [{ kind: 'wire', from: 'k', to: 'a' }] })
  expect(await texts(pane, /Connect Check 1 → Implementer as:/)).toHaveLength(1)
  expect(await texts(pane, /^Handoff ━► — Handoff arrows form a loop through this agent/)).toHaveLength(1)
  expect(await texts(pane, /^Delegate ┄► — A check card can't delegate or be delegated to\.$/)).toHaveLength(1)
  await pane.press({ key: 'as-retry' })
  expect(stored('g-pick2').edges).toHaveLength(3)
  expect(stored('g-pick2').edges[2]).toMatchObject({ from: 'k', to: 'a', kind: 'retry', retries: 3 })
  // The picker is gone; the check is selected, with its arrow in the list.
  expect(await pane.find({ key: 'as-retry' })).toBeUndefined()
  expect(await texts(pane, /↺/)).toEqual(['↺ Implementer · retries 3'])
  await pane.unmount()
})

test('the kind picker refuses a retry arrow with the first new problem, as for the other kinds', async ($, on) => {
  const g: Graph = { ...loop('g-refuse'), edges: [edge('e1', 'a', 'k', 'handoff'), edge('e2', 'k', 'w', 'handoff')] }
  const pane = await openPane($, on, g)
  // Forward, to a card that is not before it.
  await pane.post({ events: [{ kind: 'wire', from: 'a', to: 'w' }] })
  expect(await pane.find({ key: 'as-retry' })).toBeUndefined()
  expect(await texts(pane, /^Retry ↺ — /)).toEqual(['Retry ↺ — A retry arrow must point back to an agent that hands work on to this card.'])
  expect(await pane.find({ key: 'as-handoff' })).toBeDefined()
  await pane.press({ key: 'cancel-connect' })
  // To a check card.
  await pane.post({ events: [{ kind: 'wire', from: 'w', to: 'k' }] })
  expect(await texts(pane, /^Retry ↺ — /)).toEqual(['Retry ↺ — A retry arrow must point to an agent, not a check.'])
  await pane.press({ key: 'cancel-connect' })
  expect(stored('g-refuse').edges).toHaveLength(2)
  await pane.unmount()
})

test('the kind picker refuses a second retry arrow out of one card', async ($, on) => {
  const pane = await openPane($, on, loop('g-refuse2'))
  await pane.post({ events: [{ kind: 'wire', from: 'k', to: 'w' }] })
  expect(await texts(pane, /^Retry ↺ — /)).toEqual(['Retry ↺ — Only one retry arrow can leave a card.'])
  expect(await pane.find({ key: 'as-retry' })).toBeUndefined()
  expect(stored('g-refuse2').edges).toHaveLength(3)
  await pane.unmount()
})

test('retyping an arrow cycles handoff, delegate, retry and back, from the inspector and from the canvas', async ($, on) => {
  const pane = await openPane($, on, pair('g-cycle'))
  await select(pane, 5)
  const kind = () => stored('g-cycle').edges[0]!
  const seen: string[] = []
  for (let i = 0; i < 3; i++) {
    await pane.press({ key: 'kind-e1' })
    seen.push(kind().kind)
  }
  expect(seen).toEqual(['delegate', 'retry', 'handoff'])
  // A retry arrow starts with the default, and loses the number when it is another kind.
  await pane.press({ key: 'kind-e1' })
  await pane.press({ key: 'kind-e1' })
  expect(kind()).toMatchObject({ kind: 'retry', retries: 3 })
  await pane.post({ events: [{ kind: 'edge', edge: 'e1', action: 'retype' }] })
  expect(kind().kind).toBe('handoff')
  expect(kind().retries).toBeUndefined()
  await pane.post({ events: [{ kind: 'edge', edge: 'e1', action: 'retype' }] })
  await pane.post({ events: [{ kind: 'edge', edge: 'e1', action: 'retype' }] })
  expect(kind()).toMatchObject({ kind: 'retry', retries: 3 })
  await pane.unmount()
})

test('the character canvas draws a retry arrow dotted and orange, with ↺ <retries> at its start', async ($, on) => {
  const g = loop('g-draw', 4)
  const pane = await openPane($, on, g)
  const canvas = JSON.parse(JSON.stringify((await pane.find({ key: 'canvas' }))?.props)).props as { vector: boolean; layer: Array<Array<{ t: string; s: string; e?: string; i?: number }>> }
  expect(canvas.vector).toBe(false)
  const segs = canvas.layer.flat().filter(s => s.s === 'r')
  expect(segs.length).toBeGreaterThan(0)
  expect(segs.every(s => s.e === 'e3')).toBe(true)
  expect(segs.some(s => s.t.includes('┅'))).toBe(true)
  const label = segs.find(s => s.t === '↺ 4')
  expect(label).toBeDefined()
  expect(label!.i).toBeUndefined()
  // Drawn in the arrow's orange, and bold when the arrow is hot.
  const colours = (await pane.findAll({ in: 'canvas', type: 'Text', text: /^([┅┇]|↺ 4)/ })).map(t => t.props.color)
  expect(colours.length).toBeGreaterThan(0)
  expect(new Set(colours)).toEqual(new Set(['#d97757']))
  // Picking the label picks the arrow.
  const y = canvas.layer.findIndex(row => row.some(s => s.t === '↺ 4'))
  const row = canvas.layer[y]!
  const x = row.slice(0, row.findIndex(s => s.t === '↺ 4')).reduce((sum, s) => sum + s.t.length, 0)
  await pane.pointer({ type: 'down', x, y, button: 'left' })
  await pane.pointer({ type: 'up', x, y, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e3' })).toBeDefined()
  await pane.unmount()
})

test('the vector canvas draws it dotted 2 4 in orange, with its text over the layer', async ($, on) => {
  const pane = await openPane($, on, loop('g-vec', 6), 'desktop')
  const source = (await pane.findAll({ type: 'Svg' })).map(x => String(x.props.source)).join('')
  expect(source).toContain('stroke-dasharray="2 4"')
  expect(source).toContain('stroke="#d97757"')
  const [retry] = (await edgesOfPane(pane)).filter(e => e.kind === 'retry')
  expect(retry!.tag).toMatchObject({ t: '↺ 6' })
  const tag = await pane.find({ in: 'canvas', key: 'retry-tag-e3' })
  expect(tag).toBeDefined()
  expect(tag?.props).toMatchObject({ left: retry!.tag!.x, top: retry!.tag!.y })
  expect((await pane.find({ in: 'canvas', type: 'Text', text: '↺ 6' }))?.props.color).toBe('#d97757')
  await pane.unmount()
})

test('From here on a loop card other than the target names the target and runs the whole loop', async ($, on) => {
  const pane = await openPane($, on, loop('g-from'))
  const label = async (x: number, id: string) => {
    await select(pane, x)
    return (await pane.find({ key: `run-from-${id}` }))?.props.label
  }
  expect(await label(5, 'a')).toBe('▶ From here')
  expect(await label(45, 'k')).toBe('▶ From here (from Implementer)')
  expect(await label(82, 'w')).toBe('▶ From here')
  const cards = await cardsOfPane(pane)
  expect(cards.map(c => c.runFrom)).toEqual([undefined, 'Implementer', undefined])
  expect(cards.map(c => c.canRunFrom)).toEqual([true, true, true])
  await pane.unmount()
})

test('From here on the check card runs the whole loop from its target: the plan names it and the record says from Implementer', async ($, on) => {
  const pane = await openPane($, on, loop('g-from-run'))
  await select(pane, 45)
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  const before = ends
  await pane.press({ key: 'run-from-k' })
  expect(await texts(pane, /^Runs /)).toEqual(['Runs Implementer, Check 1, Writer'])
  await untilEnded(before)
  // The run began with the target (the mocks start no agent, so it failed there).
  expect(spawns).toHaveLength(1)
  expect(spawns[0]).toContain('implementer')
  const [record] = recordsOf('g-from-run')
  expect(record).toMatchObject({ mode: 'from-here', fromNode: 'a' })
  expect(Object.keys(record!.nodes).sort()).toEqual(['a', 'k', 'w'])
  await pane.unmount()
})

// ---- a Local run of the loop, scripted ----

type CheckStep = { code: number; out: string }
type Scripted = { view: RunView; record: RunRecord; prompts: Record<string, string[]>; commands: string[][] }

// Runs the graph on the Local backend with scripted parts beneath it: each agent is answered at once, by name, with the
// next of its answers, and each run of a check's command ends as the script says (the model and the shell are all that is
// scripted: the backend, the check cards, the loop and the run's record are the mod's own).
async function scriptedRun(g: Graph, task: string, answers: Record<string, string[]>, checks: CheckStep[]): Promise<Scripted> {
  const completions = createCompletions()
  const prompts: Record<string, string[]> = {}
  const commands: string[][] = []
  let started = 0
  const given = new Map<string, number>()
  const deps: LocalDeps = {
    register: async () => undefined,
    spawn: async ({ prompt, subagentType }) => {
      const name = Object.keys(answers).find(n => subagentType.toLowerCase().includes(n.toLowerCase()))!
      prompts[name] = [...(prompts[name] ?? []), prompt]
      const n = given.get(name) ?? 0
      given.set(name, n + 1)
      const agentId = `ag${++started}`
      completions.complete({ agentId, answer: answers[name]![Math.min(n, answers[name]!.length - 1)]!, reason: 'answer' })
      return { agentId }
    },
    stopAgent: async () => undefined,
    instructions: async node => `Instructions of ${node.name}.`,
    context: { kind: async () => 'missing', read: async () => '', files: async () => [] },
    completions,
    guard: createGuard(),
    command: {
      spawn: argv => {
        commands.push([...argv])
        const step = checks.shift() ?? { code: 0, out: '' }
        return (async function* (): AsyncGenerator<CommandChunk, CommandEnd> {
          if (step.out !== '') yield { stream: 'stdout', text: step.out }
          return { code: step.code, signal: null }
        })()
      },
      isWindows: async () => false,
      wait: () => new Promise<void>(() => {}),
    },
  }
  let last: RunView | undefined
  let t = 1_000_000
  const result = await runGraph(g, task, createLocalBackend(g, deps), { onUpdate: v => void (last = v), now: () => (t += 1000) })
  expect('problems' in result, 'the graph can run').toBe(false)
  const view = last!
  const record = recordOf(g, view, { id: `run-${g.id}`, mode: 'full', startedAt: 1_000_000, endedAt: t, ending: 'finished', fingerprints: {}, files: {} })
  return { view, record, prompts, commands }
}

test('a Local run of Implementer -> Check (retry ↺ 2 to Implementer) -> Writer: the check fails once, then passes; the pane shows round 2/3 and the Rounds', async ($, on) => {
  const g = loop('g-e2e', 2)
  const run = await scriptedRun(
    g, 'Make sum work', { Implementer: ['IMPL-1', 'IMPL-2'], Writer: ['WRITTEN'] },
    [{ code: 1, out: 'FAIL src/sum.test.ts\n  expected 3, got 4\n' }, { code: 0, out: 'all green\n' }],
  )
  // The check ran its command twice; the Implementer ran twice, the second time with why the check failed.
  expect(run.commands).toEqual([['sh', '-c', 'npm test'], ['sh', '-c', 'npm test']])
  expect(run.prompts['Implementer']).toEqual([
    'Make sum work',
    'Make sum work\n\n## Check 1 failed (retry 1 of 2)\n\n`npm test` exited 1.\n\n```\nFAIL src/sum.test.ts\n  expected 3, got 4\n```\n\n## Your answer last round\n\nIMPL-1\n\nFix what failed, then answer as before.',
  ])
  expect(run.prompts['Writer']).toHaveLength(1)
  expect(run.prompts['Writer']![0]).toContain('## Handoff from Check 1')
  expect(run.prompts['Writer']![0]).toContain('`npm test` exited 0.')
  expect(run.view.nodes['k']).toMatchObject({ status: 'done', round: 2 })
  expect(run.view.nodes['w']).toMatchObject({ status: 'done', output: 'WRITTEN' })

  // The pane opens that run.
  const pane = await openPane($, on, g, 'terminal', [run.record])
  await pane.press({ key: `run-${run.record.id}` })
  expect(await pane.find({ type: 'Text', text: /^Viewing the run from / })).toBeDefined()
  const cards = await cardsOfPane(pane)
  expect(cards.map(c => c.line)).toEqual(['IMPL-2 · round 2/3', 'passed · round 2/3', 'WRITTEN'])
  expect(cards.map(c => c.round)).toEqual(['round 2/3', 'round 2/3', undefined])

  // The judge's inspector lists its rounds; the target's does not.
  await select(pane, 45)
  expect(await pane.find({ type: 'Text', text: 'Rounds' })).toBeDefined()
  const rounds = await texts(pane, /^[✓✗] round /)
  expect(rounds).toHaveLength(2)
  expect(rounds[0]).toMatch(/^✗ round 1 · `npm test` exited 1\. · \d\d:\d\d$/)
  expect(rounds[1]).toMatch(/^✓ round 2 · passed · \d\d:\d\d$/)
  await select(pane, 5)
  expect(await pane.find({ type: 'Text', text: 'Rounds' })).toBeUndefined()

  // The timeline shows one bar for each card (its latest round).
  await pane.press({ key: 'timeline' })
  for (const id of ['a', 'k', 'w']) expect(await pane.findAll({ key: `tl-${id}` }), id).toHaveLength(1)
  await pane.unmount()
})

test('out of retries the check ends failed with the reason and the Writer is skipped; the Rounds say how each round went', async ($, on) => {
  const g = loop('g-out', 1)
  const run = await scriptedRun(g, 'Make sum work', { Implementer: ['IMPL-1', 'IMPL-2'], Writer: ['WRITTEN'] }, [{ code: 1, out: 'one\n' }, { code: 2, out: 'two\n' }])
  expect(run.prompts['Writer']).toBeUndefined()
  expect(run.view.nodes['k']).toMatchObject({ status: 'failed', error: 'Still failing after 1 retries: `npm test` exited 2.', round: 2 })
  const pane = await openPane($, on, g, 'terminal', [run.record])
  await pane.press({ key: `run-${run.record.id}` })
  expect((await cardsOfPane(pane)).map(c => c.line)).toEqual(['IMPL-2 · round 2/2', 'Still fai… · round 2/2', 'skipped'])
  await select(pane, 45)
  // Its error shows in the card's status and again under Last run.
  expect((await texts(pane, /Still failing after 1 retries: `npm test` exited 2\./)).length).toBeGreaterThan(0)
  const rounds = await texts(pane, /^[✓✗] round /)
  expect(rounds).toHaveLength(2)
  expect(rounds[0]).toMatch(/^✗ round 1 · `npm test` exited 1\. · \d\d:\d\d$/)
  expect(rounds[1]).toMatch(/^✗ round 2 · `npm test` exited 2\. · \d\d:\d\d$/)
  await pane.unmount()
})

test('a reviewer agent that sends work back shows its rounds too', async ($, on) => {
  // Implementer -> Reviewer, and the Reviewer sends work back (3 retries).
  const g: Graph = pair('g-review', [edge('e1', 'a', 'b', 'handoff'), edge('e2', 'b', 'a', 'retry', 3)])
  const run = await scriptedRun(g, 'Do it', { Implementer: ['DRAFT-1', 'DRAFT-2'], Reviewer: ['Needs tests.\nVERDICT: fail', 'Fine.\nVERDICT: pass'] }, [])
  const pane = await openPane($, on, g, 'terminal', [run.record])
  await pane.press({ key: `run-${run.record.id}` })
  expect((await cardsOfPane(pane)).map(c => c.line)).toEqual(['DRAFT-2 · round 2/4', 'Fine. · round 2/4'])
  await select(pane, 45)
  const rounds = await texts(pane, /^[✓✗] round /)
  expect(rounds[0]).toMatch(/^✗ round 1 · Needs tests\. · \d\d:\d\d$/)
  expect(rounds[1]).toMatch(/^✓ round 2 · passed · \d\d:\d\d$/)
  await pane.unmount()
})

test('a loop card that is running keeps its round beside the elapsed time, within the card', async ($, on) => {
  const g = loop('g-live', 2)
  const view: RunView = {
    graphId: g.id, graphName: g.name, isRunning: false, task: 'T',
    nodes: { a: { status: 'running', startedAt: 1_000_000 - 5000, round: 2 }, k: { status: 'waiting', round: 2 }, w: { status: 'waiting' } },
  }
  const record = recordOf(g, view, { id: 'run-live', mode: 'full', startedAt: 1_000_000 - 9000, endedAt: 1_000_000, ending: 'stopped', fingerprints: {}, files: {} })
  const withCost = recordOf(g, { ...view, nodes: { ...view.nodes, a: { ...view.nodes['a']!, costUsd: 0.12 } } }, { id: 'run-cost', mode: 'full', startedAt: 1_000_000 - 9000, endedAt: 1_000_001, ending: 'stopped', fingerprints: {}, files: {} })
  const pane = await openPane($, on, g, 'terminal', [record, withCost])
  await pane.press({ key: 'run-run-live' })
  expect((await pane.findAll({ in: 'canvas', type: 'Text', text: /· round 2\/3$/ })).map(t => t.text).sort()).toEqual(['0:05 · round 2/3', 'waiting · round 2/3'])
  await pane.press({ key: 'run-run-cost' })
  const lines = (await pane.findAll({ in: 'canvas', type: 'Text', text: /· round 2\/3$/ })).map(t => t.text)
  expect(lines.every(t => Array.from(t).length <= 22)).toBe(true)
  expect(lines.some(t => t.startsWith('0:05 · '))).toBe(true)
  await pane.unmount()
})

// Picks the arrow under a cell of the character canvas and says which arrow's buttons opened.
async function pickAt(pane: Pane, x: number, y: number) {
  await pane.pointer({ type: 'down', x, y, button: 'left' })
  await pane.pointer({ type: 'up', x, y, button: 'left' })
  await pane.advance(16)
  return (await pane.findAll({ in: 'canvas', type: 'Button', text: /^⇄ / })).map(b => String(b.key))
}

const laneGraph = (id: string, k: [number, number]): Graph => ({
  ...loop(id), nodes: [agent('a', 'Implementer', 2), checkCard('k', 'Check 1', k[0], 'npm test', k[1])], edges: [edge('e1', 'a', 'k', 'handoff'), edge('e3', 'k', 'a', 'retry', 2)],
})

test('side by side (as + Agent then + Check place them), both the handoff and the retry arrow are seen and can be picked', async ($, on) => {
  const side = await openPane($, on, laneGraph('g-lane-side', [34, 1]))
  const rows = JSON.parse(JSON.stringify((await side.find({ key: 'canvas' }))?.props)).props.layer as Array<Array<{ t: string }>>
  const text = (y: number) => rows[y]!.map(s => s.t).join('')
  expect(text(3)).toContain('►')
  expect(text(4)).toContain('◄')
  expect(text(4)).toContain('↺ 2')
  expect(await pickAt(side, 29, 3)).toEqual(['edge-kind-e1'])
  expect(await pickAt(side, 29, 4)).toEqual(['edge-kind-e3'])
  // The label belongs to the retry arrow.
  expect(await pickAt(side, 32, 4)).toEqual(['edge-kind-e3'])
  await side.unmount()
})

test('stacked in one column, both the handoff and the retry arrow are seen and can be picked', async ($, on) => {
  const stack = await openPane($, on, laneGraph('g-lane-stack', [2, 8]))
  const rows = JSON.parse(JSON.stringify((await stack.find({ key: 'canvas' }))?.props)).props.layer as Array<Array<{ t: string }>>
  expect(rows[7]!.map(s => s.t).join('')).toContain('▼')
  expect(rows[6]!.map(s => s.t).join('')).toContain('▲')
  expect(await pickAt(stack, 15, 6)).toEqual(['edge-kind-e1'])
  expect(await pickAt(stack, 18, 7)).toEqual(['edge-kind-e3'])
  await stack.unmount()
})

test('a check card has no Edit button on the canvas and no input to edit in Last run; an agent keeps them', async ($, on) => {
  const g = loop('g-nocheckedit')
  const run = await scriptedRun(g, 'T', { Implementer: ['IMPL'], Writer: ['WRITTEN'] }, [])
  const pane = await openPane($, on, g, 'terminal', [run.record])
  expect(await pane.find({ in: 'canvas', key: 'card-edit-a' })).toBeDefined()
  expect(await pane.find({ in: 'canvas', key: 'card-edit-k' })).toBeUndefined()
  expect(await pane.find({ in: 'canvas', key: 'card-run-k' })).toBeDefined()
  // Last run (the newest saved entry of the card, shown when a run is not going).
  await select(pane, 5)
  expect(await pane.find({ type: 'Text', text: /^Last run/ })).toBeDefined()
  expect(await pane.find({ key: 'last-input-edit' })).toBeDefined()
  await select(pane, 45)
  expect(await pane.find({ type: 'Text', text: /^Last run/ })).toBeDefined()
  expect(await pane.find({ key: 'last-input-edit' })).toBeUndefined()
  expect(await pane.find({ key: 'run-with-input' })).toBeUndefined()
  await pane.unmount()
})

test('a check paused before it offers Continue but no Edit input', async ($, on) => {
  const g: Graph = { ...loop('g-pausedcheck'), nodes: [{ ...checkCard('k', 'Check 1', 2, 'true'), pauseBefore: true }], edges: [] }
  const pane = await openPane($, on, g)
  await pane.input({ key: 'task', text: 'Go', kind: 'change' })
  const before = ends
  await pane.press({ key: 'run' })
  for (let i = 0; i < 100 && (await pane.find({ type: 'Text', text: 'Paused before Check 1' })) === undefined; i++) {
    await clock.advance(1000)
    await tick()
  }
  expect(await pane.find({ type: 'Text', text: 'Paused before Check 1' })).toBeDefined()
  expect(await pane.find({ key: 'continue' })).toBeDefined()
  expect(await pane.find({ key: 'input-edit' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /Instruction edits apply/ })).toBeUndefined()
  await pane.press({ key: 'stop' })
  await untilEnded(before)
  await pane.unmount()
})
