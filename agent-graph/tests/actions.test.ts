import { expect } from 'claude-code/testing'
import { test } from './kit'

import { isTextOutput, safeFileName, startHeartbeat, startRun, TOOL_PREFIX, toolName, viewOf, type Host } from '../hooks/actions'
import type { AgentNode, Graph, RunRecord } from '../types'

const node = (id: string, name: string): AgentNode => ({
  id, name, x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})

test('output file names are cut to a safe basename', async () => {
  expect(safeFileName('report.md')).toBe('report.md')
  expect(safeFileName('../../etc/passwd')).toBe('passwd')
  expect(safeFileName('C:\\Users\\x\\evil.txt')).toBe('evil.txt')
  expect(safeFileName('..')).toBe('output')
  expect(safeFileName('a\u0000b\u001f.md')).toBe('ab.md')
  expect(safeFileName('notes..md')).toBe('notes.md')
  expect(safeFileName('dir/')).toBe('output')
  expect(safeFileName('')).toBe('output')
})

test('only text-like outputs are saved', async () => {
  for (const name of ['a.md', 'b.TXT', 'c.json', 'd.csv', 'e.py', 'f.yml']) expect(isTextOutput(name), name).toBe(true)
  for (const name of ['a.xlsx', 'b.docx', 'c.pdf', 'd.png', 'noext']) expect(isTextOutput(name), name).toBe(false)
})

test('tool names are unique by graph id and fit 64 characters with the MCP prefix', async () => {
  const a: Graph = { id: 'g_aaaa111111', name: 'A/B', description: '', backend: 'local', nodes: [], edges: [] }
  const b: Graph = { ...a, id: 'g_bbbb222222', name: 'A B' }
  expect(toolName(a)).toBe('run_a_b_111111')
  expect(toolName(a)).not.toBe(toolName(b))
  const long = toolName({ ...a, name: 'word '.repeat(30) })
  expect(`mcp__agent-graph__${long}`.length <= 64, long).toBe(true)
  expect(`mcp__agent-graph__${long}`.startsWith(TOOL_PREFIX)).toBe(true)
  expect(long.endsWith('_111111')).toBe(true)
})

test('an invalid graph does not start, and its problems name their agents', async () => {
  const g: Graph = { id: 'g', name: 'Flow', description: '', backend: 'local', nodes: [node('a', 'Writer'), node('b', 'Writer')], edges: [] }
  // Validation answers before the host is touched.
  const reason = await startRun({} as Host, g, 'do it', 'tool')
  expect(reason).toBe(
    'Could not start "Flow":\n- Writer: Another agent is also called "Writer".\n- Writer: Another agent is also called "Writer".',
  )
})

test('a graph whose agents are all disabled does not start', async () => {
  const g: Graph = { id: 'g', name: 'Flow', description: '', backend: 'local', nodes: [{ ...node('a', 'Writer'), disabled: true }, { ...node('b', 'Editor'), disabled: true }], edges: [] }
  expect(await startRun({} as Host, g, 'do it', 'tool')).toBe('Every agent in "Flow" is disabled.')
})

test('disabled agents are not validated: a duplicate name on a disabled agent does not block', async () => {
  const g: Graph = { id: 'g', name: 'Flow', description: '', backend: 'local', nodes: [node('a', 'Writer'), { ...node('b', 'Writer'), disabled: true }], edges: [] }
  // The rewired graph is valid, so validation passes and the empty task is what answers.
  expect(await startRun({} as Host, g, '  ', 'tool')).toBe('Give the graph a task first.')
})

test('the heartbeat redraws by bumping the small ui slot, never by re-sending the run view', async () => {
  const updated: string[] = []
  const timers: Array<() => void> = []
  let timeline = true
  const host = {
    clock: { after: (_ms: number, run: () => void) => void timers.push(run), now: async () => 0 },
    read: async (slot: string) => (slot === 'ui' ? { timeline } : null),
    update: async (slot: string) => void updated.push(slot),
  } as unknown as Host
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  const stop = startHeartbeat(host)
  for (let beat = 0; beat < 3; beat++) {
    await flush()
    timers.shift()!()
    await flush()
  }
  expect(updated).toEqual(['ui', 'ui', 'ui'])
  // With the timeline off it ticks without drawing.
  timeline = false
  await flush()
  timers.shift()!()
  await flush()
  expect(updated).toHaveLength(3)
  stop()
  await flush()
  timers.shift()?.()
  await flush()
  expect(updated).toHaveLength(3)
})

test('a saved record turned back into a view keeps round and rounds', async () => {
  const rounds = [{ round: 1, passed: false, note: 'nope', at: 5 }, { round: 2, passed: true, note: 'passed', at: 9 }]
  const r: RunRecord = {
    id: 'r', graphId: 'g', graphName: 'G', task: 'T', mode: 'full', startedAt: 1, endedAt: 2, ending: 'finished',
    graph: { nodes: [], edges: [] }, result: '', outputs: [],
    nodes: {
      a: { status: 'done', inputs: [], files: [], fingerprint: 'f', round: 2 },
      b: { status: 'done', inputs: ['a'], files: [], fingerprint: 'f', round: 2, rounds },
      c: { status: 'done', inputs: [], files: [], fingerprint: 'f' },
    },
  }
  const view = viewOf(r, 'r', true)
  expect(view.nodes.a).toMatchObject({ round: 2 })
  expect(view.nodes.a).not.toHaveProperty('rounds')
  expect(view.nodes.b).toMatchObject({ round: 2, rounds })
  expect(view.nodes.c).not.toHaveProperty('round')
})
