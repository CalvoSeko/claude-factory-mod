import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import type { Graph } from '../types'

const node = (id: string, name: string, x: number) => ({
  id, name, x, y: 1, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
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

// The mock clock of the last pane opened: it holds the `clock.after` a run is started with.
let clock: MockClock

async function openPane($: Args[0], on: Args[1], g: Graph = graph, filesExist = false, surface: 'terminal' | 'desktop' = 'terminal', extra: Record<string, unknown> = {}) {
  mock.store(on, { graphs: [{ id: 'g1', name: 'Flow' }], 'graph:g1': g, ...extra })
  clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('fs.exists', () => ({ value: filesExist }) as never)
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

test('a wire dropped on another card asks for the arrow kind', async ($, on) => {
  const pane = await openPane($, on)
  await pane.post({ events: [{ kind: 'wire', from: 'a', to: 'b' }] })
  expect(await pane.find({ key: 'as-handoff' })).toBeDefined()
  await pane.unmount()
})

test('a click on a port starts click-to-connect from that card', async ($, on) => {
  const pane = await openPane($, on)
  await pane.post({ events: [{ kind: 'port', from: 'b' }] })
  expect(await pane.find({ text: /Click the agent the arrow points to/ })).toBeDefined()
  await pane.unmount()
})

test('the delete button on a card removes that agent', async ($, on) => {
  const pane = await openPane($, on)
  await pane.post({ events: [{ kind: 'press', node: 'b', action: 'delete' }] })
  const props = JSON.stringify((await pane.find({ key: 'canvas' }))?.props)
  expect(props).toContain('Researcher')
  expect(props).not.toContain('Writer')
  await pane.unmount()
})

test('run from here also runs upstream agents that have no saved output, so their problems show', async ($, on) => {
  // The upstream agent has a problem and was never run: it has to run again, so the start is refused for it.
  const broken: Graph = { ...graph, nodes: [{ ...graph.nodes[0]!, name: '' }, graph.nodes[1]!] }
  const pane = await openPane($, on, broken)
  await pane.post({ events: [{ kind: 'press', node: 'b', action: 'run' }] })
  expect(await pane.find({ text: /Give this agent a name/ })).toBeDefined()
  await pane.unmount()
})

test('a click on another card port while connecting picks it as the target', async ($, on) => {
  const pane = await openPane($, on)
  await pane.post({ events: [{ kind: 'port', from: 'a' }] })
  await pane.post({ events: [{ kind: 'port', from: 'b' }] })
  expect(await pane.find({ key: 'as-handoff' })).toBeDefined()
  await pane.unmount()
})

test('arrow buttons switch, reverse and delete the arrow', async ($, on) => {
  const pane = await openPane($, on)
  const edges = async () => JSON.parse(JSON.stringify((await pane.find({ key: 'canvas' }))?.props)).props.edges as Array<{ from: string; to: string; kind: string }>
  await pane.post({ events: [{ kind: 'edge', edge: 'e1', action: 'retype' }] })
  expect((await edges())[0]?.kind).toBe('delegate')
  await pane.post({ events: [{ kind: 'edge', edge: 'e1', action: 'reverse' }] })
  expect((await edges())[0]).toMatchObject({ from: 'b', to: 'a' })
  await pane.post({ events: [{ kind: 'edge', edge: 'e1', action: 'delete' }] })
  expect(await edges()).toEqual([])
  await pane.unmount()
})

test('a focus event from the canvas highlights the arrow in the vector layer', async ($, on) => {
  const pane = await openPane($, on, graph, false, 'desktop')
  const glow = async () => (await pane.findAll({ type: 'Svg' })).find(x => x.props.alt === 'Highlighted agent graph arrows')?.props.source
  expect(await glow()).toBeUndefined()
  await pane.post({ events: [{ kind: 'focus', edge: 'e1', card: null }] })
  expect(String(await glow())).toContain('#f0c040')
  await pane.post({ events: [{ kind: 'focus', edge: null, card: null }] })
  expect(await glow()).toBeUndefined()
  await pane.post({ events: [{ kind: 'focus', edge: null, card: 'b' }] })
  expect(String(await glow())).toContain('#f0c040')
  await pane.unmount()
})

test('the edit button on a card opens that agent file in the editor', async ($, on) => {
  const ran: string[][] = []
  on('process.run', (_$, e) => {
    ran.push((e as unknown as { argv: string[] }).argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('fs.read', () => ({ value: 'Do the work.' }) as never)
  const pane = await openPane($, on, graph, true)
  await pane.post({ events: [{ kind: 'press', node: 'b', action: 'edit' }] })
  expect(ran.some(argv => argv.includes('/tmp/b.md'))).toBe(true)
  await pane.unmount()
})

test('events that name a missing card, or wire a card to itself, change nothing', async ($, on) => {
  const ran: string[][] = []
  on('process.run', (_$, e) => {
    ran.push((e as unknown as { argv: string[] }).argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('fs.read', () => ({ value: 'Do the work.' }) as never)
  const pane = await openPane($, on, graph, true)
  const shown = async () => JSON.stringify((await pane.find({ key: 'canvas' }))?.props)
  const before = await shown()
  await pane.post({
    events: [
      { kind: 'press', node: 'zz', action: 'edit' },
      { kind: 'press', node: 'zz', action: 'run' },
      { kind: 'press', node: 'zz', action: 'delete' },
      { kind: 'wire', from: 'zz', to: 'a' },
      { kind: 'wire', from: 'a', to: 'zz' },
      { kind: 'wire', from: 'a', to: 'a' },
      { kind: 'port', from: 'zz' },
    ],
  })
  expect(await shown()).toBe(before)
  expect(ran).toEqual([])
  expect(await pane.find({ key: 'as-handoff' })).toBeUndefined()
  expect(await pane.find({ text: /Click the agent the arrow points to/ })).toBeUndefined()
  await pane.unmount()
})

test('opening another graph clears the highlighted arrow', async ($, on) => {
  const other: Graph = { ...graph, id: 'g2', name: 'Other' }
  on('fs.read', () => ({ value: 'Do the work.' }) as never)
  const pane = await openPane($, on, graph, true, 'desktop', { graphs: [{ id: 'g1', name: 'Flow' }, { id: 'g2', name: 'Other' }], 'graph:g2': other })
  const glow = async () => (await pane.findAll({ type: 'Svg' })).find(x => x.props.alt === 'Highlighted agent graph arrows')?.props.source
  // Saving the graph is what lists the other one in the picker.
  await pane.post({ events: [{ kind: 'edge', edge: 'e1', action: 'reverse' }] })
  await pane.post({ events: [{ kind: 'focus', edge: 'e1', card: null }] })
  expect(String(await glow())).toContain('#f0c040')
  await pane.select({ key: 'graph', value: 'g2' })
  expect(await glow()).toBeUndefined()
  await pane.unmount()
})

test('pressing an arrow while connecting cancels the connect', async ($, on) => {
  const pane = await openPane($, on)
  await pane.post({ events: [{ kind: 'port', from: 'a' }] })
  expect(await pane.find({ text: /Click the agent the arrow points to/ })).toBeDefined()
  await pane.pointer({ type: 'down', x: 30, y: 3, button: 'left' })
  await pane.pointer({ type: 'up', x: 30, y: 3, button: 'left' })
  await pane.advance(16)
  expect(await pane.find({ text: /Click the agent the arrow points to/ })).toBeUndefined()
  // The press only cancelled: the arrow is not picked, so keys reach the selected card again.
  expect(await pane.find({ in: 'canvas', key: 'edge-kind-e1' })).toBeUndefined()
  const canvas = async () => JSON.stringify((await pane.find({ key: 'canvas' }))?.props)
  expect(await canvas()).toContain('Researcher')
  await pane.key({ key: 'delete' })
  await pane.advance(16)
  expect(await canvas()).not.toContain('Researcher')
  await pane.unmount()
})

// Keep this test last in the file: its run is left to the mocks, and while it is
// still going the module's active-run slot refuses any later run in this file.
test('run from here with nothing saved registers both agents and starts the upstream one first', async ($, on) => {
  const registered: string[] = []
  const spawned: string[] = []
  on('agent.register', (_$, e) => {
    registered.push((e as unknown as { name: string }).name)
    return { value: undefined } as never
  })
  on('agent.spawn', (_$, e) => {
    spawned.push(String((e as unknown as { subagent_type?: string }).subagent_type ?? ''))
    return { model: 'm', agentId: 'ag1' } as never
  })
  on('fs.read', () => ({ value: 'Do the work.' }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  const pane = await openPane($, on, graph, true)
  await pane.input({ key: 'task', text: 'do it', kind: 'change' })
  await pane.post({ events: [{ kind: 'press', node: 'b', action: 'run' }] })
  await clock.advance(16)
  // The Writer's upstream agent has no saved output, so it runs too; the Writer waits for it.
  expect(registered.length).toBe(2)
  expect(registered.some(name => name.includes('writer'))).toBe(true)
  expect(spawned.length).toBe(1)
  expect(spawned[0]).toContain('researcher')
  await pane.unmount()
})
