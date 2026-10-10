import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { ActivityItem, AgentNode, Graph, NodeStatus, RunIndex, RunRecord, RunSummary, RunView } from '../types'
import { connect, runStart, updateNode } from '../hooks/model'
import { createTracker } from '../hooks/activity'
import { RECORD_MAX_CHARS, RUNS_KEPT, fingerprintOf, helperActivity, slimmed, fnv1a, graphForRun, planFromHere, recordOf, staleOf, summaryOf, withRecord } from '../hooks/records'

const node = (id: string, over: Partial<AgentNode> = {}): AgentNode => ({
  id, name: id.toUpperCase(), x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2, ...over,
})
const graphOf = (ids: string[]): Graph => ({ id: 'g', name: 'G', description: '', backend: 'local', nodes: ids.map(id => node(id)), edges: [] })
const chain = (ids: string[]): Graph => ids.slice(1).reduce((g, id, i) => connect(g, ids[i]!, id, 'handoff'), graphOf(ids))
const text = (n: AgentNode) => `text of ${n.id}`
const fp = (g: Graph, id: string, instructions: (n: AgentNode) => string | undefined = text) => fingerprintOf(g, id, instructions)

test('fnv1a is a 32-bit FNV-1a hash in 8 hex digits', () => {
  expect(fnv1a('')).toBe('811c9dc5')
  expect(fnv1a('a')).toBe('e40c292c')
  expect(fnv1a('foobar')).toBe('bf9cf968')
})

test('a fingerprint changes with instructions, skills, tools, model, context paths and predecessors', () => {
  const g = chain(['a', 'b'])
  const base = fp(g, 'b')!
  expect(base).toMatch(/^[0-9a-f]{8}$/)
  expect(fp(g, 'b')).toBe(base)
  expect(fp(g, 'b', n => `${text(n)} edited`)).not.toBe(base)
  expect(fp(updateNode(g, 'b', { skills: ['s'] }), 'b')).not.toBe(base)
  expect(fp(updateNode(g, 'b', { tools: ['Read'] }), 'b')).not.toBe(base)
  expect(fp(updateNode(g, 'b', { model: 'opus' }), 'b')).not.toBe(base)
  expect(fp(updateNode(g, 'b', { contextFiles: ['/x/notes.md'] }), 'b')).not.toBe(base)
  expect(fp(connect(g, 'c0', 'b', 'handoff'), 'b')).not.toBe(base)
  expect(fp(chain(['z', 'b']), 'b')).not.toBe(base)
})

test('a fingerprint ignores name, position and budget, and the order of context paths', () => {
  const g = updateNode(chain(['a', 'b']), 'b', { contextFiles: ['/x', '/y'] })
  const base = fp(g, 'b')
  expect(fp(updateNode(g, 'b', { name: 'Renamed', x: 40, y: 9, budgetUsd: 9 }), 'b')).toBe(base)
  expect(fp(updateNode(g, 'b', { contextFiles: ['/y', '/x'] }), 'b')).toBe(base)
})

test('a fingerprint follows delegate targets: their whenToUse and their own setup', () => {
  const g = connect(graphOf(['a', 'h']), 'a', 'h', 'delegate')
  const base = fp(g, 'a')!
  expect(fp(updateNode(g, 'h', { whenToUse: 'when stuck' }), 'a')).not.toBe(base)
  expect(fp(updateNode(g, 'h', { tools: ['Bash'] }), 'a')).not.toBe(base)
  expect(fp(g, 'a', n => (n.id === 'h' ? 'other' : text(n)))).not.toBe(base)
  expect(fp(updateNode(g, 'h', { name: 'Helper' }), 'a')).toBe(base)
})

test('a fingerprint survives a delegate loop', () => {
  const g = connect(connect(graphOf(['a', 'h']), 'a', 'h', 'delegate'), 'h', 'a', 'delegate')
  expect(fp(g, 'a')).toMatch(/^[0-9a-f]{8}$/)
})

test('a fingerprint is undefined when instructions are not cached', () => {
  const g = connect(graphOf(['a', 'h']), 'a', 'h', 'delegate')
  expect(fp(g, 'a', () => undefined)).toBeUndefined()
  expect(fp(g, 'a', n => (n.id === 'h' ? undefined : text(n)))).toBeUndefined()
})

test('a disabled middle agent changes its successor\'s fingerprint', () => {
  const g = chain(['a', 'b', 'c'])
  const base = fp(g, 'c')!
  const off = fp(updateNode(g, 'b', { disabled: true }), 'c')
  expect(off).toBeDefined()
  expect(off).not.toBe(base)
  // The rewired graph is what c sees: a hands straight to c.
  expect(off).toBe(fp(connect(graphOf(['a', 'c']), 'a', 'c', 'handoff'), 'c'))
})

const entry = (g: Graph, id: string, over: Partial<RunIndex['latest'][string]> = {}) => ({
  runId: 'r1', at: 1, fingerprint: fp(g, id)!, task: 'T', status: 'done' as NodeStatus, ...over,
})
const indexFor = (g: Graph, ids = g.nodes.map(n => n.id), over: Partial<RunIndex['latest'][string]> = {}): RunIndex => ({
  runs: [{ id: 'r1', at: 1, ending: 'finished', mode: 'full', taskLine: 'T', costUsd: 0 }],
  latest: Object.fromEntries(ids.map(id => [id, entry(g, id, over)])),
})

test('staleOf is empty before the first run', () => {
  const g = chain(['a', 'b'])
  expect(staleOf(g, { runs: [], latest: {} }, 'T', text)).toEqual({})
})

test('staleOf is empty when everything is up to date', () => {
  const g = chain(['a', 'b', 'c'])
  expect(staleOf(g, indexFor(g), 'T', text)).toEqual({})
})

test('a different task makes everything stale, trimmed text aside', () => {
  const g = chain(['a', 'b'])
  const index = indexFor(g)
  expect(staleOf(g, index, '  T\n', text)).toEqual({})
  expect(staleOf(g, index, 'other', text)).toEqual({ a: 'task', b: 'task' })
  // The task beats a failed entry too; with no entry there is nothing to compare, so it was never saved.
  const failed = indexFor(g, ['a'], { status: 'failed' })
  expect(staleOf(g, failed, 'other', text)).toEqual({ a: 'task', b: 'never' })
})

test('a blank task box changes nothing: there is no task to compare', () => {
  const g = chain(['a', 'b'])
  const index = indexFor(g)
  expect(staleOf(g, index, '', text)).toEqual({})
  expect(staleOf(g, index, '  \n', text)).toEqual({})
  // The other causes still count.
  expect(staleOf(g, index, '', n => (n.id === 'a' ? 'new text' : text(n)))).toEqual({ a: 'changed', b: 'upstream' })
})

test('an agent with no entry or a non-done latest was never saved', () => {
  const g = chain(['a', 'b', 'c'])
  const index = indexFor(g, ['a', 'b'])
  index.latest['b']!.status = 'failed'
  expect(staleOf(g, index, 'T', text)).toEqual({ b: 'never', c: 'never' })
})

test('a fingerprint mismatch is a change; upstream follows it down the chain', () => {
  const g = chain(['a', 'b', 'c'])
  const index = indexFor(g)
  const edited = (n: AgentNode) => (n.id === 'a' ? 'new text' : text(n))
  expect(staleOf(g, index, 'T', edited)).toEqual({ a: 'changed', b: 'upstream', c: 'upstream' })
  const middle = (n: AgentNode) => (n.id === 'b' ? 'new text' : text(n))
  expect(staleOf(g, index, 'T', middle)).toEqual({ b: 'changed', c: 'upstream' })
})

test('an agent keeps its own cause over upstream', () => {
  const g = chain(['a', 'b'])
  const index = indexFor(g)
  index.latest['b']!.status = 'cancelled'
  const edited = (n: AgentNode) => (n.id === 'a' ? 'new text' : text(n))
  expect(staleOf(g, index, 'T', edited)).toEqual({ a: 'changed', b: 'never' })
})

test('upstream joins fan-in from any stale predecessor', () => {
  const g = connect(connect(graphOf(['a', 'b', 'c']), 'a', 'c', 'handoff'), 'b', 'c', 'handoff')
  const index = indexFor(g)
  expect(staleOf(g, index, 'T', n => (n.id === 'b' ? 'new text' : text(n)))).toEqual({ b: 'changed', c: 'upstream' })
})

test('an unknown fingerprint is not stale', () => {
  const g = chain(['a', 'b'])
  expect(staleOf(g, indexFor(g), 'T', () => undefined)).toEqual({})
})

test('delegate-only helpers get no entry, nor do disabled agents', () => {
  const g = connect(connect(chain(['a', 'b']), 'a', 'h', 'delegate'), 'b', 'h', 'delegate')
  const withHelper = { ...g, nodes: [...g.nodes, node('h')] }
  const index = indexFor(withHelper, ['a', 'b'])
  index.latest['a']!.task = 'old'
  expect(Object.keys(staleOf(withHelper, index, 'T', text)).sort()).toEqual(['a', 'b'])
  const off = updateNode(withHelper, 'b', { disabled: true })
  expect(Object.keys(staleOf(off, index, 'T', text))).toEqual(['a'])
})

test('planFromHere reuses an up-to-date predecessor', () => {
  const g = chain(['a', 'b', 'c', 'd'])
  const plan = planFromHere(g, 'c', {})
  expect(new Set(plan.run)).toEqual(new Set(['c', 'd']))
  expect(plan.reuse).toEqual(['b'])
})

test('planFromHere re-runs a stale ancestor and walks past it', () => {
  const g = chain(['a', 'b', 'c', 'd'])
  const plan = planFromHere(g, 'c', { b: 'changed', c: 'upstream', d: 'upstream' })
  expect(new Set(plan.run)).toEqual(new Set(['c', 'd', 'b']))
  expect(plan.reuse).toEqual(['a'])
})

test('planFromHere re-runs stale ancestors recursively', () => {
  const g = chain(['a', 'b', 'c', 'd'])
  const plan = planFromHere(g, 'd', { a: 'changed', b: 'upstream', c: 'upstream', d: 'upstream' })
  expect(new Set(plan.run)).toEqual(new Set(['d', 'c', 'b', 'a']))
  expect(plan.reuse).toEqual([])
})

test('planFromHere from the first agent reuses nothing', () => {
  const g = chain(['a', 'b', 'c', 'd'])
  const plan = planFromHere(g, 'a', {})
  expect(new Set(plan.run)).toEqual(new Set(['a', 'b', 'c', 'd']))
  expect(plan.reuse).toEqual([])
})

test('planFromHere reuses the other branch feeding a fan-in', () => {
  const g = connect(connect(graphOf(['a', 'b', 'c']), 'a', 'c', 'handoff'), 'b', 'c', 'handoff')
  const plan = planFromHere(g, 'a', {})
  expect(new Set(plan.run)).toEqual(new Set(['a', 'c']))
  expect(plan.reuse).toEqual(['b'])
})

test('planFromHere plans on the graph without disabled agents', () => {
  const g = updateNode(chain(['a', 'b', 'c']), 'b', { disabled: true })
  const plan = planFromHere(g, 'c', {})
  expect(plan.run).toEqual(['c'])
  expect(plan.reuse).toEqual(['a'])
})

test('planFromHere with an unknown agent plans nothing', () => {
  expect(planFromHere(chain(['a', 'b']), 'zzz', {})).toEqual({ run: [], reuse: [] })
})

test('graphForRun joins run and reused agents with their handoff edges', () => {
  const g = chain(['a', 'b', 'c', 'd'])
  const out = graphForRun(g, { run: ['c', 'd'], reuse: ['b'] })
  expect(out.nodes.map(n => n.id)).toEqual(['b', 'c', 'd'])
  expect(out.edges.map(e => `${e.from}>${e.to}>${e.kind}`).sort()).toEqual(['b>c>handoff', 'c>d>handoff'])
  expect(out.id).toBe('g')
})

test('graphForRun drops delegate edges from reused agents and keeps the helpers of run agents', () => {
  let g = chain(['a', 'b'])
  g = { ...g, nodes: [...g.nodes, node('ha'), node('hb')] }
  g = connect(connect(g, 'a', 'ha', 'delegate'), 'b', 'hb', 'delegate')
  const out = graphForRun(g, { run: ['b'], reuse: ['a'] })
  expect(out.nodes.map(n => n.id).sort()).toEqual(['a', 'b', 'hb'])
  expect(out.edges.map(e => `${e.from}>${e.to}>${e.kind}`).sort()).toEqual(['a>b>handoff', 'b>hb>delegate'])
})

test('graphForRun keeps helpers of helpers of run agents', () => {
  let g = graphOf(['a'])
  g = { ...g, nodes: [...g.nodes, node('h1'), node('h2')] }
  g = connect(connect(g, 'a', 'h1', 'delegate'), 'h1', 'h2', 'delegate')
  const out = graphForRun(g, { run: ['a'], reuse: [] })
  expect(out.nodes.map(n => n.id).sort()).toEqual(['a', 'h1', 'h2'])
})

const viewOf = (nodes: RunView['nodes'], over: Partial<RunView> = {}): RunView => ({
  graphId: 'g', graphName: 'G', isRunning: false, task: 'Write it\nmore', result: 'RES', outputs: [{ id: 'f9', name: 'o.md', fromNode: 'b' }], nodes, ...over,
})
const meta = (over: Partial<Parameters<typeof recordOf>[2]> = {}) => ({
  id: 'r1', mode: 'full' as const, startedAt: 10, endedAt: 99, ending: 'finished' as const,
  fingerprints: { a: 'fa', b: 'fb' }, files: { a: [{ id: 'f1', name: 'x.md', fromNode: 'a' }] }, ...over,
})

test('recordOf keeps the graph without positions and builds one entry per view node', () => {
  const g = chain(['a', 'b'])
  g.nodes[0]!.x = 5
  const view = viewOf({
    a: { status: 'done', output: 'oa', costUsd: 0.5, startedAt: 11, endedAt: 20 },
    b: { status: 'failed', error: 'boom', link: 'https://x', reusedFrom: undefined },
  })
  const r = recordOf(g, view, meta())
  expect(r.id).toBe('r1')
  expect(r.graphId).toBe('g')
  expect(r.graphName).toBe('G')
  expect(r.task).toBe('Write it\nmore')
  expect(r.mode).toBe('full')
  expect(r.fromNode).toBeUndefined()
  expect([r.startedAt, r.endedAt, r.ending]).toEqual([10, 99, 'finished'])
  expect(r.graph.nodes.map(n => n.id)).toEqual(['a', 'b'])
  expect(r.graph.nodes.every(n => !('x' in n) && !('y' in n))).toBe(true)
  expect(r.graph.nodes[0]!.instructionsFile).toBe('a.md')
  expect(r.graph.edges).toEqual(g.edges)
  expect(r.nodes['a']).toEqual({ status: 'done', inputs: [], output: 'oa', files: [{ id: 'f1', name: 'x.md', fromNode: 'a' }], costUsd: 0.5, startedAt: 11, endedAt: 20, fingerprint: 'fa' })
  expect(r.nodes['b']).toEqual({ status: 'failed', inputs: ['a'], error: 'boom', files: [], fingerprint: 'fb' })
  expect(r.result).toBe('RES')
  expect(r.outputs).toEqual([{ id: 'f9', name: 'o.md', fromNode: 'b' }])
})

test('recordOf copies reusedFrom and records the clicked agent', () => {
  const g = chain(['a', 'b'])
  const view = viewOf({ a: { status: 'done', output: 'oa', reusedFrom: { runId: 'r0', at: 7 } }, b: { status: 'done', output: 'ob' } })
  const r = recordOf(g, view, meta({ mode: 'from-here', fromNode: 'b' }))
  expect(r.mode).toBe('from-here')
  expect(r.fromNode).toBe('b')
  expect(r.nodes['a']!.reusedFrom).toEqual({ runId: 'r0', at: 7 })
  expect(r.nodes['b']!.reusedFrom).toBeUndefined()
})

test('summaryOf clips the first non-empty task line, sums only run costs and names the start agent', () => {
  const g = chain(['a', 'b'])
  const view = viewOf({
    a: { status: 'done', output: 'oa', costUsd: 0.5, reusedFrom: { runId: 'r0', at: 7 } },
    b: { status: 'done', output: 'ob', costUsd: 0.25 },
  }, { task: '\n  \n  A very long first line that goes well past the forty character limit  \nsecond' })
  const r = recordOf(g, view, meta({ mode: 'from-here', fromNode: 'b' }))
  const s = summaryOf(r, g)
  expect(s.taskLine.length).toBeLessThanOrEqual(40)
  expect(s.taskLine.startsWith('A very long first line')).toBe(true)
  expect(s.costUsd).toBe(0.25)
  expect(s.fromName).toBe('B')
  expect([s.id, s.at, s.ending, s.mode]).toEqual(['r1', 99, 'finished', 'from-here'])
  expect(summaryOf(recordOf(g, viewOf({}, { task: 'short' }), meta()), g)).toMatchObject({ taskLine: 'short', costUsd: 0 })
  expect(summaryOf(recordOf(g, viewOf({}), meta()), g).fromName).toBeUndefined()
})

test('recordOf and summaryOf keep that a cost is estimated, counting only the entries that ran', () => {
  const g = chain(['a', 'b'])
  const view = viewOf({
    a: { status: 'done', output: 'oa', costUsd: 0.5, costEstimated: true, reusedFrom: { runId: 'r0', at: 7 } },
    b: { status: 'done', output: 'ob', costUsd: 0.25 },
  })
  const r = recordOf(g, view, meta())
  expect(r.nodes['a']).toMatchObject({ costUsd: 0.5, costEstimated: true })
  expect(r.nodes['b']!.costEstimated).toBeUndefined()
  // The estimated entry was reused, not run: the run's own cost is exact.
  expect(summaryOf(r, g).costEstimated).toBeUndefined()
  const ran = recordOf(g, viewOf({ a: { status: 'done', costUsd: 0.5, costEstimated: true }, b: { status: 'done', costUsd: 0.25 } }), meta())
  expect(summaryOf(ran, g)).toMatchObject({ costUsd: 0.75, costEstimated: true })
})

const summary = (id: string): RunSummary => ({ id, at: 1, ending: 'finished', mode: 'full', taskLine: id, costUsd: 0 })

test('withRecord prepends the summary and records every node entry in latest', () => {
  const g = chain(['a', 'b'])
  const view = viewOf({ a: { status: 'done', output: 'oa' }, b: { status: 'failed', error: 'x' } }, { task: 'NEW' })
  const r = recordOf(g, view, meta())
  const before: RunIndex = {
    runs: [summary('old')],
    latest: { a: { runId: 'old', at: 1, fingerprint: 'zz', task: 'T', status: 'done' }, b: { runId: 'old', at: 1, fingerprint: 'zz', task: 'T', status: 'done' }, gone: { runId: 'old', at: 1, fingerprint: 'zz', task: 'T', status: 'done' } },
  }
  const { index, dropped } = withRecord(before, r)
  expect(dropped).toEqual([])
  expect(index.runs.map(s => s.id)).toEqual(['r1', 'old'])
  expect(index.latest['a']).toEqual({ runId: 'r1', at: 99, producedAt: 99, fingerprint: 'fa', task: 'NEW', status: 'done' })
  expect(index.latest['b']).toEqual({ runId: 'r1', at: 99, producedAt: 99, fingerprint: 'fb', task: 'NEW', status: 'failed' })
  expect(index.latest['gone']!.runId).toBe('old')
  // The index passed in is left alone.
  expect(before.runs).toHaveLength(1)
  expect(before.latest['a']!.runId).toBe('old')
})

test('withRecord keeps the newest runs and any run still named in latest', () => {
  expect(RUNS_KEPT).toBe(20)
  const g = graphOf(['a'])
  const runs = Array.from({ length: 22 }, (_, i) => summary(`r${21 - i}`)) // r21 newest ... r0 oldest
  const index: RunIndex = { runs, latest: { z: { runId: 'r0', at: 1, fingerprint: 'f', task: 'T', status: 'done' } } }
  const r = recordOf(g, viewOf({ a: { status: 'done' } }), meta({ id: 'r22' }))
  const out = withRecord(index, r)
  expect(out.index.runs).toHaveLength(21)
  expect(out.index.runs[0]!.id).toBe('r22')
  expect(out.index.runs.map(s => s.id)).toContain('r0')
  expect(out.index.runs.map(s => s.id)).not.toContain('r1')
  expect(out.index.runs.map(s => s.id)).not.toContain('r2')
  expect([...out.dropped].sort()).toEqual(['r1', 'r2'])
})

test('withRecord keeps when each output was made: a reused one keeps the time it was first made', () => {
  const g = chain(['a', 'b'])
  const view = viewOf({ a: { status: 'done', output: 'oa', reusedFrom: { runId: 'r0', at: 7 } }, b: { status: 'done', output: 'ob' } })
  const { index } = withRecord({ runs: [], latest: {} }, recordOf(g, view, meta({ mode: 'from-here', fromNode: 'b' })))
  expect(index.latest['a']).toMatchObject({ runId: 'r1', at: 99, producedAt: 7 })
  expect(index.latest['b']).toMatchObject({ runId: 'r1', at: 99, producedAt: 99 })
})

// A -> B -> C and B -> D, run in full at 10; every record has the task 'T' and today's fingerprints.
const forked = () => connect(connect(connect(graphOf(['a', 'b', 'c', 'd']), 'a', 'b', 'handoff'), 'b', 'c', 'handoff'), 'b', 'd', 'handoff')
const done = (output: string, reusedAt?: number) => ({ status: 'done' as const, output, ...(reusedAt !== undefined ? { reusedFrom: { runId: 'r1', at: reusedAt } } : {}) })
function saved(g: Graph, runs: Array<{ id: string; endedAt: number; nodes: RunView['nodes'] }>): RunIndex {
  const fingerprints = Object.fromEntries(g.nodes.map(n => [n.id, fp(g, n.id)!]))
  return runs.reduce(
    (index, r) => withRecord(index, recordOf(g, viewOf(r.nodes, { task: 'T' }), meta({ id: r.id, endedAt: r.endedAt, fingerprints, files: {} }))).index,
    { runs: [], latest: {} } as RunIndex,
  )
}

test('after a shared predecessor runs again, the agents on its other branches are upstream', () => {
  const g = forked()
  const full = { id: 'r1', endedAt: 10, nodes: { a: done('oa'), b: done('ob'), c: done('oc'), d: done('od') } }
  expect(staleOf(g, saved(g, [full]), 'T', text)).toEqual({})
  // From here on C ran B again (A reused): D was made from B's old output.
  const fromC = { id: 'r2', endedAt: 20, nodes: { a: done('oa', 10), b: done('ob2'), c: done('oc2') } }
  expect(staleOf(g, saved(g, [full, fromC]), 'T', text)).toEqual({ d: 'upstream' })
  // Entries saved before producedAt existed compare by `at`.
  const old = saved(g, [full, fromC])
  for (const id of Object.keys(old.latest)) delete old.latest[id]!.producedAt
  expect(staleOf(g, old, 'T', text)).toEqual({ d: 'upstream' })
})

test('a reused predecessor never marks the agents after it', () => {
  const g = forked()
  const full = { id: 'r1', endedAt: 10, nodes: { a: done('oa'), b: done('ob'), c: done('oc'), d: done('od') } }
  // From here on C, B reused: C is newer than D, but B's output is the one both were made from.
  const fromC = { id: 'r2', endedAt: 20, nodes: { b: done('ob', 10), c: done('oc2') } }
  expect(staleOf(g, saved(g, [full, fromC]), 'T', text)).toEqual({})
  // From here on B (A reused): B, C and D all ran together.
  const fromB = { id: 'r3', endedAt: 30, nodes: { a: done('oa', 10), b: done('ob3'), c: done('oc3'), d: done('od3') } }
  expect(staleOf(g, saved(g, [full, fromC, fromB]), 'T', text)).toEqual({})
})

test('recordOf copies inputEdited and the used prompt', () => {
  const g = chain(['a', 'b'])
  const r = recordOf(g, viewOf({ a: { status: 'done', output: 'oa' }, b: { status: 'done', output: 'ob', inputEdited: true, prompt: 'MINE' } }), meta())
  expect(r.nodes['b']).toMatchObject({ inputEdited: true, prompt: 'MINE' })
  expect('inputEdited' in r.nodes['a']!).toBe(false)
  expect('prompt' in r.nodes['a']!).toBe(false)
})

test('a test run is listed with its test name and leaves latest untouched', () => {
  const g = chain(['a', 'b'])
  const r = recordOf(g, viewOf({ a: { status: 'done', output: 'oa' }, b: { status: 'done', output: 'ob' } }, { task: '\nWrite a haiku\nabout autumn' }), meta({ id: 'rt', mode: 'test', testId: 't1' }))
  expect(r).toMatchObject({ mode: 'test', testId: 't1' })
  const before: RunIndex = { runs: [summary('old')], latest: { a: { runId: 'old', at: 1, fingerprint: 'zz', task: 'T', status: 'done' } } }
  const { index } = withRecord(before, r)
  expect(index.latest).toEqual(before.latest)
  expect(index.runs.map(s => s.id)).toEqual(['rt', 'old'])
  expect(index.runs[0]).toMatchObject({ mode: 'test', testName: 'Write a haiku' })
  expect(summary('x').testName).toBeUndefined()
})

test('test runs and the other runs are kept apart: neither pushes the other out', () => {
  const g = graphOf(['a'])
  const tests = Array.from({ length: RUNS_KEPT }, (_, i) => ({ ...summary(`t${RUNS_KEPT - 1 - i}`), mode: 'test' as const })) // t19 newest ... t0 oldest
  const normal = Array.from({ length: 3 }, (_, i) => summary(`n${2 - i}`))
  const index: RunIndex = { runs: [...tests, ...normal], latest: {} }
  // A run of the person's own: it does not count against the test runs, so all of them stay.
  const own = withRecord(index, recordOf(g, viewOf({ a: { status: 'done' } }), meta({ id: 'r_new' })))
  expect(own.dropped).toEqual([])
  expect(own.index.runs).toHaveLength(RUNS_KEPT + 4)
  // One more test run retires the oldest test run only, and a crowd of tests keeps the person's runs.
  const test = withRecord(index, recordOf(g, viewOf({ a: { status: 'done' } }), meta({ id: 't_new', mode: 'test', testId: 'x' })))
  expect(test.dropped).toEqual(['t0'])
  expect(test.index.runs.filter(s => s.mode !== 'test').map(s => s.id)).toEqual(['n2', 'n1', 'n0'])
  // The person's own runs are capped by themselves.
  const many: RunIndex = { runs: Array.from({ length: RUNS_KEPT }, (_, i) => summary(`n${RUNS_KEPT - 1 - i}`)), latest: {} }
  const capped = withRecord({ runs: [...tests, ...many.runs], latest: {} }, recordOf(g, viewOf({ a: { status: 'done' } }), meta({ id: 'r_new' })))
  expect(capped.dropped).toEqual(['n0'])
})

test('recordOf keeps each agent activity once: a helper entry keeps none, its calls are found again under its callers', () => {
  const g = connect(chain(['a', 'b']), 'a', 'h', 'delegate')
  const item = (id: string, tool: string): ActivityItem => ({ id, tool, summary: `${tool} call`, status: 'ok', startedAt: 12, endedAt: 13, input: '{}', result: 'r' })
  const view = viewOf({
    a: { status: 'done', output: 'oa', activity: [item('c1', 'Bash'), { ...item('c2', 'Agent'), delegate: { nodeId: 'h', name: 'H', items: [item('c3', 'Read')] } }], current: 'ignored' },
    b: { status: 'done', output: 'ob' },
    h: { status: 'done', calledBy: 'a', startedAt: 12, endedAt: 13, activity: [item('c3', 'Read')] },
  })
  const r = recordOf(g, view, meta())
  expect(r.nodes['a']!.activity).toEqual(view.nodes['a']!.activity)
  expect(r.nodes['h']).toMatchObject({ status: 'done', startedAt: 12, endedAt: 13 })
  expect('activity' in r.nodes['h']!).toBe(false)
  expect(helperActivity(r.nodes, 'h')).toEqual([item('c3', 'Read')])
  expect(helperActivity(r.nodes, 'b')).toEqual([])
  expect('activity' in r.nodes['b']!).toBe(false)
  expect('current' in r.nodes['a']!).toBe(false)
  expect(r.nodes['h']!.calledBy).toBe('a')
})

test('withRecord keeps delegate helpers out of latest; the record keeps them with calledBy', () => {
  const g = connect(chain(['a', 'b']), 'a', 'h', 'delegate')
  const view = viewOf({
    a: { status: 'done', output: 'oa' },
    b: { status: 'done', output: 'ob' },
    h: { status: 'done', calledBy: 'a', startedAt: 12, endedAt: 13, activity: [{ id: 'c1', tool: 'Read', summary: '/f', status: 'ok', startedAt: 12 }] },
  })
  const r = recordOf(g, view, meta())
  expect(r.nodes['h']).toMatchObject({ status: 'done', calledBy: 'a' })
  const { index } = withRecord({ runs: [], latest: {} }, r)
  expect(Object.keys(index.latest).sort()).toEqual(['a', 'b'])
})

test('the calls of a helper are gathered from every caller, nested callers too, in order', () => {
  const call = (id: string, over: Partial<ActivityItem> = {}): ActivityItem => ({ id, tool: 'Read', summary: id, status: 'ok', startedAt: 1, ...over })
  const nodes = {
    a: { status: 'done' as NodeStatus, inputs: [], files: [], fingerprint: '', activity: [call('a1'), call('d1', { tool: 'Agent', delegate: { nodeId: 'h', name: 'H', items: [call('n1')] } })] },
    b: { status: 'done' as NodeStatus, inputs: [], files: [], fingerprint: '', activity: [call('d2', { tool: 'Agent', delegate: { nodeId: 'k', name: 'K', items: [call('d3', { tool: 'Agent', delegate: { nodeId: 'h', name: 'H', items: [call('n2')] } })] } })] },
    h: { status: 'done' as NodeStatus, inputs: [], files: [], fingerprint: '', calledBy: 'a' },
  }
  expect(helperActivity(nodes, 'h').map(i => i.id)).toEqual(['n1', 'n2'])
  expect(helperActivity(nodes, 'k').map(i => i.id)).toEqual(['d3'])
})

test('seven agents that each keep 200 failing calls with long errors make a record that fits', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const g = graphOf(ids)
  const tracker = createTracker(() => {}, () => 1)
  const nodes: RunView['nodes'] = {}
  for (const id of ids) {
    tracker.watch(id, id)
    for (let i = 0; i < 200; i++) {
      const call = tracker.callStart(id, 'Bash', { command: `npm test -- --grep "case ${i}" ${'x'.repeat(1500)}` })!
      tracker.callEnd(call, { ok: false, error: `FAIL "case ${i}"\n${'stack line\n'.repeat(400)}` })
    }
    nodes[id] = { status: 'done', output: 'o', activity: tracker.itemsOf(id) }
  }
  const r = recordOf(g, viewOf(nodes), meta())
  expect(JSON.stringify(r).length).toBeLessThan(RECORD_MAX_CHARS)
})

test('slimmed drops every call detail, deep, and then the activity itself when it still does not fit', () => {
  const g = connect(chain(['a', 'b']), 'a', 'h', 'delegate')
  const detail = { input: 'i'.repeat(500), result: 'r'.repeat(500), error: 'e'.repeat(500) }
  const view = viewOf({
    a: { status: 'done', output: 'oa', activity: [{ id: 'c1', tool: 'Bash', summary: 'ls', status: 'failed', startedAt: 1, ...detail, delegate: { nodeId: 'h', name: 'H', items: [{ id: 'c2', tool: 'Read', summary: '/f', status: 'ok', startedAt: 1, ...detail }] } }] },
    b: { status: 'done', output: 'ob' },
  })
  const r = recordOf(g, view, meta())
  const slim = slimmed(r)
  expect(slim.nodes['a']!.activity).toEqual([{ id: 'c1', tool: 'Bash', summary: 'ls', status: 'failed', startedAt: 1, delegate: { nodeId: 'h', name: 'H', items: [{ id: 'c2', tool: 'Read', summary: '/f', status: 'ok', startedAt: 1 }] } }])
  expect(slim.nodes['a']!.output).toBe('oa')
  // The record it came from is left as it was.
  expect(r.nodes['a']!.activity![0]!.input).toBe(detail.input)
  const bare = slimmed(r, JSON.stringify(slim).length - 1)
  expect('activity' in bare.nodes['a']!).toBe(false)
  expect(bare.nodes['a']!.output).toBe('oa')
})

const checkNode = (id: string, command = 'npm test', timeoutMin = 10): AgentNode => ({ ...node(id), instructionsFile: '', check: { command, timeoutMin } })

test('a check fingerprint uses its command and timeout, never instructions', () => {
  const g: Graph = { ...chain(['a']), nodes: [node('a'), checkNode('k')], edges: [{ id: 'e', from: 'a', to: 'k', kind: 'handoff' }] }
  const none = () => undefined
  const base = fp(g, 'k', none)!
  expect(base).toMatch(/^[0-9a-f]{8}$/)
  expect(fp(g, 'k', n => `${text(n)} edited`)).toBe(base)
  expect(fp(updateNode(g, 'k', { check: { command: 'npm run lint', timeoutMin: 10 } }), 'k', none)).not.toBe(base)
  expect(fp(updateNode(g, 'k', { check: { command: 'npm test', timeoutMin: 20 } }), 'k', none)).not.toBe(base)
  expect(fp(updateNode(g, 'k', { name: 'Renamed' }), 'k', none)).toBe(base)
  expect(fp({ ...g, edges: [] }, 'k', none)).not.toBe(base)
})

test('recordOf keeps a node\'s round and rounds', () => {
  const g = chain(['a', 'b'])
  const rounds = [{ round: 1, passed: false, note: 'nope', at: 5 }, { round: 2, passed: true, note: 'passed', at: 9 }]
  const view: RunView = { graphId: 'g', graphName: 'G', isRunning: false, nodes: { a: { status: 'done', round: 2 }, b: { status: 'done', round: 2, rounds } } }
  const r = recordOf(g, view, { id: 'r', mode: 'full', startedAt: 1, endedAt: 2, ending: 'finished', fingerprints: {}, files: {} })
  expect(r.nodes.a).toMatchObject({ round: 2 })
  expect(r.nodes.a).not.toHaveProperty('rounds')
  expect(r.nodes.b).toMatchObject({ round: 2, rounds })
  const plain = recordOf(g, { ...view, nodes: { a: { status: 'done' } } }, { id: 'r', mode: 'full', startedAt: 1, endedAt: 2, ending: 'finished', fingerprints: {}, files: {} })
  expect(plain.nodes.a).not.toHaveProperty('round')
})

test('a fingerprint changes when a retry arrow out makes the agent a reviewer, or stops it', () => {
  const g = chain(['a', 'b'])
  const base = fp(g, 'b')
  const reviewer = connect(g, 'b', 'a', 'retry')
  expect(fp(reviewer, 'b')).not.toBe(base)
  expect(fp(reviewer, 'a')).toBe(fp(g, 'a'))
  expect(fp({ ...reviewer, edges: reviewer.edges.filter(e => e.kind !== 'retry') }, 'b')).toBe(base)
  // The number of retries does not shape what the agent writes.
  expect(fp({ ...reviewer, edges: reviewer.edges.map(e => (e.kind === 'retry' ? { ...e, retries: 7 } : e)) }, 'b')).toBe(fp(reviewer, 'b'))
})

test('planFromHere on a card of a retry loop starts at the loop target, so the whole loop runs', () => {
  // a -> b -> m -> c -> d; c sends work back to b.
  const g = connect(chain(['a', 'b', 'm', 'c', 'd']), 'c', 'b', 'retry')
  for (const from of ['b', 'm', 'c']) {
    const plan = planFromHere(g, from, {})
    expect(new Set(plan.run), from).toEqual(new Set(['b', 'm', 'c', 'd']))
    expect(plan.reuse, from).toEqual(['a'])
  }
  // After the loop is the usual plan: the judge is reused.
  const after = planFromHere(g, 'd', {})
  expect(after.run).toEqual(['d'])
  expect(after.reuse).toEqual(['c'])
  // Before the loop, everything downstream runs, loop included.
  expect(new Set(planFromHere(g, 'a', {}).run)).toEqual(new Set(['a', 'b', 'm', 'c', 'd']))
  // What the target needs is judged as ever.
  expect(new Set(planFromHere(g, 'm', { a: 'changed', b: 'upstream' }).run)).toEqual(new Set(['a', 'b', 'm', 'c', 'd']))
  // The arrow of a disabled judge is gone: the card starts where it is.
  expect(new Set(planFromHere(updateNode(g, 'c', { disabled: true }), 'm', {}).run)).toEqual(new Set(['m', 'd']))
})

test('runStart is the loop target for the other cards of a loop, and the card itself elsewhere', () => {
  const g = connect(chain(['a', 'b', 'm', 'c', 'd']), 'c', 'b', 'retry')
  expect(['a', 'b', 'm', 'c', 'd'].map(id => runStart(g, id))).toEqual(['a', 'b', 'b', 'b', 'd'])
  expect(runStart(chain(['a', 'b']), 'b')).toBe('b')
})

test('planFromHere exact plans from the card itself in a retry loop: the target and the rest of the loop are reused', () => {
  // a -> b -> m -> c -> d; c sends work back to b.
  const g = connect(chain(['a', 'b', 'm', 'c', 'd']), 'c', 'b', 'retry')
  // The target is reused, and so is what it needs: sent back, it runs again on its own input.
  const near = planFromHere(g, 'm', {}, true)
  expect(new Set(near.run)).toEqual(new Set(['m', 'c', 'd']))
  expect(new Set(near.reuse)).toEqual(new Set(['b', 'a']))
  // A longer loop: the cards before the card (and the target) are still reused, so the judge can send work back.
  const long = connect(chain(['a', 'b', 'm1', 'm2', 'c', 'd']), 'c', 'b', 'retry')
  const far = planFromHere(long, 'm2', {}, true)
  expect(new Set(far.run)).toEqual(new Set(['m2', 'c', 'd']))
  expect(new Set(far.reuse)).toEqual(new Set(['b', 'm1', 'a']))
  // A loop card that is out of date is reused all the same: none runs while the card after it is reused with its
  // old output (it can still be sent back).
  const stale = planFromHere(long, 'm2', { b: 'changed', m1: 'upstream', m2: 'upstream', c: 'upstream', d: 'upstream' }, true)
  expect(new Set(stale.run)).toEqual(new Set(['m2', 'c', 'd']))
  expect(new Set(stale.reuse)).toEqual(new Set(['b', 'm1', 'a']))
  const out = graphForRun(long, stale)
  expect(out.edges.some(e => e.kind === 'retry' && e.from === 'c' && e.to === 'b')).toBe(true)
  // Only a loop card with no saved output runs, and so does every card of the loop after it.
  const lost = planFromHere(long, 'm2', { b: 'never', m1: 'upstream' }, true)
  expect(new Set(lost.run)).toEqual(new Set(['m2', 'c', 'd', 'b', 'm1']))
  expect(lost.reuse).toEqual(['a'])
  // On the judge itself, and on the target.
  expect(new Set(planFromHere(g, 'c', {}, true).run)).toEqual(new Set(['c', 'd']))
  expect(new Set(planFromHere(g, 'b', {}, true).run)).toEqual(new Set(['b', 'm', 'c', 'd']))
  // Outside a loop it is the plan of From here.
  expect(planFromHere(g, 'd', {}, true)).toEqual(planFromHere(g, 'd', {}))
  // Plain From here is unchanged: it starts at the target.
  expect(new Set(planFromHere(g, 'm', {}).run)).toEqual(new Set(['b', 'm', 'c', 'd']))
})

test('From here after a loop whose judge is out of date keeps the loop whole: its cards are reused, and the retry arrow stays', () => {
  // a -> m -> k -> w, k sends work back to a; the judge changed, so w is out of date too.
  for (const judge of [checkNode('k'), node('k')]) {
    let g: Graph = { ...graphOf([]), nodes: [node('a'), node('m'), judge, node('w')] }
    g = connect(connect(connect(connect(g, 'a', 'm', 'handoff'), 'm', 'k', 'handoff'), 'k', 'w', 'handoff'), 'k', 'a', 'retry')
    const plan = planFromHere(g, 'w', { k: 'changed', w: 'upstream' })
    expect(new Set(plan.run), judge.id).toEqual(new Set(['w', 'k']))
    expect(new Set(plan.reuse), judge.id).toEqual(new Set(['a', 'm']))
    const out = graphForRun(g, plan)
    expect(out.edges.map(e => `${e.from}>${e.to}:${e.kind}`).sort()).toEqual(['a>m:handoff', 'k>a:retry', 'k>w:handoff', 'm>k:handoff'])
  }
})

test('From here after a longer loop runs its out-of-date middle card and what follows it, and reuses the rest', () => {
  // p -> a -> m1 -> m2 -> k -> w, k sends work back to a; only m1 changed.
  const g = connect(chain(['p', 'a', 'm1', 'm2', 'k', 'w']), 'k', 'a', 'retry')
  const plan = planFromHere(g, 'w', { m1: 'changed', m2: 'upstream', k: 'upstream', w: 'upstream' })
  expect(new Set(plan.run)).toEqual(new Set(['w', 'k', 'm2', 'm1']))
  expect(new Set(plan.reuse)).toEqual(new Set(['a', 'p']))
  expect(graphForRun(g, plan).edges.some(e => e.kind === 'retry')).toBe(true)
  // A loop card that cannot be reused (its saved entry is gone) runs, and the loop after it runs too.
  const lost = planFromHere(g, 'w', { a: 'never', k: 'changed', w: 'upstream' })
  expect(new Set(lost.run)).toEqual(new Set(['w', 'k', 'a', 'm1', 'm2']))
  expect(lost.reuse).toEqual(['p'])
  // An input from outside into the middle of a loop: the target is reused, so the judge can send work back.
  const side = connect(connect(chain(['a', 'm', 'k']), 'x', 'm', 'handoff'), 'k', 'a', 'retry')
  const fromSide = planFromHere({ ...side, nodes: [...side.nodes, node('x')] }, 'x', {}, true)
  expect(new Set(fromSide.run)).toEqual(new Set(['x', 'm', 'k']))
  expect(fromSide.reuse).toEqual(['a'])
})
