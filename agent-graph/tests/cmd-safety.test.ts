import { expect } from 'claude-code/testing'
import { test } from './kit'

import { deleteGraph, deleteNode, editInstructions, importGraphs, type Host } from '../hooks/actions'
import { EMPTY_UI, type Slots } from '../hooks/state'
import type { AgentNode, Graph } from '../types'

// A graph whose two agents keep their instructions in the graph's own folder under `home`.
const graph = (id: string, home: string): Graph => {
  const card = (nid: string, name: string): AgentNode => ({
    id: nid, name, x: 2, y: 1, instructionsFile: `${home}/.claude/agent-graph/${id}/${nid}.md`,
    skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
  })
  return { id, name: 'Flow', description: '', backend: 'local', layout: 2, nodes: [card('a', 'Alpha'), card('b', 'Bravo')], edges: [] }
}

// The actions over a host made of plain maps, with the given home and OS; every command and toast is collected.
function memory(g: Graph, home: string, os: string | undefined, imports: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { USERPROFILE: home, OS: os }
  const kv = new Map<string, unknown>([[`graph:${g.id}`, g], ['graphs', [{ id: g.id, name: g.name }]]])
  const importDir = `${home}/.claude/agent-graph/import`
  const fs = new Map<string, string>([
    ...g.nodes.map(n => [n.instructionsFile, `Instructions of ${n.name}.`] as const),
    ...Object.entries(imports).map(([name, text]) => [`${importDir}/${name}`, text] as const),
  ])
  const slots: Slots = { index: [], graph: g, ui: { ...EMPTY_UI, graphId: g.id }, run: null }
  const toasts: string[] = []
  const argvs: string[][] = []
  const host = {
    env: { get: async (name: string) => env[name] },
    store: {
      get: async (key: string) => kv.get(key),
      set: async (key: string, value: unknown) => void kv.set(key, JSON.parse(JSON.stringify(value))),
      delete: async (key: string) => void kv.delete(key),
    },
    fs: {
      exists: async (path: string) => fs.has(path) || (path === importDir && Object.keys(imports).length > 0),
      read: async (path: string) => fs.get(path) ?? '',
      write: async (path: string, text: string) => void fs.set(path, text),
      list: async (path: string) => (path === importDir ? Object.keys(imports).map(name => ({ name, kind: 'file' })) : []),
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
  return { host, slots, fs, kv, toasts, argvs }
}

// Every character cmd would read as syntax rather than as part of a path.
const UNSAFE = ['&', '|', '<', '>', '^', '%', '"', '!', '(', ')', ';']
const toCmd = (argvs: string[][]) => argvs.filter(argv => argv[0] === 'cmd')

test('on Windows a card file whose path cmd could misread is never deleted through cmd, and the person is told', async () => {
  for (const c of UNSAFE) {
    const home = `/home/a${c}b`
    const m = memory(graph('g1', home), home, 'Windows_NT')
    await deleteNode(m.host, 'b')
    expect(m.slots.graph?.nodes.map(n => n.id), `"${c}"`).toEqual(['a'])
    expect(toCmd(m.argvs), `"${c}"`).toEqual([])
    expect(m.fs.has(`${home}/.claude/agent-graph/g1/b.md`), `"${c}": the file stays`).toBe(true)
    expect(m.toasts, `"${c}"`).toEqual([`Did not delete ${home}/.claude/agent-graph/g1/b.md: it has a character cmd could misread.`])
  }
})

test('on Windows a graph folder whose path cmd could misread is never removed through cmd, and the person is told', async () => {
  const home = '/home/a&b'
  const m = memory(graph('g1', home), home, 'Windows_NT')
  await deleteGraph(m.host)
  expect(m.argvs.flat().filter(arg => arg.includes('&'))).toEqual([])
  expect(toCmd(m.argvs)).toEqual([])
  expect(m.toasts).toContain(`Did not delete ${home}/.claude/agent-graph/g1: it has a character cmd could misread.`)
})

test('on Windows an instructions file whose path cmd could misread is not opened, and a notice says why', async () => {
  const home = '/home/a&b'
  const m = memory(graph('g1', home), home, 'Windows_NT')
  await editInstructions(m.host, m.slots.graph!.nodes[0]!)
  expect(m.argvs).toEqual([])
  expect(m.slots.ui.notice).toBe(`Could not open ${home}/.claude/agent-graph/g1/a.md: it has a character cmd could misread.`)
})

test('on Windows an import file whose name cmd could misread is imported, and its removal never reaches cmd', async () => {
  const g = graph('g1', '/home/u')
  const shared = { ...graph('shared', '/elsewhere'), name: 'Shared' }
  const m = memory(g, '/home/u', 'Windows_NT', { 'x&y.json': JSON.stringify(shared) })
  expect(await importGraphs(m.host)).toBe(1)
  expect(m.kv.has('graph:shared')).toBe(true)
  expect(toCmd(m.argvs)).toEqual([])
  expect(m.toasts).toContain('Did not delete /home/u/.claude/agent-graph/import/x&y.json: it has a character cmd could misread.')
})

test('on Windows a plain path is still deleted with del and opened with start, backslashed', async () => {
  const m = memory(graph('g1', '/home/u'), '/home/u', 'Windows_NT')
  await deleteNode(m.host, 'b')
  await editInstructions(m.host, m.slots.graph!.nodes[0]!)
  expect(m.argvs).toEqual([
    ['cmd', '/c', 'del', '/q', '\\home\\u\\.claude\\agent-graph\\g1\\b.md'],
    ['cmd', '/c', 'start', '', '\\home\\u\\.claude\\agent-graph\\g1\\a.md'],
  ])
  expect(m.toasts).toEqual([])
})

test('off Windows a path with & still goes to rm -f and open as one argument', async () => {
  const home = '/home/a&b'
  const m = memory(graph('g1', home), home, undefined)
  await deleteNode(m.host, 'b')
  await editInstructions(m.host, m.slots.graph!.nodes[0]!)
  expect(m.argvs).toEqual([['rm', '-f', `${home}/.claude/agent-graph/g1/b.md`], ['open', `${home}/.claude/agent-graph/g1/a.md`]])
  expect(m.toasts).toEqual([])
})
