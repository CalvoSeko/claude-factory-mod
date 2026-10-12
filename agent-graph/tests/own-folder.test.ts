import { expect } from 'claude-code/testing'
import { test } from './kit'

import { deleteGraph, deleteNode, editInstructions, onCanvas, type Host } from '../hooks/actions'
import { inGraphFolder } from '../hooks/library'
import { EMPTY_UI, type Slots } from '../hooks/state'
import type { AgentNode, Graph } from '../types'

const ROOT = '/home/u/.claude/agent-graph'

test('a path is in the graph folder only as plain segments under <root>/<graphId>/', async () => {
  for (const path of [`${ROOT}/g1/a.md`, `${ROOT}/g1/runs/r.json`, '\\home\\u\\.claude\\agent-graph\\g1\\runs\\r.json',
    `${ROOT}/g1/headless/flow--writer-abc123.json`, `${ROOT}/g1/tests/t_1-compare.md`]) {
    expect(inGraphFolder(ROOT, 'g1', path), path).toBe(true)
  }
  for (const path of [`${ROOT}/g1/../g2/a.md`, `${ROOT}/g1/.. /x`, `${ROOT}/g1/.hidden`, `${ROOT}/g1/a b.md`, `${ROOT}/g2/a.md`,
    `${ROOT}/g1x/a.md`, `${ROOT}/g1`, `${ROOT}/g1/`, '/etc/hosts']) {
    expect(inGraphFolder(ROOT, 'g1', path), path).toBe(false)
  }
  for (const id of ['../x', '', 'con']) expect(inGraphFolder(ROOT, id, `${ROOT}/${id}/a.md`), `graph id "${id}"`).toBe(false)
})

// A graph saved before imports were checked: its agent's instructions file is anywhere on disk.
const legacy = (id: string): Graph => {
  const card = (nid: string, name: string, instructionsFile: string): AgentNode => ({
    id: nid, name, x: 2, y: 1, instructionsFile, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
  })
  return {
    id, name: 'Legacy', description: '', backend: 'local', layout: 2,
    nodes: [card('a', 'Alpha', `./.claude/agent-graph/${id}/a.md`), card('b', 'Bravo', '/etc/x.md')], edges: [],
  }
}

// The actions over a host made of plain maps, with no home (USERPROFILE and HOME unset); every write and command is collected.
function memory(g: Graph) {
  const kv = new Map<string, unknown>([[`graph:${g.id}`, g], ['graphs', [{ id: g.id, name: g.name }]]])
  const fs = new Map<string, string>(g.nodes.map(n => [n.instructionsFile, `Instructions of ${n.name}.`] as const))
  const slots: Slots = { index: [], graph: g, ui: { ...EMPTY_UI, graphId: g.id }, run: null, agents: [] }
  const toasts: string[] = []
  const writes: string[] = []
  const argvs: string[][] = []
  const host = {
    env: { get: async () => undefined },
    store: {
      get: async (key: string) => kv.get(key),
      set: async (key: string, value: unknown) => void kv.set(key, JSON.parse(JSON.stringify(value))),
      delete: async (key: string) => void kv.delete(key),
    },
    fs: {
      exists: async (path: string) => fs.has(path),
      read: async (path: string) => fs.get(path) ?? '',
      write: async (path: string, text: string) => void (writes.push(path), fs.set(path, text)),
      list: async () => [],
    },
    process: {
      run: async (argv: string[]) => {
        argvs.push(argv)
        fs.delete(argv[argv.length - 1]!)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    tool: { register: async () => undefined },
    clock: { after: () => undefined, now: async () => 0 },
    ui: { open: async () => ({ isPlaced: true }), close: async () => undefined, toast: (text: string) => void toasts.push(text) },
    read: async (slot: keyof Slots) => slots[slot],
    update: async (slot: keyof Slots, change: (value: unknown) => unknown) => ((slots as Record<string, unknown>)[slot] = change(slots[slot])),
  } as unknown as Host
  return { host, slots, fs, toasts, writes, argvs }
}

const REFUSED = "Did not change /etc/x.md: it is outside this graph's folder."

test('deleting a card whose file is outside its graph folder runs nothing, keeps the file and says so', async () => {
  const m = memory(legacy('of-delete'))
  await deleteNode(m.host, 'b')
  expect(m.slots.graph?.nodes.map(n => n.id)).toEqual(['a'])
  expect(m.argvs).toEqual([])
  expect(m.fs.get('/etc/x.md')).toBe('Instructions of Bravo.')
  expect(m.toasts).toEqual([REFUSED])
})

test('undoing that delete does not write the file back outside the graph folder', async () => {
  const m = memory(legacy('of-undo'))
  await deleteNode(m.host, 'b')
  m.fs.delete('/etc/x.md')
  await onCanvas(m.host, { kind: 'key', key: 'z', ctrl: true })
  expect(m.slots.graph?.nodes.map(n => n.id)).toEqual(['a', 'b'])
  expect(m.writes).not.toContain('/etc/x.md')
  expect(m.fs.has('/etc/x.md')).toBe(false)
  expect(m.toasts).toEqual([REFUSED, REFUSED])
})

test('editing instructions outside the graph folder neither writes nor opens the file', async () => {
  const m = memory(legacy('of-edit'))
  m.fs.delete('/etc/x.md')
  await editInstructions(m.host, m.slots.graph!.nodes[1]!)
  expect(m.writes).toEqual([])
  expect(m.argvs).toEqual([])
  expect(m.toasts).toEqual([REFUSED])
})

test('deleting a graph without a home removes its own card file but never one outside its folder', async () => {
  const m = memory(legacy('of-graph'))
  await deleteGraph(m.host)
  expect(m.fs.get('/etc/x.md')).toBe('Instructions of Bravo.')
  expect(m.fs.has('./.claude/agent-graph/of-graph/a.md')).toBe(false)
  expect(m.argvs.flat()).not.toContain('/etc/x.md')
  expect(m.toasts).toContain(REFUSED)
})
