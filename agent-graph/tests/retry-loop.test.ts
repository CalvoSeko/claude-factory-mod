import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph, RunView } from '../types'
import { connect } from '../hooks/model'
import { reusedNeverRun, runGraph, verdictOf, type Backend, type Handoff, type NodeOutcome } from '../hooks/runner'

declare const setTimeout: (run: () => void, ms?: number) => unknown

const agent = (id: string): AgentNode => ({
  id, name: id.toUpperCase(), x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
const check = (id: string, command = 'npm test'): AgentNode => ({ ...agent(id), instructionsFile: '', check: { command, timeoutMin: 10 } })

// p → a → c → d with a retry arrow c ↺ a, and x on its own: p, d and x are outside the loop.
function loopGraph(judge: AgentNode, retries?: number): Graph {
  let g: Graph = { id: 'g', name: 'G', description: '', backend: 'local', nodes: [agent('p'), agent('a'), judge, agent('d'), agent('x')], edges: [] }
  g = connect(connect(connect(g, 'p', 'a', 'handoff'), 'a', judge.id, 'handoff'), judge.id, 'd', 'handoff')
  return { ...g, edges: [...g.edges, { id: 'r1', from: judge.id, to: 'a', kind: 'retry', ...(retries !== undefined ? { retries } : {}) }] }
}

// A backend whose starts end when the test says so (each start of a node is its own run).
function controlled(costs: Record<string, number> = {}) {
  const started: Array<{ id: string; prompt: string; inputs: Handoff[]; onCost: (usd: number) => void }> = []
  const pending = new Map<string, (o: NodeOutcome) => void>()
  const stopped: string[] = []
  const prepared: Graph[] = []
  const backend: Backend = {
    prepare: async g => {
      prepared.push(g)
      return []
    },
    start: async (n, prompt, inputs, onCost) => {
      started.push({ id: n.id, prompt, inputs, onCost })
      let finish!: (o: NodeOutcome) => void
      const done = new Promise<NodeOutcome>(resolve => (finish = resolve))
      pending.set(n.id, finish)
      const usd = costs[n.id]
      if (usd !== undefined) {
        onCost(usd / 2)
        onCost(usd)
      }
      return { done, stop: async () => { stopped.push(n.id); finish({ ok: false, reason: 'Stopped.' }) } }
    },
  }
  // Ends the node's running start (waiting for it to start first).
  const end = async (id: string, outcome?: NodeOutcome | string) => {
    await until(() => pending.has(id))
    const finish = pending.get(id)!
    pending.delete(id)
    finish(outcome === undefined ? { ok: true, text: `out-${id}`, files: [] } : typeof outcome === 'string' ? { ok: true, text: outcome, files: [] } : outcome)
    await tick()
  }
  return { backend, started, end, stopped, prepared, ids: () => started.map(s => s.id) }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))
async function until(done: () => boolean) {
  for (let i = 0; i < 500 && !done(); i++) await tick()
  expect(done()).toBe(true)
}
const exited = (code: number, detail?: string): NodeOutcome => ({ ok: false, reason: `\`npm test\` exited ${code}.`, ...(detail !== undefined ? { detail } : {}) })

test('a check failing twice then passing re-runs its loop in order with the feedback, and rounds are kept', async () => {
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(loopGraph(check('c')), 'T', c.backend, { onUpdate: v => void views.push(v), now: () => 42 })
  await c.end('p')
  await c.end('x')
  await c.end('a', 'a1')
  await c.end('c', exited(1, 'FAIL one\nexpected 2\n\n'))
  // The loop waits again; what follows the check is not skipped.
  expect(views.at(-1)?.nodes['d']?.status).toBe('waiting')
  expect(views.at(-1)?.nodes['c']).toEqual({ status: 'waiting', round: 2, rounds: [{ round: 1, passed: false, note: '`npm test` exited 1.', at: 42 }] })
  await c.end('a', 'a2')
  await c.end('c', exited(2))
  await c.end('a', 'a3')
  await c.end('c', { ok: true, text: 'checked', files: [] })
  await c.end('d')
  await running

  expect(c.ids()).toEqual(['p', 'x', 'a', 'c', 'a', 'c', 'a', 'c', 'd'])
  const prompts = c.started.filter(s => s.id === 'a').map(s => s.prompt)
  expect(prompts[0]).toBe('T\n\n## Handoff from P\n\nout-p')
  expect(prompts[1]).toBe(
    'T\n\n## Handoff from P\n\nout-p\n\n## C failed (retry 1 of 3)\n\n`npm test` exited 1.\n\n```\nFAIL one\nexpected 2\n```\n\n## Your answer last round\n\na1\n\nFix what failed, then answer as before.',
  )
  // No output: no block.
  expect(prompts[2]).toBe(
    'T\n\n## Handoff from P\n\nout-p\n\n## C failed (retry 2 of 3)\n\n`npm test` exited 2.\n\n## Your answer last round\n\na2\n\nFix what failed, then answer as before.',
  )
  // The check gets the latest answer only.
  expect(c.started.filter(s => s.id === 'c').map(s => s.inputs.map(i => i.text))).toEqual([['a1'], ['a2'], ['a3']])
  expect(c.started.find(s => s.id === 'd')?.inputs.map(i => i.text)).toEqual(['checked'])

  const last = views.at(-1)!
  expect(last.nodes['c']).toMatchObject({ status: 'done', output: 'checked', round: 3 })
  expect(last.nodes['c']?.rounds).toEqual([
    { round: 1, passed: false, note: '`npm test` exited 1.', at: 42 },
    { round: 2, passed: false, note: '`npm test` exited 2.', at: 42 },
    { round: 3, passed: true, note: 'passed', at: 42 },
  ])
  expect(last.nodes['a']).toMatchObject({ status: 'done', output: 'a3', round: 3 })
  expect(last.nodes['a']?.rounds).toBeUndefined()
  for (const id of ['p', 'd', 'x']) expect(last.nodes[id]).toMatchObject({ status: 'done', output: `out-${id}` })
  for (const id of ['p', 'd', 'x']) expect(last.nodes[id]?.round).toBeUndefined()
})

test('a reviewer that fails sends the work back with its whole answer, then passes and hands its answer on', async () => {
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(loopGraph(agent('r')), 'T', c.backend, { onUpdate: v => void views.push(v), now: async () => 7 })
  await c.end('p')
  await c.end('x')
  await c.end('a', 'a1')
  await c.end('r', 'Needs tests for the parser.\nMore detail.\nVERDICT: fail - add tests')
  await c.end('a', 'a2')
  await c.end('r', 'Looks right.\nVERDICT: pass')
  await c.end('d')
  await running
  expect(c.ids()).toEqual(['p', 'x', 'a', 'r', 'a', 'r', 'd'])
  expect(c.started.filter(s => s.id === 'a')[1]?.prompt).toBe(
    'T\n\n## Handoff from P\n\nout-p\n\n## R failed (retry 1 of 3)\n\nNeeds tests for the parser.\nMore detail.\nVERDICT: fail - add tests\n\n## Your answer last round\n\na1\n\nFix what failed, then answer as before.',
  )
  expect(c.started.find(s => s.id === 'd')?.inputs.map(i => i.text)).toEqual(['Looks right.\nVERDICT: pass'])
  const r = views.at(-1)!.nodes['r']!
  expect(r).toMatchObject({ status: 'done', output: 'Looks right.\nVERDICT: pass', round: 2 })
  expect(r.rounds).toEqual([
    { round: 1, passed: false, note: 'Needs tests for the parser.', at: 7 },
    { round: 2, passed: true, note: 'passed', at: 7 },
  ])
})

test('a reviewer without a verdict fails; out of retries it fails with the text and what follows is skipped', async () => {
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(loopGraph(agent('r'), 1), 'T', c.backend, { onUpdate: v => void views.push(v), now: () => 1 })
  await c.end('p')
  await c.end('x')
  await c.end('a')
  await c.end('r', 'It is fine I think.')
  await c.end('a')
  await c.end('r', 'Still no verdict.')
  const result = await running
  expect(c.ids()).toEqual(['p', 'x', 'a', 'r', 'a', 'r'])
  const last = views.at(-1)!
  expect(last.nodes['r']).toMatchObject({ status: 'failed', error: 'Still failing after 1 retries: No VERDICT line.', round: 2 })
  expect(last.nodes['r']?.rounds).toEqual([
    { round: 1, passed: false, note: 'No VERDICT line.', at: 1 },
    { round: 2, passed: false, note: 'No VERDICT line.', at: 1 },
  ])
  expect(last.nodes['d']?.status).toBe('skipped')
  expect(last.nodes['x']?.status).toBe('done')
  expect('failures' in result ? result.failures : {}).toEqual({ r: 'Still failing after 1 retries: No VERDICT line.' })
})

test('a check out of retries fails with the exact text, and only what follows it is skipped', async () => {
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(loopGraph(check('c'), 2), 'T', c.backend, { onUpdate: v => void views.push(v) })
  await c.end('p')
  await c.end('x')
  for (let i = 0; i < 3; i++) {
    await c.end('a')
    await c.end('c', exited(1, 'boom'))
  }
  const result = await running
  expect(c.ids()).toEqual(['p', 'x', 'a', 'c', 'a', 'c', 'a', 'c'])
  const last = views.at(-1)!
  expect(last.nodes['c']).toMatchObject({ status: 'failed', error: 'Still failing after 2 retries: `npm test` exited 1.', round: 3 })
  expect(last.nodes['c']?.rounds?.map(r => [r.round, r.passed])).toEqual([[1, false], [2, false], [3, false]])
  expect(last.nodes['d']?.status).toBe('skipped')
  expect(last.nodes['a']?.status).toBe('done')
  expect('result' in result ? result.result : '').toContain('- C: Still failing after 2 retries: `npm test` exited 1.')
})

test('a judge that passes at once records its round and nothing is sent back', async () => {
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(loopGraph(agent('r')), 'T', c.backend, { onUpdate: v => void views.push(v), now: () => 5 })
  for (const id of ['p', 'x', 'a']) await c.end(id)
  await c.end('r', 'VERDICT: PASS')
  await c.end('d')
  await running
  expect(c.ids()).toEqual(['p', 'x', 'a', 'r', 'd'])
  const r = views.at(-1)!.nodes['r']!
  expect(r.rounds).toEqual([{ round: 1, passed: true, note: 'passed', at: 5 }])
  expect(r.round).toBeUndefined()
})

test('an agent judge that fails outright is sent back too, with its error', async () => {
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(loopGraph(agent('r')), 'T', c.backend, { onUpdate: v => void views.push(v), now: () => 5 })
  for (const id of ['p', 'x', 'a']) await c.end(id)
  await c.end('r', { ok: false, reason: 'Budget spent.\nmore' })
  await c.end('a', 'a2')
  await c.end('r', 'ok\nVERDICT: pass')
  await c.end('d')
  await running
  expect(c.started.filter(s => s.id === 'a')[1]?.prompt).toContain('## R failed (retry 1 of 3)\n\nBudget spent.\nmore\n\n## Your answer last round\n\nout-a\n\n')
  expect(views.at(-1)!.nodes['r']?.rounds?.[0]).toEqual({ round: 1, passed: false, note: 'Budget spent.', at: 5 })
})

test('a loop card costs its rounds summed', async () => {
  const c = controlled({ a: 0.5, r: 0.25, p: 1 })
  const views: RunView[] = []
  const running = runGraph(loopGraph(agent('r')), 'T', c.backend, { onUpdate: v => void views.push(v) })
  for (const id of ['p', 'x', 'a']) await c.end(id)
  await c.end('r', 'VERDICT: fail')
  // Sent back: the cost so far is kept.
  expect(views.find(v => v.nodes['a']?.round === 2)?.nodes['a']).toEqual({ status: 'waiting', round: 2, costUsd: 0.5 })
  await until(() => c.ids().length === 5)
  // The backend's reports for this round add to it.
  expect(views.at(-1)?.nodes['a']?.costUsd).toBe(1)
  await c.end('a')
  await c.end('r', 'VERDICT: fail')
  await c.end('a')
  await c.end('r', 'VERDICT: pass')
  await c.end('d')
  await running
  const last = views.at(-1)!
  expect(last.nodes['a']?.costUsd).toBe(1.5)
  expect(last.nodes['r']?.costUsd).toBe(0.75)
  expect(last.nodes['p']?.costUsd).toBe(1)
})

test('a cost report of a round that comes after its card was sent back still counts, once', async () => {
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(loopGraph(agent('r')), 'T', c.backend, { onUpdate: v => void views.push(v) })
  for (const id of ['p', 'x', 'a']) await c.end(id)
  await until(() => c.ids().includes('r'))
  const first = c.started.find(s => s.id === 'r')!
  first.onCost(0.25)
  await c.end('r', 'VERDICT: fail')
  // The round's last reports come in after the loop went back.
  first.onCost(0.5)
  first.onCost(0.75)
  expect(views.at(-1)?.nodes['r']).toMatchObject({ status: 'waiting', round: 2, costUsd: 0.75 })
  await c.end('a')
  await until(() => c.ids().filter(id => id === 'r').length === 2)
  const second = c.started.filter(s => s.id === 'r')[1]!
  second.onCost(0.25)
  expect(views.at(-1)?.nodes['r']?.costUsd).toBe(1)
  // A late report of the first round after the second started adds only what is new.
  first.onCost(1)
  expect(views.at(-1)?.nodes['r']?.costUsd).toBe(1.25)
  second.onCost(0.5)
  await c.end('r', 'VERDICT: pass')
  await c.end('d')
  await running
  expect(views.at(-1)?.nodes['r']?.costUsd).toBe(1.5)
})

test('a loop with a card in the middle re-runs it without feedback, and a side branch running across the reset is left alone', async () => {
  // p → a → b → c → d, x → d, retry c ↺ a.
  let g: Graph = { id: 'g', name: 'G', description: '', backend: 'local', nodes: [agent('p'), agent('a'), agent('b'), check('c'), agent('d'), agent('x')], edges: [] }
  for (const [from, to] of [['p', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'd'], ['x', 'd']] as const) g = connect(g, from, to, 'handoff')
  g = { ...g, edges: [...g.edges, { id: 'r1', from: 'c', to: 'a', kind: 'retry', retries: 3 }] }
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), now: () => 3 })
  await c.end('p')
  await c.end('a', 'a1')
  const f1 = { id: 'f1', name: 'one.txt', fromNode: 'b' }
  await c.end('b', { ok: true, text: 'b1', files: [f1] })
  await c.end('c', exited(1, 'bad'))
  // The reset reaches the whole loop and only the loop.
  const reset = views.find(v => v.nodes['b']?.round === 2)!
  expect(reset.nodes['b']).toEqual({ status: 'waiting', round: 2 })
  expect(reset.nodes['a']).toEqual({ status: 'waiting', round: 2 })
  expect(reset.nodes['x']?.status).toBe('running')
  expect(reset.nodes['p']).toMatchObject({ status: 'done', output: 'out-p' })
  expect(reset.nodes['d']?.status).toBe('waiting')
  await c.end('a', 'a2')
  const f2 = { id: 'f2', name: 'two.txt', fromNode: 'b' }
  await c.end('b', { ok: true, text: 'b2', files: [f2] })
  expect(views.at(-1)?.nodes['x']?.status).toBe('running')
  await c.end('c', { ok: true, text: 'checked', files: [f2] })
  // d still waits for the side branch.
  expect(c.ids().includes('d')).toBe(false)
  await c.end('x')
  await c.end('d')
  await running

  expect(c.ids()).toEqual(['p', 'x', 'a', 'b', 'c', 'a', 'b', 'c', 'd'])
  const bs = c.started.filter(s => s.id === 'b')
  // The middle card gets its input built again, with no feedback.
  expect(bs[1]?.prompt).toBe('T\n\n## Handoff from A\n\na2')
  expect(c.started.filter(s => s.id === 'a')[1]?.prompt).toContain('## C failed (retry 1 of 3)')
  // The check of round 2 gets round 2's answer and files only.
  expect(c.started.filter(s => s.id === 'c')[1]?.inputs).toEqual([{ from: 'b', text: 'b2', files: [f2] }])
  const last = views.at(-1)!
  expect(last.nodes['b']).toMatchObject({ status: 'done', output: 'b2', round: 2 })
  expect(last.nodes['x']).toMatchObject({ status: 'done', output: 'out-x' })
  expect(last.nodes['x']?.round).toBeUndefined()
  expect(c.started.find(s => s.id === 'd')?.inputs.map(i => i.text)).toEqual(['checked', 'out-x'])
})

test('a stop during round 2 ends the loop like any stop', async () => {
  const c = controlled()
  const controller = new AbortController()
  const views: RunView[] = []
  const running = runGraph(loopGraph(check('c')), 'T', c.backend, { onUpdate: v => void views.push(v), signal: controller.signal })
  for (const id of ['p', 'x', 'a']) await c.end(id)
  await c.end('c', exited(1))
  await until(() => c.ids().length === 5)
  controller.abort()
  await running
  expect(c.ids()).toEqual(['p', 'x', 'a', 'c', 'a'])
  expect(c.stopped).toEqual(['a'])
  const last = views.at(-1)!
  expect(last.nodes['a']).toMatchObject({ status: 'cancelled', round: 2 })
  expect(last.nodes['c']).toMatchObject({ status: 'skipped', round: 2 })
  expect(last.nodes['c']?.rounds).toHaveLength(1)
  expect(last.nodes['d']?.status).toBe('skipped')
})

test('a check that fails after the stop is not sent back', async () => {
  const c = controlled()
  const controller = new AbortController()
  const views: RunView[] = []
  const backend: Backend = {
    ...c.backend,
    start: async (n, p, i, onCost) => {
      const run = await c.backend.start(n, p, i, onCost)
      return n.id === 'c' ? { ...run, stop: async () => {} } : run
    },
  }
  const running = runGraph(loopGraph(check('c')), 'T', backend, { onUpdate: v => void views.push(v), signal: controller.signal })
  for (const id of ['p', 'x', 'a']) await c.end(id)
  await until(() => c.ids().includes('c'))
  controller.abort()
  await c.end('c', exited(1))
  await running
  expect(c.ids()).toEqual(['p', 'x', 'a', 'c'])
  expect(views.at(-1)?.nodes['c']?.status).toBe('cancelled')
  expect(views.at(-1)?.nodes['c']?.rounds).toBeUndefined()
})

test('a paused card is asked again in round 2 with its rebuilt input, and an input written for round 1 is not reused', async () => {
  const c = controlled()
  const calls: Array<{ id: string; prompt: string }> = []
  const open = new Map<string, (text: string) => void>()
  const gate = (id: string, prompt: string) => {
    calls.push({ id, prompt })
    return new Promise<string>(resolve => open.set(id, resolve))
  }
  const views: RunView[] = []
  const running = runGraph(loopGraph(check('c')), 'T', c.backend, { onUpdate: v => void views.push(v), gate, pauses: new Set(['a', 'c']) }, {}, { a: 'WRITTEN' })
  await c.end('p')
  await c.end('x')
  await until(() => calls.length === 1)
  expect(calls[0]).toEqual({ id: 'a', prompt: 'WRITTEN' })
  open.get('a')!('WRITTEN')
  await c.end('a', 'a1')
  await until(() => calls.length === 2)
  open.get('c')!(calls[1]!.prompt)
  await c.end('c', exited(1))
  await until(() => calls.length === 3)
  const rebuilt = 'T\n\n## Handoff from P\n\nout-p\n\n## C failed (retry 1 of 3)\n\n`npm test` exited 1.\n\n## Your answer last round\n\na1\n\nFix what failed, then answer as before.'
  expect(calls[2]).toEqual({ id: 'a', prompt: rebuilt })
  expect(views.at(-1)?.nodes['a']).toMatchObject({ status: 'paused', round: 2 })
  expect(views.at(-1)?.nodes['a']?.inputEdited).toBeUndefined()
  open.get('a')!(rebuilt)
  await c.end('a', 'a2')
  await until(() => calls.length === 4)
  expect(calls[3]?.id).toBe('c')
  open.get('c')!(calls[3]!.prompt)
  await c.end('c', { ok: true, text: 'ok', files: [] })
  await c.end('d')
  await running
  expect(c.started.filter(s => s.id === 'a').map(s => s.prompt)).toEqual(['WRITTEN', rebuilt])
  expect(views.at(-1)?.nodes['a']).toMatchObject({ status: 'done', round: 2 })
  expect(views.at(-1)?.nodes['a']?.inputEdited).toBeUndefined()
})

test('a reused card in a loop is set up and run again when its judge fails', async () => {
  const c = controlled()
  const views: RunView[] = []
  const seed = { p: { output: 'saved-p', files: [], runId: 'r0', at: 1 }, a: { output: 'saved-a', files: [], runId: 'r0', at: 1, costUsd: 3 } }
  const running = runGraph(loopGraph(agent('r')), 'T', c.backend, { onUpdate: v => void views.push(v) }, seed)
  await c.end('x')
  await c.end('r', 'VERDICT: fail')
  await c.end('a', 'a2')
  await c.end('r', 'VERDICT: pass')
  await c.end('d')
  await running
  // The loop's target is prepared (with the retry arrow); the reused card outside the loop is not.
  expect(c.prepared[0]?.nodes.map(n => n.id).sort()).toEqual(['a', 'd', 'r', 'x'])
  expect(c.prepared[0]?.edges.some(e => e.kind === 'retry')).toBe(true)
  expect(c.ids()).toEqual(['r', 'x', 'a', 'r', 'd'])
  expect(c.started.filter(s => s.id === 'a')[0]?.prompt).toContain('## Your answer last round\n\nsaved-a\n\n')
  const a = views.at(-1)!.nodes['a']!
  expect(a).toMatchObject({ status: 'done', output: 'a2', round: 2 })
  expect(a.reusedFrom).toBeUndefined()
  // What it cost in the run it came from is not this run's.
  expect(a.costUsd).toBeUndefined()
})

test('a reused card that can be sent back is validated: work leaving its loop early refuses the run', async () => {
  // p → a → b → r, retry r ↺ a, b → e → d, r → d: b hands work out of the loop before its judge.
  let g: Graph = { id: 'g', name: 'G', description: '', backend: 'local', nodes: ['p', 'a', 'b', 'r', 'e', 'd'].map(agent), edges: [] }
  for (const [from, to] of [['p', 'a'], ['a', 'b'], ['b', 'r'], ['b', 'e'], ['e', 'd'], ['r', 'd']] as const) g = connect(g, from, to, 'handoff')
  g = { ...g, edges: [...g.edges, { id: 'r1', from: 'r', to: 'a', kind: 'retry', retries: 3 }] }
  const saved = (id: string) => ({ output: `saved-${id}`, files: [], runId: 'r0', at: 1 })
  // From here on d with a stale judge: r runs, the rest of its loop is reused.
  const seed = { p: saved('p'), a: saved('a'), b: saved('b'), e: saved('e') }
  expect([...reusedNeverRun(g, new Set(Object.keys(seed)))].sort()).toEqual(['e', 'p'])
  const c = controlled()
  const result = await runGraph(g, 'T', c.backend, { onUpdate: () => {} }, seed)
  expect('problems' in result ? result.problems.map(p => p.message) : []).toContain('Work leaves this retry loop before its check: B hands off to E.')
  expect(c.started).toEqual([])
  // With the judge reused too nothing can be sent back: the loop's cards are never run, so not judged.
  expect([...reusedNeverRun(g, new Set([...Object.keys(seed), 'r']))].sort()).toEqual(['a', 'b', 'e', 'p', 'r'])
  const whole = runGraph(g, 'T', c.backend, { onUpdate: () => {} }, { ...seed, r: saved('r') })
  await c.end('d')
  expect('problems' in (await whole)).toBe(false)
})

test('the verdict is the last VERDICT line; the note is the first other line', () => {
  expect(verdictOf('Fine.\nVERDICT: pass')).toEqual({ passed: true, note: 'passed' })
  expect(verdictOf('  verdict:   Pass\n')).toEqual({ passed: true, note: 'passed' })
  expect(verdictOf('VERDICT: pass\n\nOn reflection, no.\nVERDICT: fail')).toEqual({ passed: false, note: 'On reflection, no.' })
  expect(verdictOf('VERDICT: fail\nVERDICT: pass')).toEqual({ passed: true, note: 'passed' })
  expect(verdictOf('VERDICT: fail')).toEqual({ passed: false, note: 'Review failed.' })
  expect(verdictOf('\n\n  The tests are missing.  \nVERDICT: fail')).toEqual({ passed: false, note: 'The tests are missing.' })
  expect(verdictOf('VERDICT: passing grade')).toEqual({ passed: false, note: 'No VERDICT line.' })
  expect(verdictOf('All good, VERDICT: pass')).toEqual({ passed: false, note: 'No VERDICT line.' })
  expect(verdictOf('')).toEqual({ passed: false, note: 'No VERDICT line.' })
  const long = 'x'.repeat(200)
  expect(verdictOf(`${long}\nVERDICT: fail`).note).toBe(`${'x'.repeat(119)}…`)
})

// The run cap as actions.ts watches it: once the costs in a published view reach it, the run is stopped with its text.
const CAP_TEXT = 'Stopped: the run reached its $1.00 cap.'
function capped(controller: AbortController, views: RunView[]) {
  return (v: RunView) => {
    views.push(v)
    const spent = Object.values(v.nodes).reduce((sum, n) => sum + (n.reusedFrom === undefined ? (n.costUsd ?? 0) : 0), 0)
    if (spent >= 1 && !controller.signal.aborted) controller.abort(CAP_TEXT)
  }
}

test("a reviewer's own last request that reaches the run cap ends it cancelled, never done with its fail verdict", async () => {
  for (const answer of ['Not yet.\nVERDICT: fail - no tests', 'It looks fine to me.']) {
    const c = controlled()
    const controller = new AbortController()
    const views: RunView[] = []
    // As on Local, the stop does not change an answer that is already on its way.
    const backend: Backend = {
      ...c.backend,
      start: async (n, p, i, onCost) => {
        const run = await c.backend.start(n, p, i, onCost)
        return n.id === 'r' ? { ...run, stop: async () => {} } : run
      },
    }
    const running = runGraph(loopGraph(agent('r')), 'T', backend, { onUpdate: capped(controller, views), signal: controller.signal, now: () => 5 })
    for (const id of ['p', 'x', 'a']) await c.end(id)
    await until(() => c.ids().includes('r'))
    await tick()
    // The reviewer's last request is metered before its turn ends, and crosses the cap.
    c.started.find(s => s.id === 'r')!.onCost(1.2)
    expect(controller.signal.aborted).toBe(true)
    await c.end('r', answer)
    const result = await running
    expect(c.ids(), answer).toEqual(['p', 'x', 'a', 'r'])
    const r = views.at(-1)!.nodes['r']!
    expect(r, answer).toMatchObject({ status: 'cancelled', error: CAP_TEXT, output: answer })
    expect(r.rounds?.map(e => e.passed), answer).toEqual([false])
    expect(views.at(-1)!.nodes['d']?.status, answer).toBe('skipped')
    expect('outputs' in result ? Object.keys(result.outputs).sort() : [], answer).toEqual(['a', 'p', 'x'])
  }
})

test('a reviewer that passes as the run is stopped stays done; one that fails after a plain Stop ends cancelled', async () => {
  for (const [answer, status, error] of [['VERDICT: pass', 'done', undefined], ['VERDICT: fail', 'cancelled', 'Stopped.']] as const) {
    const c = controlled()
    const controller = new AbortController()
    const views: RunView[] = []
    const backend: Backend = {
      ...c.backend,
      start: async (n, p, i, onCost) => {
        const run = await c.backend.start(n, p, i, onCost)
        return n.id === 'r' ? { ...run, stop: async () => {} } : run
      },
    }
    const running = runGraph(loopGraph(agent('r')), 'T', backend, { onUpdate: v => void views.push(v), signal: controller.signal })
    for (const id of ['p', 'x', 'a']) await c.end(id)
    await until(() => c.ids().includes('r'))
    controller.abort()
    await c.end('r', answer)
    await running
    const r = views.at(-1)!.nodes['r']!
    expect(r.status, answer).toBe(status)
    expect(r.error, answer).toBe(error)
    expect(c.ids(), answer).toEqual(['p', 'x', 'a', 'r'])
  }
})
