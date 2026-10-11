import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph, RunView } from '../types'
import { connect } from '../hooks/model'
import { runGraph, type Backend, type Handoff, type NodeOutcome, type RunHooks } from '../hooks/runner'

declare const setTimeout: (run: () => void, ms?: number) => unknown

const agent = (id: string): AgentNode => ({
  id, name: id.toUpperCase(), x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
const g0 = (nodes: AgentNode[]): Graph => ({ id: 'g', name: 'G', description: '', backend: 'local', nodes, edges: [] })
// p → a: a gets p's answer as its input.
const chain = (): Graph => connect(g0([agent('p'), agent('a')]), 'p', 'a', 'handoff')
// p → a → r → d with a retry arrow r ↺ a.
function loopGraph(): Graph {
  const g = connect(connect(connect(g0([agent('p'), agent('a'), agent('r'), agent('d')]), 'p', 'a', 'handoff'), 'a', 'r', 'handoff'), 'r', 'd', 'handoff')
  return { ...g, edges: [...g.edges, { id: 'r1', from: 'r', to: 'a', kind: 'retry' }] }
}

const busy: NodeOutcome = { ok: false, reason: 'API Error: 529 Overloaded', transient: { kind: 'overloaded', text: 'API Error: 529 Overloaded' } }

// A backend whose starts end when the test says so. Its stop only records (the start keeps running until ended).
function controlled() {
  const started: Array<{ id: string; prompt: string; inputs: Handoff[]; onCost: (usd: number, estimated?: boolean) => void }> = []
  const pending = new Map<string, (o: NodeOutcome) => void>()
  const stopped: string[] = []
  const backend: Backend = {
    prepare: async () => [],
    start: async (n, prompt, inputs, onCost) => {
      started.push({ id: n.id, prompt, inputs, onCost })
      let finish!: (o: NodeOutcome) => void
      const done = new Promise<NodeOutcome>(resolve => (finish = resolve))
      pending.set(n.id, finish)
      return { done, stop: async () => void stopped.push(n.id) }
    },
  }
  const end = async (id: string, outcome?: NodeOutcome | string) => {
    await until(() => pending.has(id))
    const finish = pending.get(id)!
    pending.delete(id)
    finish(outcome === undefined ? { ok: true, text: `out-${id}`, files: [] } : typeof outcome === 'string' ? { ok: true, text: outcome, files: [] } : outcome)
    await tick()
  }
  return { backend, started, end, stopped, ids: () => started.map(s => s.id) }
}

// A clock whose waits end when the test releases (or refuses) them.
function clock() {
  const waits: Array<{ ms: number; release: () => void; refuse: () => void }> = []
  const wait = (ms: number) => new Promise<void>((resolve, reject) => void waits.push({ ms, release: resolve, refuse: () => reject(new Error('no clock')) }))
  return { waits, wait, restartWaits: () => waits.filter(w => w.ms !== 15_000).map(w => w.ms) }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))
async function until(done: () => boolean) {
  for (let i = 0; i < 500 && !done(); i++) await tick()
  expect(done()).toBe(true)
}

function harness(graph: Graph, over: Partial<RunHooks> = {}) {
  const c = controlled()
  const k = clock()
  const views: RunView[] = []
  const controller = new AbortController()
  const running = runGraph(graph, 'T', c.backend, { onUpdate: v => void views.push(v), signal: controller.signal, wait: k.wait, now: () => 1000, ...over })
  return { ...c, ...k, views, controller, running, last: () => views.at(-1)! }
}

test('a temporary failure waits 30 s, then starts the agent again with the same input, and it ends done', async () => {
  const h = harness(chain())
  await h.end('p')
  await h.end('a', busy)
  await until(() => h.waits.length === 1)
  expect(h.waits[0]!.ms).toBe(30_000)
  // While it waits it stays running (the scheduler must not start it again), and the failed start was asked to stop.
  const waiting = h.last().nodes['a']!
  expect(waiting.status).toBe('running')
  expect(waiting.restartWait).toEqual({ attempt: 1, of: 3, until: 31_000, kind: 'overloaded', error: 'API Error: 529 Overloaded' })
  expect(waiting.restarts).toHaveLength(1)
  expect(h.stopped).toEqual(['a'])
  expect(h.ids()).toEqual(['p', 'a'])
  h.waits[0]!.release()
  await h.end('a', 'second time lucky')
  await h.running

  expect(h.ids()).toEqual(['p', 'a', 'a'])
  const [first, second] = h.started.filter(s => s.id === 'a')
  expect(second!.prompt).toBe(first!.prompt)
  expect(second!.inputs).toEqual(first!.inputs)
  const a = h.last().nodes['a']!
  expect(a).toMatchObject({ status: 'done', output: 'second time lucky', startedAt: 1000 })
  expect(a.restartWait).toBeUndefined()
  expect(a.restarts).toEqual([{ attempt: 1, at: 1000, kind: 'overloaded', error: 'API Error: 529 Overloaded', waitMs: 30_000 }])
})

test('three temporary failures wait 30 s, 2 min and 5 min; a fourth ends it failed, saying it gave up', async () => {
  const h = harness(g0([agent('a')]))
  for (let i = 0; i < 3; i++) {
    await h.end('a', busy)
    await until(() => h.waits.length === i + 1)
    h.waits[i]!.release()
  }
  await h.end('a', busy)
  await h.running
  expect(h.restartWaits()).toEqual([30_000, 120_000, 300_000])
  expect(h.ids()).toEqual(['a', 'a', 'a', 'a'])
  const a = h.last().nodes['a']!
  expect(a.status).toBe('failed')
  expect(a.error).toBe('API Error: 529 Overloaded (gave up after 3 automatic retries)')
  expect(a.restarts?.map(r => [r.attempt, r.waitMs])).toEqual([[1, 30_000], [2, 120_000], [3, 300_000]])
})

test('a failure the backend did not find temporary is not retried', async () => {
  const h = harness(g0([agent('a')]))
  await h.end('a', { ok: false, reason: 'Hit its $2 budget.' })
  await h.running
  expect(h.ids()).toEqual(['a'])
  expect(h.waits).toEqual([])
  expect(h.last().nodes['a']).toMatchObject({ status: 'failed', error: 'Hit its $2 budget.' })
  expect(h.last().nodes['a']?.restarts).toBeUndefined()
})

test('Stop during the wait ends it: no new start, the agent ends cancelled, and the retry is marked stopped', async () => {
  const h = harness(g0([agent('a')]))
  await h.end('a', busy)
  await until(() => h.waits.length === 1)
  h.controller.abort()
  await h.running
  expect(h.ids()).toEqual(['a'])
  const a = h.last().nodes['a']!
  expect(a).toMatchObject({ status: 'cancelled', error: 'Stopped.' })
  expect(a.restartWait).toBeUndefined()
  expect(a.restarts).toEqual([{ attempt: 1, at: 1000, kind: 'overloaded', error: 'API Error: 529 Overloaded', waitMs: 30_000, stopped: true }])
})

test('a run cap that stops the run during the wait ends the agent cancelled with the cap text', async () => {
  const h = harness(g0([agent('a')]))
  await h.end('a', busy)
  await until(() => h.waits.length === 1)
  h.controller.abort('Stopped: the run reached its $5.00 cap.')
  await h.running
  expect(h.ids()).toEqual(['a'])
  expect(h.last().nodes['a']).toMatchObject({ status: 'cancelled', error: 'Stopped: the run reached its $5.00 cap.' })
})

test('a temporary failure that arrives after Stop is not retried', async () => {
  const h = harness(g0([agent('a')]))
  await until(() => h.started.length === 1)
  h.controller.abort()
  await h.end('a', busy)
  await h.running
  expect(h.ids()).toEqual(['a'])
  expect(h.restartWaits()).toEqual([])
  expect(h.last().nodes['a']?.status).toBe('cancelled')
  expect(h.last().nodes['a']?.restarts).toBeUndefined()
})

test('without a clock to wait with, a temporary failure ends failed as it came, and no retry is recorded', async () => {
  const none = harness(g0([agent('a')]), { wait: undefined })
  await none.end('a', busy)
  await none.running
  expect(none.ids()).toEqual(['a'])
  expect(none.last().nodes['a']).toMatchObject({ status: 'failed', error: 'API Error: 529 Overloaded' })

  const refused = harness(g0([agent('a')]))
  await refused.end('a', busy)
  await until(() => refused.waits.length === 1)
  refused.waits[0]!.refuse()
  await refused.running
  expect(refused.ids()).toEqual(['a'])
  const a = refused.last().nodes['a']!
  expect(a).toMatchObject({ status: 'failed', error: 'API Error: 529 Overloaded' })
  expect(a.restarts).toBeUndefined()
  expect(a.restartWait).toBeUndefined()
})

test('the cost of every start adds up', async () => {
  const h = harness(g0([agent('a')]))
  await until(() => h.started.length === 1)
  h.started[0]!.onCost(0.5)
  await h.end('a', busy)
  await until(() => h.waits.length === 1)
  h.waits[0]!.release()
  await until(() => h.started.length === 2)
  h.started[1]!.onCost(0.3)
  await h.end('a')
  await h.running
  expect(Math.round((h.last().nodes['a']?.costUsd ?? 0) * 100) / 100).toBe(0.8)
})

test('a cost reported as an estimate is marked estimated until an exact report of the same start replaces it', async () => {
  const exact = harness(g0([agent('a')]))
  await until(() => exact.started.length === 1)
  exact.started[0]!.onCost(0.1, true)
  await until(() => exact.views.at(-1)?.nodes['a']?.costUsd === 0.1)
  expect(exact.last().nodes['a']).toMatchObject({ costUsd: 0.1, costEstimated: true })
  exact.started[0]!.onCost(0.3, false)
  await exact.end('a')
  await exact.running
  expect(Math.round((exact.last().nodes['a']!.costUsd ?? 0) * 100) / 100).toBe(0.3)
  expect(exact.last().nodes['a']!.costEstimated).toBeUndefined()

  // Stopped (or crashed) before the exact total came: the estimate stays marked.
  const rough = harness(g0([agent('a')]))
  await until(() => rough.started.length === 1)
  rough.started[0]!.onCost(0.2, true)
  await rough.end('a', { ok: false, reason: 'Stopped.' })
  await rough.running
  expect(rough.last().nodes['a']).toMatchObject({ costUsd: 0.2, costEstimated: true })
})

test('an earlier start that ended on an estimate keeps the card\'s cost estimated after an exact later start', async () => {
  const h = harness(g0([agent('a')]))
  await until(() => h.started.length === 1)
  h.started[0]!.onCost(0.5, true)
  await h.end('a', busy)
  await until(() => h.waits.length === 1)
  h.waits[0]!.release()
  await until(() => h.started.length === 2)
  h.started[1]!.onCost(0.3, false)
  await h.end('a')
  await h.running
  expect(h.last().nodes['a']).toMatchObject({ status: 'done', costEstimated: true })
})

test('a reviewer that fails for a temporary reason and then passes records one round', async () => {
  const h = harness(loopGraph())
  await h.end('p')
  await h.end('a')
  await h.end('r', busy)
  await until(() => h.waits.length === 1)
  h.waits[0]!.release()
  await h.end('r', 'Fine.\nVERDICT: pass')
  await h.end('d')
  await h.running
  expect(h.ids()).toEqual(['p', 'a', 'r', 'r', 'd'])
  const r = h.last().nodes['r']!
  expect(r.status).toBe('done')
  expect(r.rounds?.map(x => x.passed)).toEqual([true])
  expect(r.restarts).toHaveLength(1)
})

test('the three retries are per agent per run: a card sent back by its reviewer keeps its count', async () => {
  const h = harness(loopGraph())
  await h.end('p')
  for (let i = 0; i < 2; i++) {
    await h.end('a', busy)
    await until(() => h.waits.length === i + 1)
    h.waits[i]!.release()
  }
  await h.end('a', 'a1')
  await h.end('r', 'Missing tests.\nVERDICT: fail')
  // Round 2: one retry left.
  await h.end('a', busy)
  await until(() => h.waits.length === 3)
  expect(h.last().nodes['a']).toMatchObject({ status: 'running', round: 2, restartWait: { attempt: 3, of: 3 } })
  h.waits[2]!.release()
  await h.end('a', busy)
  await h.running
  expect(h.restartWaits()).toEqual([30_000, 120_000, 300_000])
  const a = h.last().nodes['a']!
  expect(a.status).toBe('failed')
  expect(a.error).toBe('API Error: 529 Overloaded (gave up after 3 automatic retries)')
  expect(a.restarts?.map(r => r.attempt)).toEqual([1, 2, 3])
})
