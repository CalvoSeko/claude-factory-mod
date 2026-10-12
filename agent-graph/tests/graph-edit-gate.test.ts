import { expect } from 'claude-code/testing'
import { test } from './kit'

import { editGraphTool, onCanvas, startRun, stopRun, type Host } from '../hooks/actions'
import { EMPTY_UI, type Slots } from '../hooks/state'
import { notTrustedText } from '../hooks/trust'
import type { AgentNode, Graph } from '../types'

const HOME = '/home/u'
const ROOT = `${HOME}/.claude/agent-graph`

const agent = (graphId: string, id: string, name: string, over: Partial<AgentNode> = {}): AgentNode => ({
  id, name, x: 2, y: 1, instructionsFile: `${ROOT}/${graphId}/${id}.md`,
  skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2, ...over,
})
// A valid graph: a writer hands off to a lint check.
const flow = (id: string, over: Partial<Graph> = {}): Graph => ({
  id, name: `Flow ${id}`, description: '', backend: 'local', layout: 2,
  nodes: [agent(id, 'w', 'Writer'), agent(id, 'k', 'Lint', { x: 30, instructionsFile: '', check: { command: 'npm test', timeoutMin: 5 } })],
  edges: [{ id: 'e1', from: 'w', to: 'k', kind: 'handoff' }],
  ...over,
})
const filesOf = (g: Graph) => ({ [`${ROOT}/${g.id}/w.md`]: 'Write the draft.' })

type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string }

// The actions over a host made of plain maps, with tool.check and ui.ask mocks that record their calls.
function memory(g: Graph, mocks: { check?: () => Promise<Verdict>; ask?: (question: string) => Promise<string> } = {}) {
  const kv = new Map<string, unknown>([[`graph:${g.id}`, g], ['graphs', [{ id: g.id, name: g.name }]]])
  const fs = new Map(Object.entries(filesOf(g)))
  const slots: Slots = { index: [], graph: g, ui: { ...EMPTY_UI, graphId: g.id, task: 'Do it' }, run: null, agents: [] }
  const checks: unknown[] = []
  const questions: string[] = []
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
      list: async () => [],
    },
    process: { run: async (argv: string[]) => (fs.delete(argv[argv.length - 1]!), { exitCode: 0, stdout: '', stderr: '' }) },
    tool: {
      register: async () => undefined,
      check: async (input: unknown) => (checks.push(input), (mocks.check ?? (async () => ({ decision: 'allow' })))()),
    },
    clock: { after: () => undefined, now: async () => 0 },
    ui: {
      open: async () => ({ isPlaced: true }), close: async () => undefined, toast: () => undefined,
      ask: async (question: string) => (questions.push(question), (mocks.ask ?? (async () => 'Apply'))(question)),
    },
    prompt: { submit: async () => undefined },
    read: async (slot: keyof Slots) => slots[slot],
    update: async (slot: keyof Slots, change: (value: unknown) => unknown) => ((slots as Record<string, unknown>)[slot] = change(slots[slot])),
  } as unknown as Host
  // What an edit could have changed: the store and the files.
  const state = () => JSON.stringify({ kv: [...kv], fs: [...fs] })
  return { host, kv, fs, slots, checks, questions, state }
}

const rename = (graph: string) => ({ graph, changes: [{ op: 'update_card', card: 'Writer', name: 'Author' }] })
const stored = (m: ReturnType<typeof memory>, id: string) => m.kv.get(`graph:${id}`) as Graph

test('a deny is refused with its reason, with no question, and nothing changes', async () => {
  const m = memory(flow('d1'), { check: async () => ({ decision: 'deny', reason: 'Denied by rule mcp__agent-graph__edit_graph' }) })
  const before = m.state()
  const text = await editGraphTool(m.host, rename('d1'))
  expect(text.startsWith('Not changed: ')).toBe(true)
  expect(text).toContain('Denied by rule mcp__agent-graph__edit_graph')
  expect(m.questions).toEqual([])
  expect(m.state()).toBe(before)
})

test('a permission check that throws is refused, with no question, and nothing changes', async () => {
  const m = memory(flow('d2'), { check: async () => { throw new Error('no rules') } })
  const before = m.state()
  expect(await editGraphTool(m.host, rename('d2'))).toBe('Not changed: the permission check failed: no rules')
  expect(m.questions).toEqual([])
  expect(m.state()).toBe(before)
})

test('allow applies the batch without a question, and the check is asked about the call as made', async () => {
  const m = memory(flow('a1'))
  const input = rename('a1')
  const text = await editGraphTool(m.host, input)
  expect(text.startsWith('Changed agent graph "Flow a1" (a1) as one undo step:')).toBe(true)
  expect(m.checks).toEqual([{ tool: 'mcp__agent-graph__edit_graph', input }])
  expect(m.questions).toEqual([])
  expect(stored(m, 'a1').nodes[0]!.name).toBe('Author')
})

test("allow still asks before a check card's command changes, and Apply applies it", async () => {
  const m = memory(flow('a2'))
  const command = 'npm test && rm -rf "dist"'
  await editGraphTool(m.host, { graph: 'a2', changes: [{ op: 'update_card', card: 'Lint', command }] })
  expect(m.questions.length).toBe(1)
  expect(m.questions[0]).toContain(JSON.stringify(command))
  expect(m.questions[0]!.endsWith('?')).toBe(true)
  expect(stored(m, 'a2').nodes[1]!.check?.command).toBe(command)
})

test('the question holds a 5,000-character instructions text in full', async () => {
  const long = `Say "hi".\n${'x'.repeat(90)}`.repeat(50)
  expect(long.length).toBe(5000)
  const m = memory(flow('a3'), { check: async () => ({ decision: 'ask' }) })
  await editGraphTool(m.host, { graph: 'a3', changes: [{ op: 'set_instructions', card: 'Writer', text: long }] })
  expect(m.questions.length).toBe(1)
  expect(m.questions[0]).toContain(JSON.stringify(long))
})

test('under ask, Apply applies; Cancel, free text and a dismissed question change nothing', async () => {
  const applied = memory(flow('q1'), { check: async () => ({ decision: 'ask' }) })
  expect((await editGraphTool(applied.host, rename('q1'))).startsWith('Changed agent graph')).toBe(true)
  expect(stored(applied, 'q1').nodes[0]!.name).toBe('Author')
  const answers: (() => Promise<string>)[] = [async () => 'Cancel', async () => 'apply it please', async () => { throw new Error('dismissed') }]
  for (const [i, answer] of answers.entries()) {
    const m = memory(flow(`q${i + 2}`), { check: async () => ({ decision: 'ask' }), ask: answer })
    const before = m.state()
    expect((await editGraphTool(m.host, rename(`q${i + 2}`))).startsWith('Not changed: ')).toBe(true)
    expect(m.questions.length).toBe(1)
    expect(m.state()).toBe(before)
  }
})

test('an untrusted graph, a call from a subagent and a running graph are refused before the permission check', async () => {
  const untrusted = flow('r1', { trusted: false })
  const u = memory(untrusted)
  expect(await editGraphTool(u.host, rename('r1'))).toBe(`Not changed: ${notTrustedText(untrusted)}`)
  expect(u.checks).toEqual([])

  const s = memory(flow('r2'))
  expect(await editGraphTool(s.host, rename('r2'), { agentId: 'a1' })).toBe(
    "Not changed: agent-graph's read_graph and edit_graph are for the main conversation only.",
  )
  expect(s.checks).toEqual([])

  const running = flow('r3')
  const r = memory(running)
  expect(await startRun(r.host, running, 'Do it', 'tool')).toBeUndefined()
  const before = r.state()
  const text = await editGraphTool(r.host, rename('r3'))
  stopRun()
  expect(text).toContain('stop the run first')
  expect(r.checks).toEqual([])
  expect(r.state()).toBe(before)
})

test('a bad value changes nothing: not the store, the files or the undo history', async () => {
  const m = memory(flow('b1'))
  const before = m.state()
  const text = await editGraphTool(m.host, { graph: 'b1', changes: [{ op: 'set_instructions', card: 'Writer', text: 'New' }, { op: 'update_card', card: 'Writer', budgetUsd: 0 }] })
  expect(text).toBe('Not changed: Change 2 (update_card) budgetUsd: a number of dollars above 0 and at most 100.')
  expect(m.checks).toEqual([])
  expect(m.state()).toBe(before)
  // No undo step was made: Ctrl+Z has nothing to go back to.
  await onCanvas(m.host, { kind: 'key', key: 'z', ctrl: true })
  expect(m.state()).toBe(before)
})

test('a graph that changes while the question is open is not changed', async () => {
  const g = flow('c1')
  const m = memory(g, {
    check: async () => ({ decision: 'ask' }),
    ask: async () => (m.kv.set('graph:c1', { ...g, description: 'Edited in the pane' }), 'Apply'),
  })
  const text = await editGraphTool(m.host, rename('c1'))
  expect(text).toBe('Not changed: the graph changed while waiting for approval; call again.')
  expect(stored(m, 'c1').nodes[0]!.name).toBe('Writer')
  expect(m.fs.size).toBe(1)
})

test('a call stopped before the question is answered is not applied', async () => {
  const ctl = new AbortController()
  const m = memory(flow('c2'), { check: async () => ({ decision: 'ask' }), ask: async () => (ctl.abort(), 'Apply') })
  const before = m.state()
  const text = await editGraphTool(m.host, rename('c2'), { signal: ctl.signal })
  expect(text.startsWith('Not changed: ')).toBe(true)
  expect(m.state()).toBe(before)
})
