import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph } from '../types'
import { isCmdSafe } from '../hooks/compile'
import { createMeter, type Usage } from '../hooks/cost'
import { createGuard } from '../hooks/guard'
import { createHeadlessBackend } from '../hooks/headless'
import { createCompletions, createLocalBackend } from '../hooks/local'
import { connect } from '../hooks/model'
import { runGraph, type Backend, type NodeOutcome } from '../hooks/runner'

const agent = (id: string, over: Partial<AgentNode> = {}): AgentNode => ({
  id, name: id.toUpperCase(), x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2, ...over,
})

// a → c, with c ↺ a, where c always fails.
function failingLoop(retries: number): Graph {
  const g = connect({ id: 'g', name: 'G', description: '', backend: 'local', nodes: [agent('a'), agent('c')], edges: [] }, 'a', 'c', 'handoff')
  return { ...g, edges: [...g.edges, { id: 'r1', from: 'c', to: 'a', kind: 'retry', retries }] }
}

// Every start ends at once: a answers, c fails.
function instant() {
  const starts: string[] = []
  const backend: Backend = {
    prepare: async () => [],
    start: async n => {
      starts.push(n.id)
      const outcome: NodeOutcome = n.id === 'c' ? { ok: false, reason: 'Broken.' } : { ok: true, text: 'done', files: [] }
      return { done: Promise.resolve(outcome), stop: async () => {} }
    },
  }
  return { backend, starts }
}

test('a retry arrow asking for 1000 retries stops after 10, in 11 rounds', async () => {
  const { backend, starts } = instant()
  const result = await runGraph(failingLoop(1000), 'T', backend, { onUpdate: () => {} })
  expect('failures' in result ? result.failures : {}).toEqual({ c: 'Still failing after 10 retries: Broken.' })
  expect(starts.filter(id => id === 'c')).toHaveLength(11)
})

test('a retry arrow with retries that are not a whole number gets the default 3', async () => {
  const { backend, starts } = instant()
  const result = await runGraph(failingLoop('x' as never), 'T', backend, { onUpdate: () => {} })
  expect('failures' in result ? result.failures : {}).toEqual({ c: 'Still failing after 3 retries: Broken.' })
  expect(starts.filter(id => id === 'c')).toHaveLength(4)
})

// 100 000 input and 20 000 output tokens of Sonnet 4.6: $0.60.
const request: Usage = { model: 'claude-sonnet-4-6', input_tokens: 100_000, output_tokens: 20_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test('Local: a card with a budget of 0, below 0 or not a number stops at the default $2', async () => {
  for (const budgetUsd of [0, -1, Number.NaN]) {
    const g: Graph = { id: 'g', name: 'Flow', description: '', backend: 'local', nodes: [agent('a', { budgetUsd })], edges: [] }
    const meter = createMeter()
    const stopped: string[] = []
    const backend = createLocalBackend(g, {
      register: async () => {},
      spawn: async () => ({ agentId: 'agent-1' }),
      stopAgent: async id => void stopped.push(id),
      instructions: async () => '',
      context: { kind: async () => 'missing', read: async () => '', files: async () => [] },
      completions: createCompletions(),
      guard: createGuard(),
      meter: () => meter,
    })
    const run = await backend.start(g.nodes[0]!, 'go', [], () => {})
    // $1.80: still under the default.
    for (let i = 0; i < 3; i++) meter.add('agent-1', request, 0)
    expect(stopped).toEqual([])
    meter.add('agent-1', request, 0)
    expect(await run.done).toEqual({ ok: false, reason: 'Hit its $2 budget.' })
    expect(stopped).toEqual(['agent-1'])
  }
})

test('Headless: an unsafe settings path or agent name is a problem on the card; nothing is written or spawned', async () => {
  const cases: Array<[string, AgentNode]> = [['/home/a&b', agent('a')], ['/home/u', agent('a&b')]]
  for (const [home, node] of cases) {
    const g: Graph = { id: 'g', name: 'Flow', description: '', backend: 'headless', nodes: [node], edges: [] }
    const writes: string[] = []
    const spawned: string[][] = []
    const backend = createHeadlessBackend(g, {
      home: async () => home,
      write: async path => void writes.push(path),
      spawn: argv => {
        spawned.push(argv)
        throw new Error('no child')
      },
      instructions: async () => '',
      context: { kind: async () => 'missing', read: async () => '', files: async () => [] },
      checks: { prepare: async () => [], start: async () => ({ done: Promise.resolve({ ok: true, text: '', files: [] }), stop: async () => {} }) },
    })
    const result = await runGraph(g, 'T', backend, { onUpdate: () => {} })
    expect('problems' in result ? result.problems.map(p => p.target) : []).toEqual([{ kind: 'node', id: node.id }])
    expect(writes).toEqual([])
    expect(spawned).toEqual([])
  }
})

test('isCmdSafe takes letters, digits, space and _ - . : / \\ only', () => {
  expect(isCmdSafe('C:\\Users\\x y\\.claude\\a-b_c.md')).toBe(true)
  for (const c of ['&', '|', '<', '>', '^', '%', '"', '!', '(', ')', ';']) expect(isCmdSafe(`C:/a${c}b.md`)).toBe(false)
})
