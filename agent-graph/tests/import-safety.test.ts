import { expect } from 'claude-code/testing'
import { test } from './kit'

import { asGraph, createLibrary, type KeyValue, type TextFiles } from '../hooks/library'
import type { Graph } from '../types'

const ROOT = '/home/.claude/agent-graph'

function fakes() {
  const kv = new Map<string, unknown>()
  const reads: string[] = []
  const store: KeyValue = {
    get: async k => kv.get(k),
    set: async (k, v) => void kv.set(k, v),
    delete: async k => void kv.delete(k),
  }
  const files: TextFiles = {
    read: async p => void reads.push(p),
    write: async () => {},
    remove: async () => {},
    removeDir: async () => {},
  }
  return { reads, library: createLibrary(store, files, ROOT) }
}

const agent = (over: Record<string, unknown> = {}) => ({ id: 'n_a', name: 'A', x: 2, y: 1, instructionsFile: '/a.md', ...over })
const file = (over: Record<string, unknown> = {}) => ({ id: 'g_x', name: 'X', backend: 'local', nodes: [agent()], edges: [], ...over })
const parsed = (value: unknown): Graph => {
  const graph = asGraph(value)
  if (typeof graph === 'string') throw new Error(graph)
  return graph
}

test('asGraph refuses node and edge ids that are not plain tokens, Windows device names included', () => {
  const NODE_ID = 'every node id may only have letters, digits, _ and -.'
  expect(asGraph(file({ nodes: [agent({ id: 'a/../b' })] }))).toBe(NODE_ID)
  expect(asGraph(file({ nodes: [agent({ id: 'n x' })] }))).toBe(NODE_ID)
  expect(asGraph(file({ nodes: [agent({ id: 'con' })] }))).toBe(NODE_ID)
  expect(asGraph(file({ nodes: [agent({ id: 'Com1' })] }))).toBe(NODE_ID)
  expect(asGraph(file({ edges: [{ id: 'e;1', from: 'n_a', to: 'n_a', kind: 'handoff' }] }))).toBe('every edge id may only have letters, digits, _ and -.')
  expect(asGraph(file({ id: 'NUL' }))).toBe('its id is missing or has characters other than letters, digits, _ and -.')
  expect(typeof asGraph(file({ nodes: [agent({ id: 'console' })] }))).toBe('object')
})

test('asGraph refuses a check without a command and tool, skill or context lists that are not lists of text', () => {
  expect(asGraph(file({ nodes: [agent({ check: { timeoutMin: 5 } })] }))).toBe('every check card needs a command.')
  expect(asGraph(file({ nodes: [agent({ check: 'rm -rf /' })] }))).toBe('every check card needs a command.')
  const LISTS = "every node's tools, skills and contextFiles must be lists of text."
  expect(asGraph(file({ nodes: [agent({ tools: 'Bash' })] }))).toBe(LISTS)
  expect(asGraph(file({ nodes: [agent({ skills: [1] })] }))).toBe(LISTS)
  expect(asGraph(file({ nodes: [agent({ contextFiles: null })] }))).toBe(LISTS)
})

test('asGraph refuses a whenToUse that is not text, and still takes one that is text or absent', () => {
  const WHEN = "every node's whenToUse must be text."
  expect(asGraph(file({ nodes: [agent({ whenToUse: 5 })] }))).toBe(WHEN)
  expect(asGraph(file({ nodes: [agent({ whenToUse: null })] }))).toBe(WHEN)
  expect(typeof asGraph(file({ nodes: [agent({ whenToUse: 'x' })] }))).toBe('object')
  expect(typeof asGraph(file({ nodes: [agent()] }))).toBe('object')
})

test('asGraph keeps retries from 0 to 10 and turns any other value into 3', () => {
  const retries = (value: unknown) => parsed(file({ edges: [{ id: 'e_1', from: 'n_a', to: 'n_a', kind: 'retry', retries: value }] })).edges[0]!.retries
  for (const bad of [1e9, -1, 2.5, '3']) expect(retries(bad)).toBe(3)
  expect(retries(0)).toBe(0)
  expect(retries(10)).toBe(10)
  expect(parsed(file({ edges: [{ id: 'e_1', from: 'n_a', to: 'n_a', kind: 'handoff' }] })).edges[0]!.retries).toBe(undefined)
})

test('asGraph turns a budget that is not a positive number up to $100 into $2', () => {
  const budget = (value: unknown) => parsed(file({ nodes: [agent({ budgetUsd: value })] })).nodes[0]!.budgetUsd
  for (const bad of [1e6, 0, -5, '5', null]) expect(budget(bad)).toBe(2)
  expect(budget(100)).toBe(100)
})

test('asGraph turns a run cap that is missing or not a positive number up to $500 into $20', () => {
  for (const bad of [1e6, -1, 'x']) expect(parsed(file({ runCapUsd: bad })).runCapUsd).toBe(20)
  expect(parsed(file()).runCapUsd).toBe(20)
  expect(parsed(file({ runCapUsd: 500 })).runCapUsd).toBe(500)
})

test('asGraph rounds a check timeout into 1 to 60 minutes, and a timeout that is not a number becomes 10', () => {
  const timeout = (value: unknown) => parsed(file({ nodes: [agent({ instructionsFile: '', check: { command: 'npm test', timeoutMin: value } })] })).nodes[0]!.check?.timeoutMin
  expect(timeout(1000)).toBe(60)
  expect(timeout(0)).toBe(1)
  expect(timeout('x')).toBe(10)
  expect(timeout(2.4)).toBe(2)
})

test('an import gets canonical instructions paths, loses its cloud links and is saved untrusted', async () => {
  const { library, reads } = fakes()
  const graph = parsed(file({
    id: 'g_imp',
    trusted: true,
    layout: 2,
    nodes: [
      agent({ id: 'n_a', instructionsFile: '/etc/passwd', cloud: { agentId: 'agent_x', version: 1, hash: 'h' } }),
      agent({ id: 'n_c', instructionsFile: '', check: { command: 'npm test', timeoutMin: 5 } }),
    ],
  }))
  await library.importGraph(graph)
  const saved = await library.load('g_imp')
  expect(saved?.trusted).toBe(false)
  expect(saved?.nodes.map(n => n.instructionsFile)).toEqual([`${ROOT}/g_imp/n_a.md`, ''])
  expect(saved?.nodes.some(n => 'cloud' in n)).toBe(false)
  expect(reads).toEqual([])
})
