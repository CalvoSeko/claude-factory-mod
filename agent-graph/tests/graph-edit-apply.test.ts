import { expect } from 'claude-code/testing'
import { test } from './kit'

import { editGraphTool, libraryOf, onCanvas, toolName, type Host } from '../hooks/actions'
import { EMPTY_UI, type Slots } from '../hooks/state'
import type { AgentNode, Graph } from '../types'

const HOME = '/home/u'
const ROOT = `${HOME}/.claude/agent-graph`

const agent = (graphId: string, id: string, name: string, over: Partial<AgentNode> = {}): AgentNode => ({
  id, name, x: 2, y: 1, instructionsFile: `${ROOT}/${graphId}/${id}.md`,
  skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2, ...over,
})
// A valid graph: a writer hands off to a lint check.
const flow = (id: string): Graph => ({
  id, name: `Flow ${id}`, description: '', backend: 'local', layout: 2,
  nodes: [agent(id, 'w', 'Writer'), agent(id, 'k', 'Lint', { x: 30, instructionsFile: '', check: { command: 'npm test', timeoutMin: 5 } })],
  edges: [{ id: 'e1', from: 'w', to: 'k', kind: 'handoff' }],
})

// The actions over a host made of plain maps, the first graph open; every permission check allows.
function memory(graphs: Graph[], register: (spec: { name: string; description: string }) => Promise<void> = async () => undefined) {
  const kv = new Map<string, unknown>([...graphs.map(g => [`graph:${g.id}`, g] as const), ['graphs', graphs.map(g => ({ id: g.id, name: g.name }))]])
  const fs = new Map<string, string>(graphs.map(g => [`${ROOT}/${g.id}/w.md`, 'Write the draft.']))
  const slots: Slots = { index: [], graph: graphs[0]!, ui: { ...EMPTY_UI, graphId: graphs[0]!.id, selected: 'w' }, run: null, agents: [] }
  const host = {
    env: { get: async (name: string) => (name === 'USERPROFILE' ? HOME : undefined) },
    store: {
      get: async (key: string) => kv.get(key),
      set: async (key: string, value: unknown) => void kv.set(key, JSON.parse(JSON.stringify(value))),
      delete: async (key: string) => void kv.delete(key),
    },
    fs: {
      exists: async (path: string) => fs.has(path),
      read: async (path: string) => fs.get(path) ?? '',
      write: async (path: string, text: string) => void fs.set(path, text),
    },
    process: { run: async (argv: string[]) => (fs.delete(argv[argv.length - 1]!), { exitCode: 0, stdout: '', stderr: '' }) },
    tool: { register, check: async () => ({ decision: 'allow' }) },
    clock: { now: async () => 0 },
    ui: { toast: () => undefined },
    read: async (slot: keyof Slots) => slots[slot],
    update: async (slot: keyof Slots, change: (value: unknown) => unknown) => ((slots as Record<string, unknown>)[slot] = change(slots[slot])),
  } as unknown as Host
  return { host, kv, fs, slots }
}

const stored = (m: ReturnType<typeof memory>, id: string) => m.kv.get(`graph:${id}`) as Graph
const instructionsOf = async (m: ReturnType<typeof memory>, g: Graph, name: string) =>
  (await libraryOf(m.host)).instructions(g.nodes.find(n => n.name === name)!)
const key = (k: 'z' | 'y') => ({ kind: 'key', key: k, ctrl: true }) as const

test('one Ctrl+Z undoes the whole batch, instructions files included, and Ctrl+Y redoes it', async () => {
  const before = flow('u1')
  const m = memory([before])
  const text = await editGraphTool(m.host, {
    graph: 'u1',
    changes: [
      { op: 'set_instructions', card: 'Writer', text: 'Write it twice.' },
      { op: 'add_card', kind: 'agent', name: 'Reviewer', x: 2, y: 8 },
      { op: 'set_instructions', card: 'Reviewer', text: 'Review it.' },
      { op: 'add_arrow', from: 'Writer', to: 'Reviewer', kind: 'delegate' },
      { op: 'update_card', card: 'Lint', timeoutMin: 9 },
    ],
  })
  expect(text.startsWith('Changed agent graph "Flow u1" (u1) as one undo step:')).toBe(true)
  const after = stored(m, 'u1')
  expect(m.slots.graph).toEqual(after)
  expect(await instructionsOf(m, after, 'Writer')).toBe('Write it twice.')
  expect(await instructionsOf(m, after, 'Reviewer')).toBe('Review it.')
  // Every file is in the graph's own folder; the old instructions are kept for the undo.
  for (const path of m.fs.keys()) expect(path.startsWith(`${ROOT}/u1/`)).toBe(true)
  expect(m.fs.get(`${ROOT}/u1/w.md`)).toBe('Write the draft.')

  await onCanvas(m.host, key('z'))
  expect(stored(m, 'u1')).toEqual(before)
  expect(m.slots.graph).toEqual(before)
  expect(await instructionsOf(m, before, 'Writer')).toBe('Write the draft.')
  const reviewerFile = after.nodes.find(n => n.name === 'Reviewer')!.instructionsFile
  expect(m.fs.has(reviewerFile)).toBe(false)

  await onCanvas(m.host, key('y'))
  expect(stored(m, 'u1')).toEqual(after)
  expect(await instructionsOf(m, after, 'Writer')).toBe('Write it twice.')
  expect(await instructionsOf(m, after, 'Reviewer')).toBe('Review it.')
})

test('an edit registers the run tool again, and a rename retires the old name', async () => {
  const g = flow('t1')
  const specs: { name: string; description: string }[] = []
  const m = memory([g], async spec => void specs.push(spec))
  await editGraphTool(m.host, { graph: 't1', changes: [{ op: 'update_card', card: 'Writer', budgetUsd: 4 }] })
  expect(specs.map(s => s.name)).toEqual([toolName(g)])
  await editGraphTool(m.host, { graph: 't1', changes: [{ op: 'set_graph', name: 'Renamed' }] })
  const renamed = stored(m, 't1')
  expect(renamed.name).toBe('Renamed')
  expect(specs.slice(1).map(s => s.name)).toEqual([toolName(renamed), toolName(g)])
  expect(specs[2]!.description.startsWith('Retired: the agent graph "Flow t1" was renamed.')).toBe(true)
})

test('when the run tool cannot be registered, the graph is still changed and the result says so', async () => {
  const m = memory([flow('t2')], async () => {
    throw new Error('the engine is busy')
  })
  const text = await editGraphTool(m.host, { graph: 't2', changes: [{ op: 'update_card', card: 'Writer', name: 'Author' }] })
  expect(stored(m, 't2').nodes[0]!.name).toBe('Author')
  expect(text.startsWith('Changed agent graph "Flow t2" (t2) as one undo step, but the run tool could not be re-registered: the engine is busy\n')).toBe(true)
  expect(text).toContain('- update agent "Writer" (w): name: "Writer" → "Author"')
})

test('editing a graph that is not open leaves the pane alone; editing the open one updates it', async () => {
  const open = flow('p1')
  const m = memory([open, flow('p2')])
  await editGraphTool(m.host, { graph: 'p2', changes: [{ op: 'set_graph', description: 'Other' }] })
  expect(stored(m, 'p2').description).toBe('Other')
  expect(m.slots.graph).toBe(open)
  expect(m.slots.ui.selected).toBe('w')
  await editGraphTool(m.host, { graph: 'Flow p1', changes: [{ op: 'remove_card', card: 'Writer' }] })
  expect(m.slots.graph).toEqual(stored(m, 'p1'))
  expect(m.slots.graph?.nodes.map(n => n.name)).toEqual(['Lint'])
  // The removed card is no longer selected, and its file is gone.
  expect(m.slots.ui.selected).toBeNull()
  expect(m.fs.has(`${ROOT}/p1/w.md`)).toBe(false)
})

test('the result lists the change lines and the problems after the edit', async () => {
  const m = memory([flow('s1')])
  const text = await editGraphTool(m.host, {
    graph: 's1',
    changes: [{ op: 'add_arrow', from: 'Lint', to: 'Writer', kind: 'handoff' }, { op: 'set_graph', description: 'Loops' }],
  })
  const arrow = stored(m, 's1').edges[1]!.id
  const loop = '"Handoff arrows form a loop through this agent, so the run would never finish."'
  expect(text).toBe([
    'Changed agent graph "Flow s1" (s1) as one undo step:',
    `- add arrow (${arrow}) "Lint" (k) → "Writer" (w): handoff`,
    '- set graph: description "" → "Loops"',
    'Problems:',
    `- card "Writer" (w): ${loop}`,
    `- card "Lint" (k): ${loop}`,
    'Warnings: none',
  ].join('\n'))
})
