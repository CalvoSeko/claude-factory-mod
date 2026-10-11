import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import type { Graph, NodeRecord, RunIndex, RunRecord } from '../types'

const node = (id: string, name: string, x: number) => ({
  id, name, x, y: 1, instructionsFile: `./.claude/agent-graph/g1/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
const graph: Graph = {
  id: 'g1', name: 'Flow', description: '', backend: 'local', layout: 2,
  nodes: [node('a', 'Researcher', 2), node('b', 'Writer', 40)],
  edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }],
}
const BAND = {
  plugin: 'agent-graph', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const
const PANE = {
  plugin: 'agent-graph', component: 'Pane', requestId: 'agent-graph',
  props: { title: 'Agent Graph', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Args = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>

// The commands the mod ran since the last pane was opened.
let ran: string[][] = []
// The mock clock of the last pane opened: it holds the `clock.after` a run is started with.
let clock: MockClock

async function openPane($: Args[0], on: Args[1], g: Graph = graph, surface: 'terminal' | 'desktop' = 'terminal', extra: Record<string, unknown> = {}) {
  mock.store(on, { graphs: [{ id: g.id, name: 'Flow' }], [`graph:${g.id}`]: g, ...extra })
  clock = mock.clock(on)
  ran = []
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.read', () => ({ value: 'Research the topic well.\nThen stop.' }) as never)
  on('process.run', (_$, e) => {
    ran.push((e as unknown as { argv: string[] }).argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
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

test('agents are drawn as cards with their buttons', async ($, on) => {
  const pane = await openPane($, on)
  expect(await pane.find({ in: 'canvas', text: /Researcher/ })).toBeDefined()
  expect(await pane.find({ in: 'canvas', key: 'card-del-a' })).toBeDefined()
  expect(await pane.find({ in: 'canvas', key: 'card-edit-b' })).toBeDefined()
  expect(await pane.find({ in: 'canvas', key: 'card-run-a' })).toBeDefined()
  await pane.unmount()
})

test('a press on the button row neither selects nor drags; the body selects', async ($, on) => {
  const pane = await openPane($, on)
  await pane.pointer({ type: 'down', x: 5, y: 4, button: 'left' })
  await pane.pointer({ type: 'up', x: 5, y: 4, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ key: 'name-a' })).toBeUndefined()
  await pane.pointer({ type: 'down', x: 5, y: 2, button: 'left' })
  await pane.pointer({ type: 'up', x: 5, y: 2, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ key: 'name-a' })).toBeDefined()
  await pane.unmount()
})

test('dragging from a port onto another card asks for the arrow kind', async ($, on) => {
  const pane = await openPane($, on)
  await pane.pointer({ type: 'down', x: 27, y: 3, button: 'left' })
  await pane.pointer({ type: 'move', x: 35, y: 3, button: 'left' })
  expect(await pane.find({ in: 'canvas', text: /┄/ })).toBeDefined()
  await pane.pointer({ type: 'move', x: 45, y: 3, button: 'left' })
  await pane.pointer({ type: 'up', x: 45, y: 3, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ key: 'as-handoff' })).toBeDefined()
  await pane.unmount()
})

test('vector mode: the connect wire is a clipped Box of exactly the leg cells', async ($, on) => {
  const pane = await openPane($, on, graph, 'desktop')
  await pane.pointer({ type: 'down', x: 27, y: 3, button: 'left' })
  await pane.pointer({ type: 'move', x: 35, y: 3, button: 'left' })
  const wire = await pane.find({ in: 'canvas', key: 'wire-h' })
  expect(wire?.props).toMatchObject({ left: 28, width: 8, height: 1, overflow: 'hidden' })
  await pane.pointer({ type: 'up', x: 35, y: 3, button: 'left' })
  await pane.unmount()
})

const canvasProps = async (pane: Awaited<ReturnType<typeof openPane>>) => JSON.stringify((await pane.find({ key: 'canvas' }))?.props)

test('the delete button asks twice: the first press arms it, the second deletes', async ($, on) => {
  const pane = await openPane($, on)
  await pane.press({ key: 'card-del-b' })
  await pane.advance(16)
  expect(await canvasProps(pane)).toContain('Writer')
  expect((await pane.find({ in: 'canvas', key: 'card-del-b' }))?.props.label).toBe('Delete?')
  await pane.press({ key: 'card-del-b' })
  await pane.advance(16)
  expect(await canvasProps(pane)).not.toContain('Writer')
  await pane.unmount()
})

test('an armed delete button disarms after three seconds', async ($, on) => {
  const pane = await openPane($, on)
  await pane.press({ key: 'card-del-b' })
  await pane.advance(16)
  expect((await pane.find({ in: 'canvas', key: 'card-del-b' }))?.props.label).toBe('Delete?')
  await pane.advance(3000)
  expect((await pane.find({ in: 'canvas', key: 'card-del-b' }))?.props.label).toBe('✕')
  await pane.press({ key: 'card-del-b' })
  await pane.advance(16)
  expect(await canvasProps(pane)).toContain('Writer')
  await pane.unmount()
})

test('a pointer press elsewhere disarms the delete button', async ($, on) => {
  const pane = await openPane($, on)
  await pane.press({ key: 'card-del-b' })
  await pane.pointer({ type: 'down', x: 5, y: 2, button: 'left' })
  await pane.pointer({ type: 'up', x: 5, y: 2, button: 'left' })
  await pane.advance(16)
  expect((await pane.find({ in: 'canvas', key: 'card-del-b' }))?.props.label).toBe('✕')
  await pane.unmount()
})

test('the canvas is never narrower than its widest card', async ($, on) => {
  const wide: Graph = { ...graph, nodes: [node('a', 'Researcher', 2), node('b', 'Writer', 100)] }
  const pane = await openPane($, on, wide)
  expect(((await pane.find({ key: 'canvas' }))?.props as { width?: number }).width).toBeGreaterThanOrEqual(127)
  await pane.unmount()
})

test('hovering a card shows its instructions as a tip', async ($, on) => {
  const pane = await openPane($, on)
  expect(await pane.find({ in: 'canvas', text: /Research the topic well/ })).toBeUndefined()
  await pane.pointer({ type: 'move', x: 6, y: 2 })
  expect(await pane.find({ in: 'canvas', text: /Research the topic well/ })).toBeDefined()
  await pane.pointer({ type: 'leave', x: 6, y: 2 })
  expect(await pane.find({ in: 'canvas', text: /Research the topic well/ })).toBeUndefined()
  await pane.unmount()
})

test('hovering an arrow shows its label', async ($, on) => {
  const pane = await openPane($, on)
  expect(await pane.find({ in: 'canvas', text: /handoff · Researcher → Writer/ })).toBeUndefined()
  await pane.pointer({ type: 'move', x: 30, y: 3 })
  expect(await pane.find({ in: 'canvas', text: /handoff · Researcher → Writer/ })).toBeDefined()
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeUndefined()
  await pane.pointer({ type: 'move', x: 10, y: 12 })
  expect(await pane.find({ in: 'canvas', text: /handoff · Researcher → Writer/ })).toBeUndefined()
  await pane.unmount()
})

test('clicking an arrow selects it without changing the selected card', async ($, on) => {
  const pane = await openPane($, on)
  await pane.pointer({ type: 'down', x: 5, y: 2, button: 'left' })
  await pane.pointer({ type: 'up', x: 5, y: 2, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ key: 'name-a' })).toBeDefined()
  await pane.pointer({ type: 'down', x: 30, y: 3, button: 'left' })
  await pane.pointer({ type: 'up', x: 30, y: 3, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeDefined()
  expect(await pane.find({ in: 'canvas', key: 'edge-rev-e1' })).toBeDefined()
  expect(await pane.find({ key: 'name-a' }), 'card selection kept').toBeDefined()
  await pane.pointer({ type: 'down', x: 10, y: 12, button: 'left' })
  await pane.pointer({ type: 'up', x: 10, y: 12, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeUndefined()
  await pane.unmount()
})

test('arrow buttons reach the mod; delete takes two presses', async ($, on) => {
  const pane = await openPane($, on)
  const props = async () => JSON.stringify((await pane.find({ key: 'canvas' }))?.props)
  await pane.pointer({ type: 'down', x: 30, y: 3, button: 'left' })
  await pane.pointer({ type: 'up', x: 30, y: 3, button: 'left' })
  await pane.press({ key: 'edge-kind-e1' })
  await pane.advance(16)
  expect(await props()).toContain('"kind":"delegate"')
  await pane.press({ key: 'edge-del-e1' })
  await pane.advance(16)
  expect((await pane.find({ in: 'canvas', key: 'edge-del-e1' }))?.props.label).toBe('Delete?')
  expect(await props()).toContain('"id":"e1"')
  await pane.press({ key: 'edge-del-e1' })
  await pane.advance(16)
  expect(await props()).not.toContain('"id":"e1"')
  await pane.unmount()
})

test('delete and the arrow keys are swallowed while an arrow is selected', async ($, on) => {
  const pane = await openPane($, on)
  await pane.pointer({ type: 'down', x: 5, y: 2, button: 'left' })
  await pane.pointer({ type: 'up', x: 5, y: 2, button: 'left' })
  await pane.advance(16)
  await pane.pointer({ type: 'down', x: 30, y: 3, button: 'left' })
  await pane.pointer({ type: 'up', x: 30, y: 3, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeDefined()
  await pane.key({ key: 'delete' })
  await pane.key({ key: 'right' })
  await pane.advance(16)
  expect(await canvasProps(pane)).toContain('Researcher')
  expect(await canvasProps(pane)).toContain('"x":2,')
  await pane.pointer({ type: 'down', x: 10, y: 12, button: 'left' })
  await pane.pointer({ type: 'up', x: 10, y: 12, button: 'left' })
  await pane.advance(16)
  await pane.pointer({ type: 'down', x: 5, y: 2, button: 'left' })
  await pane.pointer({ type: 'up', x: 5, y: 2, button: 'left' })
  await pane.advance(16)
  await pane.key({ key: 'delete' })
  await pane.advance(16)
  expect(await canvasProps(pane)).not.toContain('Researcher')
  await pane.unmount()
})

test('the arrow popup sits clear of the cards, so a click on a card button reaches the card', async ($, on) => {
  const pane = await openPane($, on)
  await pane.pointer({ type: 'down', x: 30, y: 3, button: 'left' })
  await pane.pointer({ type: 'up', x: 30, y: 3, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeDefined()
  await pane.pointer({ type: 'down', x: 45, y: 4, button: 'left' })
  await pane.pointer({ type: 'up', x: 45, y: 4, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeUndefined()
  await pane.unmount()
})

test('vector mode: the canvas draws no arrow characters in its layer rows', async ($, on) => {
  const pane = await openPane($, on, graph, 'desktop')
  for (const ch of ['━', '◄', '▼', '▲', '┄', '┆', '┃']) expect(await pane.find({ in: 'canvas', type: 'Text', text: ch })).toBeUndefined()
  // The only ► left are the cards' ports (their own Boxes), not arrowheads in the layer rows.
  expect(await pane.find({ in: 'canvas', key: 'port-a' })).toBeDefined()
  await pane.unmount()
})

test('vector mode: hovering and clicking the curve shows the label and the popup', async ($, on) => {
  const pane = await openPane($, on, graph, 'desktop')
  expect(await pane.find({ in: 'canvas', text: /handoff · Researcher → Writer/ })).toBeUndefined()
  await pane.pointer({ type: 'move', x: 33, y: 3 })
  expect(await pane.find({ in: 'canvas', text: /handoff · Researcher → Writer/ })).toBeDefined()
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeUndefined()
  await pane.pointer({ type: 'move', x: 10, y: 12 })
  expect(await pane.find({ in: 'canvas', text: /handoff · Researcher → Writer/ })).toBeUndefined()
  await pane.pointer({ type: 'down', x: 33, y: 3, button: 'left' })
  await pane.pointer({ type: 'up', x: 33, y: 3, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeDefined()
  await pane.unmount()
})

test('vector mode: a pointer well off the curve misses the arrow', async ($, on) => {
  const pane = await openPane($, on, graph, 'desktop')
  await pane.pointer({ type: 'move', x: 33, y: 6 })
  expect(await pane.find({ in: 'canvas', text: /handoff · Researcher → Writer/ })).toBeUndefined()
  await pane.unmount()
})

const BASE_ALT = 'Agent graph arrows'
const GLOW_ALT = 'Highlighted agent graph arrows'
const glowOf = async (pane: { findAll: (q: { type: 'Svg' }) => Promise<Array<{ props: Record<string, unknown> }>> }) =>
  (await pane.findAll({ type: 'Svg' })).find(x => x.props.alt === GLOW_ALT)?.props.source as string | undefined

test('vector mode: the focused arrow glows in its own Svg and stops when the pointer leaves; the base never changes', async ($, on) => {
  const pane = await openPane($, on, graph, 'desktop')
  const glow = async () => (await pane.findAll({ type: 'Svg' })).find(x => x.props.alt === GLOW_ALT)?.props.source
  const base = async () => String((await pane.findAll({ type: 'Svg' })).find(x => x.props.alt === BASE_ALT)?.props.source)
  const before = await base()
  expect(await glow()).toBeUndefined()
  await pane.pointer({ type: 'move', x: 33, y: 3 })
  await pane.advance(16)
  expect(String(await glow())).toContain('#f0c040')
  expect(await base()).toBe(before)
  await pane.pointer({ type: 'move', x: 10, y: 12 })
  await pane.advance(16)
  expect(await glow()).toBeUndefined()
  await pane.pointer({ type: 'move', x: 45, y: 2 })
  await pane.advance(16)
  expect(String(await glow()), 'hovering a card glows its arrows').toContain('#f0c040')
  expect(await base()).toBe(before)
  await pane.unmount()
})

test('vector mode: the layers are pinned to the canvas size so a narrow pane cannot scale them', async ($, on) => {
  const pane = await openPane($, on, graph, 'desktop')
  const wrap = await pane.find({ key: 'canvas-wrap' })
  expect(wrap?.props).toMatchObject({ flexShrink: 0, overflow: 'hidden' })
  const { width, height } = wrap!.props as { width: number; height: number }
  expect(await pane.find({ key: 'vectors-layer' })).toBeDefined()
  expect((await pane.find({ key: 'vectors-layer' }))?.props).toMatchObject({ width, height, position: 'absolute' })
  await pane.pointer({ type: 'move', x: 33, y: 3 })
  await pane.advance(16)
  expect((await pane.find({ key: 'vector-glow-layer' }))?.props).toMatchObject({ width, height, position: 'absolute' })
  await pane.unmount()
})

test('vector mode: a graph without arrows has no Svg at all', async ($, on) => {
  const pane = await openPane($, on, { ...graph, edges: [] }, 'desktop')
  expect(await pane.find({ type: 'Svg' })).toBeUndefined()
  await pane.unmount()
})

test('vector mode: an idle base is a plain image, not a frame', async ($, on) => {
  const pane = await openPane($, on, graph, 'desktop')
  expect((await pane.findAll({ type: 'Svg' })).map(x => x.props.isInteractive)).toEqual([false])
  await pane.unmount()
})

test('vector mode: a glow left in the stored focus is cleared when the canvas is mounted again', async ($, on) => {
  const first = await openPane($, on, graph, 'desktop')
  await first.post({ events: [{ kind: 'focus', edge: 'e1', card: null }] })
  expect(await glowOf(first)).toContain('#f0c040')
  await first.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await glowOf(again)).toContain('#f0c040')
  await again.advance(16)
  expect(await glowOf(again)).toBeUndefined()
  await again.unmount()
})

const cardsIn = async (pane: Awaited<ReturnType<typeof openPane>>) =>
  (JSON.parse(await canvasProps(pane)).props.cards as Array<{ id: string; name: string; x: number; y: number }>)

test('a wire dragged over its own card shows the reason, turns red, and posts nothing', async ($, on) => {
  const pane = await openPane($, on)
  await pane.pointer({ type: 'down', x: 27, y: 3, button: 'left' })
  await pane.pointer({ type: 'move', x: 35, y: 3, button: 'left' })
  expect(await wireColors(pane)).toContain('#d97757')
  expect(await pane.find({ in: 'canvas', text: /Can't connect an agent to itself\./ })).toBeUndefined()
  await pane.pointer({ type: 'move', x: 10, y: 3, button: 'left' })
  expect(await pane.find({ in: 'canvas', text: /Can't connect an agent to itself\./ })).toBeDefined()
  expect(await pane.find({ in: 'canvas', key: 'wire-reason' })).toBeDefined()
  await pane.pointer({ type: 'up', x: 10, y: 3, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ key: 'as-handoff' })).toBeUndefined()
  expect(await pane.find({ in: 'canvas', text: /Can't connect/ })).toBeUndefined()
  expect((await cardsIn(pane)).map(c => c.name)).toEqual(['Researcher', 'Writer'])
  await pane.unmount()
})

const wireColors = async (pane: Awaited<ReturnType<typeof openPane>>) =>
  JSON.stringify(await pane.find({ in: 'canvas', key: 'wire-h' }))

test('the wire is orange in the open, green over a valid card and red over an invalid one', async ($, on) => {
  const both: Graph = { ...graph, edges: [...graph.edges, { id: 'e2', from: 'a', to: 'b', kind: 'delegate' }] }
  const pane = await openPane($, on, both)
  await pane.pointer({ type: 'down', x: 27, y: 3, button: 'left' })
  await pane.pointer({ type: 'move', x: 33, y: 9, button: 'left' })
  expect(await wireColors(pane)).toContain('#d97757')
  await pane.pointer({ type: 'move', x: 45, y: 3, button: 'left' })
  expect(await wireColors(pane)).toContain('#d4453b')
  expect(await pane.find({ in: 'canvas', text: /Already connected both ways\./ })).toBeDefined()
  await pane.pointer({ type: 'up', x: 45, y: 3, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ key: 'as-handoff' })).toBeUndefined()
  await pane.unmount()
})

test('the wire is green over a card it can connect to', async ($, on) => {
  const ok = await openPane($, on)
  await ok.pointer({ type: 'down', x: 27, y: 3, button: 'left' })
  await ok.pointer({ type: 'move', x: 45, y: 3, button: 'left' })
  expect(await wireColors(ok)).toContain('#5aa469')
  expect(await ok.find({ in: 'canvas', key: 'wire-reason' })).toBeUndefined()
  await ok.pointer({ type: 'up', x: 45, y: 3, button: 'left' })
  await ok.unmount()
})

test('releasing a wire on empty canvas spawns a connected agent there', async ($, on) => {
  const pane = await openPane($, on)
  await pane.pointer({ type: 'down', x: 27, y: 3, button: 'left' })
  await pane.pointer({ type: 'move', x: 30, y: 12, button: 'left' })
  await pane.pointer({ type: 'up', x: 30, y: 12, button: 'left' })
  await pane.advance(16)
  const made = (await cardsIn(pane)).find(c => c.name === 'Agent 3')
  expect(made).toMatchObject({ x: 28, y: 10 })
  const edges = JSON.parse(await canvasProps(pane)).props.edges as Array<{ from: string; to: string; kind: string }>
  expect(edges.some(e => e.from === 'a' && e.to === made!.id && e.kind === 'handoff')).toBe(true)
  expect(await pane.find({ key: 'as-handoff' })).toBeUndefined()
  await pane.unmount()
})

test('a click on a port without moving still picks a target; no spawn', async ($, on) => {
  const pane = await openPane($, on)
  await pane.pointer({ type: 'down', x: 27, y: 3, button: 'left' })
  await pane.pointer({ type: 'up', x: 27, y: 3, button: 'left' })
  await pane.advance(16)
  expect((await cardsIn(pane)).map(c => c.name)).toEqual(['Researcher', 'Writer'])
  await pane.unmount()
})

test('a disabled card has a dim border and dim text', async ($, on) => {
  const off: Graph = { ...graph, nodes: [{ ...graph.nodes[0]!, disabled: true }, graph.nodes[1]!] }
  const pane = await openPane($, on, off)
  expect((await pane.find({ in: 'canvas', key: 'card-a' }))?.props).toMatchObject({ borderDimColor: true })
  expect((await pane.find({ in: 'canvas', key: 'card-b' }))?.props.borderDimColor).toBeFalsy()
  expect((await pane.find({ in: 'canvas', type: 'Text', text: /◌ Researcher/ }))?.props).toMatchObject({ dimColor: true })
  expect((await pane.find({ in: 'canvas', type: 'Text', text: /Writer/ }))?.props.dimColor).toBeFalsy()
  await pane.unmount()
})

test('a card with a warning and no run status shows an orange △', async ($, on) => {
  const warned: Graph = { ...graph, edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'delegate' }] }
  const pane = await openPane($, on, warned)
  // Only the glyph is orange; the name keeps the ordinary colour.
  expect((await pane.find({ in: 'canvas', type: 'Text', text: /^△$/ }))?.props).toMatchObject({ color: '#d97757' })
  expect((await pane.find({ in: 'canvas', type: 'Text', text: /△ Writer/ }))?.props.color).toBeUndefined()
  await pane.unmount()
})

test('a card whose saved output is out of date has an orange border and an orange ↻', async ($, on) => {
  const g: Graph = { ...graph, id: 'g-stale' }
  const saved = (task: string) => ({ runId: 'r1', at: 1_000, fingerprint: '', task, status: 'done' })
  const index = {
    runs: [{ id: 'r1', at: 1_000, ending: 'finished', mode: 'full', taskLine: 'old', costUsd: 0 }],
    latest: { a: saved('old task'), b: saved('old task') },
  }
  const pane = await openPane($, on, g, 'terminal', { 'runs:g-stale': index })
  // A blank task box marks nothing; a task other than the saved one makes both out of date.
  expect(await pane.find({ in: 'canvas', text: /stale ·/ })).toBeUndefined()
  await pane.input({ key: 'task', text: 'new task', kind: 'change' })
  expect((await pane.find({ in: 'canvas', key: 'card-a' }))?.props).toMatchObject({ borderColor: '#d97757' })
  expect((await pane.find({ in: 'canvas', type: 'Text', text: /↻ Researcher/ }))?.props).toMatchObject({ color: '#d97757' })
  expect((await pane.find({ in: 'canvas', key: 'card-a' }))?.text).toContain('stale · task changed')
  await pane.unmount()
})

test('the delegate arrow has a hollow circle at its tail in the terminal layer', async ($, on) => {
  const del: Graph = { ...graph, edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'delegate' }] }
  const term = await openPane($, on, del)
  expect(await term.find({ in: 'canvas', text: /○/ })).toBeDefined()
  await term.unmount()
})

test('the delegate arrow has a marker-start circle in the desktop base Svg', async ($, on) => {
  const del: Graph = { ...graph, edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'delegate' }] }
  const desk = await openPane($, on, del, 'desktop')
  const base = (await desk.findAll({ type: 'Svg' })).find(x => x.props.alt === 'Agent graph arrows')?.props.source as string
  expect(base).toContain('marker-start')
  await desk.unmount()
})

test('ctrl and shift reach the mod with the key: ctrl+z undoes a nudge', async ($, on) => {
  const pane = await openPane($, on)
  await pane.pointer({ type: 'down', x: 5, y: 2, button: 'left' })
  await pane.pointer({ type: 'up', x: 5, y: 2, button: 'left' })
  await pane.advance(16)
  await pane.key({ key: 'right' })
  await pane.advance(16)
  expect((await cardsIn(pane)).find(c => c.id === 'a')?.x).toBe(3)
  await pane.key({ key: 'z', ctrl: true })
  await pane.advance(16)
  expect((await cardsIn(pane)).find(c => c.id === 'a')?.x).toBe(2)
  await pane.key({ key: 'z', ctrl: true, shift: true })
  await pane.advance(16)
  expect((await cardsIn(pane)).find(c => c.id === 'a')?.x).toBe(3)
  await pane.unmount()
})

test('d, tab and return are ignored while the connect picker is open', async ($, on) => {
  const pane = await openPane($, on)
  await pane.pointer({ type: 'down', x: 5, y: 2, button: 'left' })
  await pane.pointer({ type: 'up', x: 5, y: 2, button: 'left' })
  await pane.pointer({ type: 'down', x: 27, y: 3, button: 'left' })
  await pane.pointer({ type: 'move', x: 35, y: 3, button: 'left' })
  await pane.pointer({ type: 'move', x: 45, y: 3, button: 'left' })
  await pane.pointer({ type: 'up', x: 45, y: 3, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ key: 'as-handoff' }), 'picker open').toBeDefined()
  await pane.key({ key: 'd' })
  await pane.key({ key: 'tab' })
  await pane.key({ key: 'return' })
  await pane.advance(16)
  expect(ran, 'return opened no editor').toEqual([])
  expect(JSON.parse(await canvasProps(pane)).props.cards.some((c: { disabled: boolean }) => c.disabled)).toBe(false)
  expect(await pane.find({ key: 'as-handoff' }), 'picker still open').toBeDefined()
  await pane.unmount()
})

test('releasing a wire outside the canvas posts nothing', async ($, on) => {
  const pane = await openPane($, on)
  for (const [x, y] of [[-3, 12], [30, -2], [500, 12], [30, 500]] as const) {
    await pane.pointer({ type: 'down', x: 27, y: 3, button: 'left' })
    await pane.pointer({ type: 'move', x: 30, y: 12, button: 'left' })
    await pane.pointer({ type: 'up', x, y, button: 'left' })
    await pane.advance(16)
    expect((await cardsIn(pane)).map(c => c.name), `released at ${x},${y}`).toEqual(['Researcher', 'Writer'])
  }
  expect(await pane.find({ key: 'as-handoff' })).toBeUndefined()
  await pane.unmount()
})

test('d, return and tab are swallowed while an arrow is selected', async ($, on) => {
  const pane = await openPane($, on)
  await pane.pointer({ type: 'down', x: 5, y: 2, button: 'left' })
  await pane.pointer({ type: 'up', x: 5, y: 2, button: 'left' })
  await pane.advance(16)
  await pane.pointer({ type: 'down', x: 30, y: 3, button: 'left' })
  await pane.pointer({ type: 'up', x: 30, y: 3, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeDefined()
  await pane.key({ key: 'd' })
  await pane.key({ key: 'return' })
  await pane.key({ key: 'tab' })
  await pane.advance(16)
  expect(JSON.parse(await canvasProps(pane)).props.cards.some((c: { disabled: boolean }) => c.disabled)).toBe(false)
  expect(await pane.find({ key: 'name-a' }), 'the selection did not move').toBeDefined()
  await pane.unmount()
})

test('redo arrives as ctrl+shift+z, ctrl+Z (capital) or ctrl+y; plain ctrl+z undoes', async ($, on) => {
  const pane = await openPane($, on)
  await pane.pointer({ type: 'down', x: 5, y: 2, button: 'left' })
  await pane.pointer({ type: 'up', x: 5, y: 2, button: 'left' })
  await pane.advance(16)
  const x = async () => (await cardsIn(pane)).find(c => c.id === 'a')?.x
  await pane.key({ key: 'right' })
  await pane.advance(16)
  expect(await x()).toBe(3)
  for (const redo of [{ key: 'Z', ctrl: true }, { key: 'y', ctrl: true }, { key: 'z', ctrl: true, shift: true }] as const) {
    await pane.key({ key: 'z', ctrl: true })
    await pane.advance(16)
    expect(await x(), 'undone').toBe(2)
    await pane.key(redo)
    await pane.advance(16)
    expect(await x(), `redone by ${JSON.stringify(redo)}`).toBe(3)
  }
  await pane.unmount()
})

// ---- parked minors: the canvas client ----

test('a long name is clipped by characters, never in the middle of a surrogate pair', async ($, on) => {
  const long: Graph = { ...graph, nodes: [{ ...graph.nodes[0]!, name: '\u{1D49C}'.repeat(30) }, graph.nodes[1]!] }
  const pane = await openPane($, on, long)
  const shown = (await pane.find({ in: 'canvas', type: 'Text', text: /…/ }))?.text ?? ''
  expect(shown).toMatch(/…$/)
  // Whole letters only: 17 of them (two code units each), then the ellipsis.
  expect([...shown].filter(ch => ch === '\u{1D49C}')).toHaveLength(17)
  expect(shown.length).toBe(2 + 17 * 2 + 1)
  await pane.unmount()
})

test('a queued press of one canvas is not lost when another canvas is mounted', async ($, on) => {
  const first = await openPane($, on)
  await first.press({ key: 'card-edit-b' })
  const second = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.advance(16)
  expect(ran.some(argv => argv.includes('./.claude/agent-graph/g1/b.md'))).toBe(true)
  await second.unmount()
  await first.unmount()
})

type TestPane = Awaited<ReturnType<typeof openPane>>
const click = async (pane: TestPane, x: number, y: number) => {
  await pane.pointer({ type: 'down', x, y, button: 'left' })
  await pane.pointer({ type: 'up', x, y, button: 'left' })
  await pane.advance(16)
}

// Two arrows between the same cards share their whole path.
const twins: Graph = { ...graph, edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }, { id: 'e2', from: 'a', to: 'b', kind: 'delegate' }] }

test('vector mode: clicking the same spot again picks the next arrow under it', async ($, on) => {
  const pane = await openPane($, on, twins, 'desktop')
  const pickedKey = async () => ((await pane.find({ in: 'canvas', key: 'edge-kind-e1' })) !== undefined ? 'e1' : (await pane.find({ in: 'canvas', key: 'edge-kind-e2' })) !== undefined ? 'e2' : 'none')
  await click(pane, 33, 3)
  const first = await pickedKey()
  expect(first).not.toBe('none')
  await click(pane, 33, 3)
  const second = await pickedKey()
  expect([second, first].sort()).toEqual(['e1', 'e2'])
  await click(pane, 33, 3)
  expect(await pickedKey()).toBe(first)
  await pane.unmount()
})

test('vector mode: a pointer one row off a flat curve misses it', async ($, on) => {
  const pane = await openPane($, on, graph, 'desktop')
  for (const y of [2, 4]) {
    await pane.pointer({ type: 'move', x: 33, y })
    expect(await pane.find({ in: 'canvas', text: /handoff · Researcher → Writer/ }), `row ${y}`).toBeUndefined()
  }
  await pane.pointer({ type: 'move', x: 33, y: 3 })
  expect(await pane.find({ in: 'canvas', text: /handoff · Researcher → Writer/ })).toBeDefined()
  await pane.unmount()
})

test('vector mode: a sloped curve is hit along its slope, with rows scaled to cell width', async ($, on) => {
  const low: Graph = { ...graph, nodes: [node('a', 'Researcher', 2), { ...node('b', 'Writer', 40), y: 5 }] }
  const pane = await openPane($, on, low, 'desktop')
  const label = /handoff · Researcher → Writer/
  await pane.pointer({ type: 'move', x: 33, y: 5 })
  expect(await pane.find({ in: 'canvas', text: label }), 'on the diagonal').toBeDefined()
  await pane.pointer({ type: 'move', x: 35, y: 5 })
  expect(await pane.find({ in: 'canvas', text: label }), 'two rows scaled off the diagonal').toBeUndefined()
  await pane.pointer({ type: 'move', x: 36, y: 6 })
  expect(await pane.find({ in: 'canvas', text: label }), 'further along the diagonal').toBeDefined()
  await pane.unmount()
})

test('vector mode: where two curves are in range the nearer one wins', async ($, on) => {
  const three: Graph = {
    ...graph,
    nodes: [node('a', 'Researcher', 2), node('b', 'Writer', 40), { ...node('c', 'Editor', 40), y: 7 }],
    // The nearer curve (to Writer) is the later one in the list.
    edges: [{ id: 'e2', from: 'a', to: 'c', kind: 'handoff' }, { id: 'e1', from: 'a', to: 'b', kind: 'handoff' }],
  }
  const pane = await openPane($, on, three, 'desktop')
  await pane.pointer({ type: 'move', x: 30, y: 3 })
  expect(await pane.find({ in: 'canvas', text: /Researcher → Writer/ })).toBeDefined()
  expect(await pane.find({ in: 'canvas', text: /Researcher → Editor/ })).toBeUndefined()
  await pane.pointer({ type: 'move', x: 31, y: 4 })
  expect(await pane.find({ in: 'canvas', text: /Researcher → Editor/ })).toBeDefined()
  await pane.unmount()
})

test('an armed arrow delete button disarms after three seconds', async ($, on) => {
  const pane = await openPane($, on)
  await click(pane, 30, 3)
  await pane.press({ key: 'edge-del-e1' })
  await pane.advance(16)
  expect((await pane.find({ in: 'canvas', key: 'edge-del-e1' }))?.props.label).toBe('Delete?')
  await pane.advance(3000)
  expect((await pane.find({ in: 'canvas', key: 'edge-del-e1' }))?.props.label).toBe('✕')
  await pane.unmount()
})

test('the arrow popup swallows presses on its button row only', async ($, on) => {
  const pane = await openPane($, on)
  await click(pane, 30, 3)
  const box = (await pane.find({ in: 'canvas', key: 'edge-popup' }))!.props as { left: number; top: number }
  await click(pane, box.left + 2, box.top + 2)
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' }), 'the button row keeps the popup').toBeDefined()
  await click(pane, box.left + 2, box.top + 1)
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' }), 'the label row is empty canvas').toBeUndefined()
  await pane.unmount()
})

test('with cards all around the popup, it takes the spot that covers least', async ($, on) => {
  const walled: Graph = { ...graph, nodes: [...graph.nodes, { ...node('c', 'C', 14), y: 7 }, { ...node('d', 'D', 40), y: 7 }] }
  const pane = await openPane($, on, walled)
  await click(pane, 33, 3)
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeDefined()
  // Under the midpoint the popup would cover 78 cells of cards; above it, clamped to the top, 66.
  expect((await pane.find({ in: 'canvas', key: 'edge-popup' }))?.props).toMatchObject({ top: 0 })
  await pane.unmount()
})

// ---- cards with a run behind them ----

const at = (h: number, m: number) => new Date(2026, 9, 8, h, m).getTime()
const record = (g: Graph, id: string, ended: number, nodes: Record<string, Partial<NodeRecord>>): RunRecord => ({
  id, graphId: g.id, graphName: g.name, task: 'Task', mode: 'full', startedAt: ended - 60_000, endedAt: ended, ending: 'finished',
  graph: { nodes: g.nodes.map(({ x: _x, y: _y, ...n }) => n), edges: g.edges },
  nodes: Object.fromEntries(Object.entries(nodes).map(([nid, n]) => [nid, { status: 'done', inputs: [], output: 'Out', files: [], fingerprint: `f${nid}`, ...n } as NodeRecord])),
  result: 'Result', outputs: [],
})

// A pane with the run of the graph on show as a past run.
async function openRun($: Args[0], on: Args[1], g: Graph, r: RunRecord) {
  const index: RunIndex = {
    runs: [{ id: r.id, at: r.endedAt, ending: r.ending, mode: r.mode, taskLine: r.task, costUsd: 0.1 }],
    latest: Object.fromEntries(Object.entries(r.nodes).map(([id, n]) => [id, { runId: r.id, at: r.endedAt, fingerprint: n.fingerprint, task: r.task, status: n.status }])),
  }
  mock.store(on, { graphs: [{ id: g.id, name: g.name }], [`graph:${g.id}`]: g, [`runs:${g.id}`]: index })
  mock.clock(on, { now: at(15, 0) })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.message', () => ({ value: undefined }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.read', (_$, e) => ({ value: String((e as unknown as { path: string }).path).endsWith(`${r.id}.json`) ? JSON.stringify(r) : 'Instructions.' }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'agent-graph' })
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: `run-${r.id}` })
  return pane
}

test('the older delivered handoff fades in the terminal layer; the newest does not', async ($, on) => {
  const fan: Graph = {
    ...graph,
    nodes: [node('a', 'Researcher', 2), node('b', 'Writer', 40), { ...node('c', 'Editor', 40), y: 8 }],
    edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }, { id: 'e2', from: 'a', to: 'c', kind: 'handoff' }],
  }
  const r = record(fan, 'r1', at(14, 2), { a: { startedAt: at(14, 0) }, b: { inputs: ['a'], startedAt: at(14, 1) }, c: { inputs: ['a'], startedAt: at(14, 1) + 30_000 } })
  const pane = await openRun($, on, fan, r)
  // The arrowheads of the two arrows, in the order they are drawn (the ports are not layer segments).
  const heads = (await pane.findAll({ in: 'canvas', type: 'Text', text: /►/ })).filter(x => x.props.dimColor !== undefined)
  expect(heads.map(x => x.props.dimColor)).toEqual([true, false])
  await pane.unmount()
})

test('a reused card keeps its name at full strength and dims its border', async ($, on) => {
  const r = record(graph, 'r1', at(14, 2), { a: { reusedFrom: { runId: 'r0', at: at(13, 50) } }, b: { inputs: ['a'] } })
  const pane = await openRun($, on, graph, r)
  expect((await pane.find({ in: 'canvas', key: 'card-a' }))?.props).toMatchObject({ borderDimColor: true })
  expect((await pane.find({ in: 'canvas', key: 'card-b' }))?.props.borderDimColor).toBeFalsy()
  expect((await pane.find({ in: 'canvas', type: 'Text', text: /✓ Researcher/ }))?.props.dimColor).toBeFalsy()
  await pane.unmount()
})

test('a disabled card that has a run status is not drawn dimmed', async ($, on) => {
  const off: Graph = { ...graph, nodes: [{ ...graph.nodes[0]!, disabled: true }, graph.nodes[1]!] }
  const r = record(off, 'r1', at(14, 2), { a: {}, b: { inputs: ['a'] } })
  const pane = await openRun($, on, off, r)
  expect((await pane.find({ in: 'canvas', key: 'card-a' }))?.props.borderDimColor).toBeFalsy()
  expect((await pane.find({ in: 'canvas', type: 'Text', text: /Researcher/ }))?.props.dimColor).toBeFalsy()
  await pane.unmount()
})

// Keep this test last in the file: its run never finishes, and while it goes the
// module's active-run slot refuses any later run in this file.
test('while a run goes: the spinner and elapsed time turn, the dots flow, the popup loses its buttons and the armed ✕ region shrinks back', async ($, on) => {
  on('agent.register', () => ({ value: undefined }) as never)
  on('agent.spawn', () => new Promise(() => {}) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  const flowing: Graph = { ...graph, edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'delegate' }] }
  const pane = await openPane($, on, flowing)
  await pane.input({ key: 'task', text: 'do it', kind: 'change' })
  // An arrow is picked (its popup has buttons) and the first card's ✕ is armed (it reads "Delete?").
  await click(pane, 31, 3)
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeDefined()
  await pane.press({ key: 'card-del-a' })
  await pane.advance(16)
  expect((await pane.find({ in: 'canvas', key: 'card-del-a' }))?.props.label).toBe('Delete?')
  await pane.post({ events: [{ kind: 'press', node: 'a', action: 'run' }] })
  await clock.advance(16)
  await pane.advance(16)

  // The spinner turns once per tick and the line counts up.
  expect(await pane.find({ in: 'canvas', type: 'Text', text: /◐ Researcher/ })).toBeDefined()
  expect(await pane.find({ in: 'canvas', type: 'Text', text: /^0:00 elapsed/ })).toBeDefined()
  const dots = async () => JSON.stringify((await pane.findAll({ in: 'canvas', type: 'Text', text: /•/ }))[0])
  const before = await dots()
  expect(before).toBeDefined()
  await pane.advance(250)
  expect(await pane.find({ in: 'canvas', type: 'Text', text: /◓ Researcher/ })).toBeDefined()
  const after = await dots()
  expect(after).not.toBe(before)
  await pane.advance(1000)
  expect(await pane.find({ in: 'canvas', type: 'Text', text: /^0:01 elapsed/ })).toBeDefined()

  // While running nothing can be deleted: the popup has no buttons and the card no ✕.
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeUndefined()
  expect(await pane.find({ in: 'canvas', text: /delegate · Researcher → Writer/ })).toBeDefined()
  expect(await pane.find({ in: 'canvas', key: 'card-del-a' })).toBeUndefined()
  // Its widened ✕ region (the last nine cells of the name row) is the card body again: a press selects.
  expect(await pane.find({ key: 'name-a' })).toBeUndefined()
  await click(pane, 2 + 18, 2)
  expect(await pane.find({ key: 'name-a' })).toBeDefined()
  await pane.unmount()
})
