import { expect, mock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import { ROW_RATIO } from '../hooks/grid'
import { TOOL_CHOICES } from '../hooks/model'
import type { Graph } from '../types'

const node = (id: string, name: string, x: number) => ({
  id, name, x, y: 1, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
const valid: Graph = {
  id: 'g1', name: 'Flow', description: '', backend: 'local',
  nodes: [node('a', 'Researcher', 2), node('b', 'Writer', 30)],
  edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }],
}
const cyclic: Graph = { ...valid, edges: [...valid.edges, { id: 'e2', from: 'b', to: 'a', kind: 'handoff' }] }

const BAND = {
  plugin: 'agent-graph', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const
const PANE = {
  plugin: 'agent-graph', component: 'Pane', requestId: 'agent-graph',
  props: { title: 'Agent Graph', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

for (const [label, graph, canRun] of [['valid', valid, true], ['cyclic', cyclic, false]] as const) {
  test(`the pane draws the ${label} graph and ${canRun ? 'offers' : 'withholds'} Run`, async ($, on) => {
    mock.store(on, { graphs: [{ id: 'g1', name: 'Flow' }], 'graph:g1': graph })
    mock.clock(on)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('fs.write', () => ({ value: undefined }) as never)
    on('env.get', () => ({ value: undefined }) as never)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, {}, 'other band') as RenderElement
    })
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      if ((await band.find({ key: 'agent-graph' }))?.props.label === '⧉ Agent Graph') await band.press({ key: 'agent-graph' })
      await band.unmount()
      const pane = await $.ui.mount({ ...PANE, surface })
      const canvas = await pane.find({ key: 'canvas' })
      expect(JSON.stringify(canvas?.props)).toContain('Researcher')
      expect(JSON.stringify(canvas?.props)).toContain('Writer')
      expect((await pane.find({ key: 'run' })) !== undefined, `${surface} run button`).toBe(canRun)
      if (!canRun) expect(await pane.find({ text: /fix 2 problems/ })).toBeDefined()
      await pane.unmount()
    }
  })
}

test('the inspector draws no empty select once every tool is added', async ($, on) => {
  const full: Graph = { ...valid, edges: [], nodes: [{ ...node('a', 'Researcher', 2), tools: [...TOOL_CHOICES] }] }
  mock.store(on, { graphs: [{ id: 'g1', name: 'Flow' }], 'graph:g1': full })
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('ui.message', () => ({ value: undefined }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'agent-graph' })
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ key: 'add-tool-a' })).toBeUndefined()
  await pane.post({ events: [{ kind: 'down', x: 3, y: 2 }] })
  expect(await pane.find({ key: 'name-a' }), 'the node is selected').toBeDefined()
  expect(await pane.find({ key: 'add-tool-a' })).toBeUndefined()
  expect(await pane.find({ text: /all added/ })).toBeDefined()
  await pane.unmount()
})

test('deleting a graph opens another one, not a loading pane', async ($, on) => {
  const other: Graph = { ...valid, id: 'g2', name: 'Other', nodes: [node('c', 'Checker', 2)], edges: [] }
  mock.store(on, { graphs: [{ id: 'g1', name: 'Flow' }, { id: 'g2', name: 'Other' }], 'graph:g1': valid, 'graph:g2': other })
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('fs.exists', () => ({ value: false }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'agent-graph' })
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(JSON.stringify((await pane.find({ key: 'canvas' }))?.props)).toContain('Researcher')
  await pane.press({ key: 'delete-graph' })
  expect(await pane.find({ text: /Loading the graph/ })).toBeUndefined()
  expect(JSON.stringify((await pane.find({ key: 'canvas' }))?.props)).toContain('Checker')
  await pane.unmount()
})

test('the desktop pane draws the arrows as vectors; the terminal keeps the character layer', async ($, on) => {
  mock.store(on, { graphs: [{ id: 'g1', name: 'Flow' }], 'graph:g1': valid })
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })
  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    if ((await band.find({ key: 'agent-graph' }))?.props.label === '⧉ Agent Graph') await band.press({ key: 'agent-graph' })
    await band.unmount()
    const pane = await $.ui.mount({ ...PANE, surface })
    const svg = await pane.find({ type: 'Svg' })
    const canvas = JSON.parse(JSON.stringify((await pane.find({ key: 'canvas' }))?.props)).props as { vector: boolean; layer: unknown[][]; edges: Array<{ path?: unknown[] }> }
    if (surface === 'desktop') {
      expect(String(svg?.props.source)).toContain('<path')
      expect(canvas.vector).toBe(true)
      expect(canvas.edges).toHaveLength(1)
      expect(canvas.edges[0]?.path).toHaveLength(25)
      expect(canvas.layer.every(row => row.length === 0)).toBe(true)
      expect(canvas.layer.length).toBeGreaterThan(0)
    } else {
      expect(svg).toBeUndefined()
      expect(canvas.vector).toBe(false)
      expect(canvas.edges[0]?.path).toBeUndefined()
    }
    await pane.unmount()
  }
})

// Opens the pane of one graph on a surface.
type Args = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>
async function openOn($: Args[0], on: Args[1], graph: Graph, surface: 'terminal' | 'desktop') {
  mock.store(on, { graphs: [{ id: graph.id, name: 'Flow' }], [`graph:${graph.id}`]: graph })
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })
  const band = await $.ui.mount({ ...BAND, surface })
  if ((await band.find({ key: 'agent-graph' }))?.props.label === '⧉ Agent Graph') await band.press({ key: 'agent-graph' })
  await band.unmount()
  return $.ui.mount({ ...PANE, surface })
}
const canvasOf = async (pane: Awaited<ReturnType<typeof openOn>>) =>
  JSON.parse(JSON.stringify((await pane.find({ key: 'canvas' }))?.props)).props as { vector: boolean; rowRatio: number; connecting: boolean; layer: unknown[][]; edges: Array<{ path?: unknown[] }> }

test('the canvas gets the row ratio the vector layer uses, and whether a connection is being made', async ($, on) => {
  const pane = await openOn($, on, valid, 'desktop')
  const before = await canvasOf(pane)
  expect(before.rowRatio).toBe(ROW_RATIO)
  expect(before.connecting).toBe(false)
  await pane.press({ key: 'connect' })
  expect((await canvasOf(pane)).connecting).toBe(true)
  await pane.press({ key: 'connect' })
  expect((await canvasOf(pane)).connecting).toBe(false)
  await pane.unmount()
})

test('a graph with so many arrows that vector props would pass the engine limit draws them as characters', async ($, on) => {
  const many: Graph = { ...valid, edges: Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, from: i % 2 === 0 ? 'a' : 'b', to: i % 2 === 0 ? 'b' : 'a', kind: 'handoff' as const })) }
  const pane = await openOn($, on, many, 'desktop')
  expect(await pane.find({ type: 'Svg' })).toBeUndefined()
  const element = await pane.find({ key: 'canvas' })
  const canvas = await canvasOf(pane)
  expect(canvas.vector).toBe(false)
  expect(canvas.edges).toHaveLength(200)
  expect(canvas.edges.every(e => e.path === undefined)).toBe(true)
  expect(canvas.layer.some(row => row.length > 0)).toBe(true)
  expect(JSON.stringify(element?.props).length).toBeLessThan(100000)
  await pane.unmount()
})

test('a graph problem is listed once, in the toolbar list, not again in the inspector', async ($, on) => {
  const pane = await openOn($, on, { ...valid, name: '' }, 'terminal')
  expect(await pane.find({ key: 'problem-0' })).toBeDefined()
  expect(await pane.findAll({ type: 'Text', text: /The graph needs a name/ })).toHaveLength(0)
  expect(await pane.findAll({ type: 'Button', text: /The graph needs a name/ })).toHaveLength(1)
  await pane.unmount()
})
