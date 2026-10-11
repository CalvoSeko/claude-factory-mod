import { expect } from 'claude-code/testing'
import { test } from './kit'

import { asGraph, createLibrary, inGraphFolder, type KeyValue, type TextFiles } from '../hooks/library'

const ROOT = '/home/.claude/agent-graph'

function fakes() {
  const kv = new Map<string, unknown>()
  const files = new Map<string, string>()
  const store: KeyValue = {
    get: async k => kv.get(k),
    set: async (k, v) => void kv.set(k, v),
    delete: async k => void kv.delete(k),
  }
  // Like the mod's own adapter, a change outside the graph's folder does nothing.
  const text: TextFiles = {
    read: async p => files.get(p),
    write: async (g, p, t) => void (inGraphFolder(ROOT, g, p) && files.set(p, t)),
    remove: async (g, p) => void (inGraphFolder(ROOT, g, p) && files.delete(p)),
    removeDir: async g => void [...files.keys()].filter(k => k.startsWith(`${ROOT}/${g}/`)).forEach(k => files.delete(k)),
  }
  return { kv, files, library: createLibrary(store, text, ROOT) }
}

test('created graphs are saved, indexed and named uniquely', async () => {
  const { library } = fakes()
  const first = await library.create('Research')
  const second = await library.create('Research')
  expect(second.name).toBe('Research 2')
  expect((await library.index()).map(e => e.name)).toEqual(['Research', 'Research 2'])
  expect((await library.load(first.id))?.name).toBe('Research')
})

test('create trims the name, and a blank one becomes New graph', async () => {
  const { library } = fakes()
  expect((await library.create('  Research  ')).name).toBe('Research')
  expect((await library.create('Research ')).name).toBe('Research 2')
  expect((await library.create('   ')).name).toBe('New graph')
  expect((await library.index()).map(e => e.name)).toEqual(['New graph', 'Research', 'Research 2'])
})

test('adding a node writes its instructions file', async () => {
  const { library, files } = fakes()
  const graph = await library.addNode(await library.create('G'), 'Writer', 2, 1)
  const node = graph.nodes[0]!
  expect(node.instructionsFile).toBe(`/home/.claude/agent-graph/${graph.id}/${node.id}.md`)
  expect(files.get(node.instructionsFile)).toContain('You are Writer.')
  expect(await library.instructions(node)).toContain('You are Writer.')
})

test('rename refuses an empty or taken name', async () => {
  const { library } = fakes()
  const a = await library.create('A')
  await library.create('B')
  expect(await library.rename(a, ' ')).toBe('A graph needs a name.')
  expect(await library.rename(a, 'b')).toBe('A graph called "b" already exists.')
  const renamed = await library.rename(a, 'C')
  expect(typeof renamed === 'string' ? renamed : renamed.name).toBe('C')
  expect((await library.index()).map(e => e.name)).toEqual(['B', 'C'])
})

test('removing a node or a graph removes instructions files', async () => {
  const { library, files } = fakes()
  let graph = await library.addNode(await library.create('G'), 'One', 0, 0)
  graph = await library.addNode(graph, 'Two', 20, 0)
  graph = await library.removeNode(graph, graph.nodes[0]!.id)
  expect(files.size).toBe(1)
  await library.save(graph)
  await library.remove(graph)
  expect(files.size).toBe(0)
  expect(await library.index()).toEqual([])
  expect(await library.load(graph.id)).toBeUndefined()
})

test('removing a graph without its files drops the index entry and the graph at once and leaves the files to the caller', async () => {
  const { library, files } = fakes()
  const graph = await library.addNode(await library.create('G'), 'One', 0, 0)
  await library.save(graph)
  await library.remove(graph, { files: false })
  expect(await library.index()).toEqual([])
  expect(await library.load(graph.id)).toBeUndefined()
  expect(files.size).toBe(1)
})

test('load upgrades a graph saved before the cards', async () => {
  const { library } = fakes()
  const g = await library.create('Old')
  await library.save({ ...g, layout: undefined, nodes: [] })
  expect((await library.load(g.id))?.layout).toBe(2)
})

test('load scales the positions of a graph saved before the cards', async () => {
  const { library } = fakes()
  let g = await library.create('Old')
  g = await library.addNode(await library.addNode(g, 'A', 3, 2), 'B', 5, 3)
  await library.save({ ...g, layout: undefined })
  const loaded = await library.load(g.id)
  expect(loaded?.nodes.map(n => [n.x, n.y])).toEqual([[5, 4], [8, 6]])
})

test('an imported graph joins under its own id, renamed when its name is taken, once', async () => {
  const { library } = fakes()
  await library.create('Factory')
  const graph = { id: 'g_import1', name: 'Factory', description: '', backend: 'local' as const, nodes: [], edges: [], layout: 2 as const }
  const imported = await library.importGraph(graph)
  expect(imported?.name).toBe('Factory 2')
  expect((await library.load('g_import1'))?.name).toBe('Factory 2')
  expect(await library.importGraph(graph)).toBe(undefined)
  expect((await library.index()).map(e => e.name)).toEqual(['Factory', 'Factory 2'])
})

test('asGraph accepts a graph file and fills node defaults, and says what is wrong with a bad one', () => {
  const good = asGraph({
    id: 'g_x', name: 'X', backend: 'local',
    nodes: [{ id: 'n_a', name: 'A', x: 2, y: 1, instructionsFile: '/a.md' }],
    edges: [{ id: 'e_1', from: 'n_a', to: 'n_a', kind: 'retry', retries: 2 }],
  })
  expect(typeof good).toBe('object')
  if (typeof good === 'string') return
  expect(good.description).toBe('')
  expect(good.nodes[0]).toEqual({ id: 'n_a', name: 'A', x: 2, y: 1, instructionsFile: '/a.md', skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2 })
  expect(asGraph({ id: 'g_h', name: 'H', backend: 'headless', nodes: [], edges: [] })).toMatchObject({ id: 'g_h', backend: 'headless' })
  expect(asGraph({ id: 'g_c', name: 'C', backend: 'cloud', nodes: [], edges: [] })).toMatchObject({ backend: 'cloud' })
  expect(asGraph([])).toBe('not a graph object.')
  expect(asGraph({ id: 'g x', name: 'X', backend: 'local', nodes: [], edges: [] })).toBe('its id is missing or has characters other than letters, digits, _ and -.')
  expect(asGraph({ id: 'g_x', name: 'X', backend: 'remote', nodes: [], edges: [] })).toBe('its backend must be "local", "headless" or "cloud".')
  expect(asGraph({ id: 'g_x', name: 'X', backend: 'local', nodes: [{ id: 'n' }], edges: [] })).toBe('every node needs an id, a name, x, y and an instructionsFile.')
  expect(asGraph({ id: 'g_x', name: 'X', backend: 'local', nodes: [], edges: [{ id: 'e', from: 'a', to: 'b', kind: 'other' }] })).toBe('every edge needs an id, from, to and a kind of handoff, delegate or retry.')
})
