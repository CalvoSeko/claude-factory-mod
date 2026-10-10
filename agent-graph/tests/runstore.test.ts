import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph, RunIndex, RunRecord } from '../types'
import { RUNS_KEPT } from '../hooks/records'
import type { KeyValue, TextFiles } from '../hooks/library'
import { createRunStore } from '../hooks/runstore'

const ROOT = '/home/.claude/agent-graph'

function fakes() {
  const kv = new Map<string, unknown>()
  const files = new Map<string, string>()
  // The removals asked of the file system (each is a process on the real one).
  const calls: string[] = []
  const store: KeyValue = {
    get: async k => kv.get(k),
    set: async (k, v) => void kv.set(k, v),
    delete: async k => void kv.delete(k),
  }
  const text: TextFiles = {
    read: async p => files.get(p),
    write: async (p, t) => void files.set(p, t),
    remove: async p => void (calls.push(`remove ${p}`), files.delete(p)),
    removeDir: async p => void (calls.push(`removeDir ${p}`), [...files.keys()].filter(k => k.startsWith(`${p}/`)).forEach(k => files.delete(k))),
  }
  return { kv, files, calls, runs: createRunStore(store, text, ROOT) }
}

const node = (id: string): AgentNode => ({
  id, name: id.toUpperCase(), x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
const graph = (ids: string[]): Graph => ({ id: 'g1', name: 'Flow', description: '', backend: 'local', nodes: ids.map(node), edges: [] })

function record(id: string, ids: string[], over: Partial<RunRecord> = {}): RunRecord {
  const at = Number(id.slice(1)) * 1000
  return {
    id, graphId: 'g1', graphName: 'Flow', task: `task ${id}`, mode: 'full', startedAt: at, endedAt: at + 500, ending: 'finished',
    graph: { nodes: ids.map(i => { const { x: _x, y: _y, ...rest } = node(i); return rest }), edges: [] },
    nodes: Object.fromEntries(ids.map(i => [i, { status: 'done' as const, inputs: [], output: `out ${i} ${id}`, files: [], fingerprint: `fp-${i}` }])),
    result: 'result', outputs: [], ...over,
  }
}

test('an empty graph has an empty index', async () => {
  const { runs } = fakes()
  expect(await runs.index('g1')).toEqual({ runs: [], latest: {} })
})

test('write saves the record file, updates the index and read gives the record back', async () => {
  const { runs, files, kv } = fakes()
  const r = record('r1', ['a', 'b'])
  await runs.write(r, graph(['a', 'b']))
  expect(files.has(`${ROOT}/g1/runs/r1.json`)).toBe(true)
  const index = (await runs.index('g1')) as RunIndex
  expect(kv.get('runs:g1')).toEqual(index)
  expect(index.runs.map(s => s.id)).toEqual(['r1'])
  expect(index.latest['a']).toMatchObject({ runId: 'r1', fingerprint: 'fp-a', task: 'task r1', status: 'done' })
  expect(await runs.read('g1', 'r1')).toEqual(r)
})

test('read gives undefined for a missing or unparsable file', async () => {
  const { runs, files } = fakes()
  expect(await runs.read('g1', 'nope')).toBeUndefined()
  files.set(`${ROOT}/g1/runs/bad.json`, '{ not json')
  expect(await runs.read('g1', 'bad')).toBeUndefined()
  files.set(`${ROOT}/g1/runs/odd.json`, '"a string"')
  expect(await runs.read('g1', 'odd')).toBeUndefined()
})

test('retention removes the files of the runs that fall out of the index', async () => {
  const { runs, files } = fakes()
  const g = graph(['a', 'b'])
  // r1 is the newest entry of b only for as long as no later run names b.
  await runs.write(record('r1', ['a', 'b']), g)
  for (let i = 2; i <= RUNS_KEPT + 3; i++) await runs.write(record(`r${i}`, ['a']), g)
  const index = await runs.index('g1')
  // b's newest entry still lives in r1, so r1 stays; the oldest runs nobody names go.
  expect(index.runs).toHaveLength(RUNS_KEPT + 1)
  expect(index.latest['b']?.runId).toBe('r1')
  expect(files.has(`${ROOT}/g1/runs/r1.json`)).toBe(true)
  expect(files.has(`${ROOT}/g1/runs/r2.json`)).toBe(false)
  expect(files.has(`${ROOT}/g1/runs/r${RUNS_KEPT + 3}.json`)).toBe(true)
  expect(files.size).toBe(RUNS_KEPT + 1)
})

test('write forgets latest entries of agents that are no longer in the graph, so their runs can be retired', async () => {
  const { runs, files } = fakes()
  await runs.write(record('r1', ['a', 'gone']), graph(['a', 'gone']))
  const g = graph(['a'])
  for (let i = 2; i <= RUNS_KEPT + 2; i++) await runs.write(record(`r${i}`, ['a']), g)
  const index = await runs.index('g1')
  expect(Object.keys(index.latest)).toEqual(['a'])
  expect(index.runs).toHaveLength(RUNS_KEPT)
  expect(files.has(`${ROOT}/g1/runs/r1.json`)).toBe(false)
})

test('write keeps no latest entry for an agent the graph does not have, even from the new record', async () => {
  const { runs } = fakes()
  await runs.write(record('r1', ['a', 'gone']), graph(['a']))
  expect(Object.keys((await runs.index('g1')).latest)).toEqual(['a'])
})

test('drop removes one run: its file, its summary and the latest entries naming it', async () => {
  const { runs, files } = fakes()
  const g = graph(['a', 'b'])
  await runs.write(record('r1', ['a', 'b']), g)
  await runs.write(record('r2', ['a']), g)
  await runs.drop('g1', 'r1')
  const index = await runs.index('g1')
  expect(index.runs.map(s => s.id)).toEqual(['r2'])
  expect(index.latest['a']?.runId).toBe('r2')
  expect(index.latest['b']).toBeUndefined()
  expect(files.has(`${ROOT}/g1/runs/r1.json`)).toBe(false)
})

test('removeGraph forgets the index and leaves the record files to the graph folder removal and other graphs alone', async () => {
  const { runs, files, kv, calls } = fakes()
  const g = graph(['a'])
  await runs.write(record('r1', ['a']), g)
  await runs.write(record('r2', ['a']), g)
  await runs.write({ ...record('r3', ['a']), graphId: 'g2' }, { ...g, id: 'g2' })
  calls.length = 0
  await runs.removeGraph('g1')
  // No process per record: the files go with the folder of the graph.
  expect(calls).toEqual([])
  expect([...files.keys()].sort()).toEqual([`${ROOT}/g1/runs/r1.json`, `${ROOT}/g1/runs/r2.json`, `${ROOT}/g2/runs/r3.json`])
  expect(kv.has('runs:g1')).toBe(false)
  expect(kv.has('runs:g2')).toBe(true)
  expect(await runs.index('g1')).toEqual({ runs: [], latest: {} })
})

test('write leaves no record file behind when the index cannot be saved', async () => {
  const files = new Map<string, string>()
  const store: KeyValue = {
    get: async () => undefined,
    set: async () => {
      throw new Error('the store is full')
    },
    delete: async () => undefined,
  }
  const text: TextFiles = {
    read: async p => files.get(p),
    write: async (p, t) => void files.set(p, t),
    remove: async p => void files.delete(p),
    removeDir: async p => void [...files.keys()].filter(k => k.startsWith(`${p}/`)).forEach(k => files.delete(k)),
  }
  const runs = createRunStore(store, text, ROOT)
  let failure = ''
  try {
    await runs.write(record('r1', ['a']), graph(['a']))
  } catch (error) {
    failure = (error as Error).message
  }
  expect(failure).toBe('the store is full')
  expect(files.size).toBe(0)
})
