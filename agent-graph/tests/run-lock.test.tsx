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

async function openPane($: Args[0], on: Args[1], g: Graph = graph, filesExist = false) {
  mock.store(on, { graphs: [{ id: 'g1', name: 'Flow' }], 'graph:g1': g })
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
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

// Its run never finishes, so this file runs one test only (each file has its own process).
test('while a run is going, deleting agents and editing arrows is refused', async ($, on) => {
  on('agent.register', () => ({ value: undefined }) as never)
  on('agent.spawn', () => new Promise(() => {}) as never)
  on('fs.read', () => ({ value: 'Do the work.' }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  const pane = await openPane($, on, graph, true)
  await pane.input({ key: 'task', text: 'do it', kind: 'change' })
  await pane.post({ events: [{ kind: 'press', node: 'a', action: 'run' }] })
  expect(await pane.find({ text: /Stop the run before/ })).toBeUndefined()
  const props = async () => JSON.stringify((await pane.find({ key: 'canvas' }))?.props)
  // The lock is on from the moment the run starts: its start has not fired and no run view exists yet.
  await pane.post({ events: [{ kind: 'press', node: 'b', action: 'delete' }] })
  expect(await props()).toContain('Writer')
  expect(await pane.find({ text: /Stop the run before deleting agents or editing arrows\./ })).toBeDefined()
  await clock.advance(16)
  await pane.post({ events: [{ kind: 'press', node: 'b', action: 'delete' }] })
  expect(await props()).toContain('Writer')
  await pane.post({ events: [{ kind: 'edge', edge: 'e1', action: 'delete' }] })
  await pane.post({ events: [{ kind: 'edge', edge: 'e1', action: 'reverse' }] })
  await pane.post({ events: [{ kind: 'edge', edge: 'e1', action: 'retype' }] })
  const after = JSON.parse(await props()).props
  expect(after.edges).toMatchObject([{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }])
  expect(after.cards).toHaveLength(2)
  await pane.unmount()
})
