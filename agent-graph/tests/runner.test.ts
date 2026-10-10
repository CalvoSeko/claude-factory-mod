import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph, RunView } from '../types'
import { connect } from '../hooks/model'
import { createTracker } from '../hooks/activity'
import { promptFor, runGraph, type Backend, type Handoff, type NodeOutcome, type NodeRun } from '../hooks/runner'

declare const setTimeout: (run: () => void, ms?: number) => unknown

const node = (id: string): AgentNode => ({
  id, name: id.toUpperCase(), x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
const graphOf = (ids: string[]): Graph => ({ id: 'g', name: 'G', description: '', backend: 'local', nodes: ids.map(node), edges: [] })

// A backend whose nodes finish when the test says so.
function controlled(fail: string[] = []) {
  const started: Array<{ id: string; prompt: string; inputs: Handoff[] }> = []
  const finishers = new Map<string, (o: NodeOutcome) => void>()
  const stopped: string[] = []
  const backend: Backend = {
    prepare: async () => [],
    start: async (n, prompt, inputs) => {
      started.push({ id: n.id, prompt, inputs })
      let finish!: (o: NodeOutcome) => void
      const done = new Promise<NodeOutcome>(resolve => (finish = resolve))
      finishers.set(n.id, finish)
      return { done, stop: async () => { stopped.push(n.id); finish({ ok: false, reason: 'Stopped.' }) } }
    },
  }
  const finish = async (id: string) => {
    finishers.get(id)!(fail.includes(id) ? { ok: false, reason: `${id} broke` } : { ok: true, text: `out-${id}`, files: [] })
    await tick()
  }
  return { backend, started, finish, finishers, stopped }
}
// Real timers, so no test depends on how many microtasks a step takes.
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))
async function until(done: () => boolean) {
  for (let i = 0; i < 500 && !done(); i++) await tick()
  expect(done()).toBe(true)
}

test('handoffs run in order and pass outputs along, fan-in waits for all', async () => {
  let g = graphOf(['a', 'b', 'c'])
  g = connect(connect(g, 'a', 'c', 'handoff'), 'b', 'c', 'handoff')
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(g, 'TASK', c.backend, { onUpdate: v => void views.push(v) })
  await tick()
  expect(c.started.map(s => s.id)).toEqual(['a', 'b'])
  await c.finish('a')
  expect(c.started.map(s => s.id)).toEqual(['a', 'b'])
  await c.finish('b')
  expect(c.started.map(s => s.id)).toEqual(['a', 'b', 'c'])
  expect(c.started[2]!.prompt).toBe('TASK\n\n## Handoff from A\n\nout-a\n\n## Handoff from B\n\nout-b')
  await c.finish('c')
  const result = await running
  expect('result' in result ? result.result : '').toBe('## C\n\nout-c')
  expect(views.at(-1)?.isRunning).toBe(false)
})

test('at most four nodes run at once', async () => {
  const c = controlled()
  const running = runGraph(graphOf(['a', 'b', 'c', 'd', 'e']), 'T', c.backend, { onUpdate: () => {} })
  await tick()
  expect(c.started).toHaveLength(4)
  await c.finish('a')
  expect(c.started).toHaveLength(5)
  for (const id of ['b', 'c', 'd', 'e']) await c.finish(id)
  await running
})

test('a failure skips everything downstream but not other branches', async () => {
  let g = graphOf(['a', 'b', 'x'])
  g = connect(g, 'a', 'b', 'handoff')
  const c = controlled(['a'])
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v) })
  await tick()
  await c.finish('a')
  await c.finish('x')
  const result = await running
  const last = views.at(-1)!
  expect(last.nodes['a']?.status).toBe('failed')
  expect(last.nodes['b']?.status).toBe('skipped')
  expect(last.nodes['x']?.status).toBe('done')
  expect('result' in result ? result.result : '').toContain('- A: a broke')
})

test('stop aborts running nodes and skips waiting ones', async () => {
  const g = connect(graphOf(['a', 'b']), 'a', 'b', 'handoff')
  const c = controlled()
  const controller = new AbortController()
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), signal: controller.signal })
  await tick()
  controller.abort()
  await running
  expect(c.stopped).toEqual(['a'])
  expect(views.at(-1)?.nodes['b']?.status).toBe('skipped')
})

test('an invalid graph or a failed prepare does not start', async () => {
  const c = controlled()
  const invalid = await runGraph(graphOf([]), 'T', c.backend, { onUpdate: () => {} })
  expect('problems' in invalid).toBe(true)
  const refusing: Backend = { ...c.backend, prepare: async () => [{ target: { kind: 'graph' }, message: 'no key' }] }
  const refused = await runGraph(graphOf(['a']), 'T', refusing, { onUpdate: () => {} })
  expect('problems' in refused ? refused.problems[0]?.message : '').toBe('no key')
  expect(c.started).toEqual([])
})

test('a stop the backend never confirms ends the node as not confirmed once the wait passes', async () => {
  const backend: Backend = {
    prepare: async () => [],
    start: async () => ({ done: new Promise<NodeOutcome>(() => {}), stop: async () => { throw new Error('TaskStop failed') } }),
  }
  const controller = new AbortController()
  const views: RunView[] = []
  const waits: number[] = []
  let release!: () => void
  let finished = false
  const running = runGraph(graphOf(['a']), 'T', backend, {
    onUpdate: v => void views.push(v),
    signal: controller.signal,
    wait: ms => { waits.push(ms); return new Promise<void>(resolve => (release = resolve)) },
  })
  void running.then(() => (finished = true))
  await tick()
  controller.abort()
  await tick()
  expect(finished).toBe(false)
  expect(waits).toEqual([15000])
  release()
  await running
  expect(views.at(-1)?.nodes['a']).toEqual({ status: 'cancelled', error: 'Stopped (not confirmed).' })
})

test('handoff files are announced under a folder unique to the sending node', async () => {
  const g = graphOf(['n_0123456789'])
  const prompt = promptFor(g, 'T', [{ from: 'n_0123456789', text: 'x', files: [{ id: 'f', name: 'a.md', fromNode: 'n_0123456789' }] }])
  expect(prompt).toContain('/workspace/handoff/n-0123456789-456789/: a.md')
})

test('the prompt names handoff files as the sandbox mounts them: plain names, numbered when equal', async () => {
  const g = graphOf(['n_0123456789'])
  const file = (name: string) => ({ id: name, name, fromNode: 'n_0123456789' })
  const prompt = promptFor(g, 'T', [{ from: 'n_0123456789', text: 'x', files: [file('report 10:30.md'), file('out/notes.md'), file('a/x.md'), file('b/x.md')] }])
  expect(prompt).toContain('/workspace/handoff/n-0123456789-456789/: report 10_30.md, notes.md, x.md, x-2.md')
})

test('a node records when it started', async () => {
  const { backend, finish } = controlled()
  const views: RunView[] = []
  const done = runGraph(graphOf(['a']), 'task', backend, { onUpdate: v => { views.push(v) }, now: () => 1234 })
  await tick()
  expect(views[views.length - 1]?.nodes['a']?.startedAt).toBe(1234)
  await finish('a')
  await done
})

test('the task is recorded, and stop ends a running node as cancelled with its end time', async () => {
  const g = connect(graphOf(['a', 'b']), 'a', 'b', 'handoff')
  const c = controlled()
  const controller = new AbortController()
  const views: RunView[] = []
  let clock = 100
  const running = runGraph(g, 'MY TASK', c.backend, { onUpdate: v => void views.push(v), signal: controller.signal, now: () => (clock += 10) })
  await tick()
  expect(views[0]?.task).toBe('MY TASK')
  controller.abort()
  await running
  const last = views.at(-1)!
  expect(last.task).toBe('MY TASK')
  expect(last.nodes['a']?.status).toBe('cancelled')
  expect(last.nodes['a']?.startedAt).toBe(110)
  expect(last.nodes['a']?.endedAt).toBe(120)
  expect(last.nodes['b']).toEqual({ status: 'skipped' })
})

test('finished nodes record when they ended; a failed node blocks what follows it', async () => {
  const g = connect(connect(graphOf(['a', 'b', 'c']), 'a', 'b', 'handoff'), 'b', 'c', 'handoff')
  const c = controlled(['a'])
  const views: RunView[] = []
  let clock = 0
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), now: () => ++clock })
  await tick()
  await c.finish('a')
  await running
  const last = views.at(-1)!
  expect(last.nodes['a']?.status).toBe('failed')
  expect(last.nodes['a']?.endedAt).toBe(2)
  expect(last.nodes['b']?.status).toBe('skipped')
  expect(last.nodes['b']?.endedAt).toBeUndefined()
})

test('a stopped run lists the cancelled agents in its result', async () => {
  const c = controlled()
  const controller = new AbortController()
  const views: RunView[] = []
  const running = runGraph(graphOf(['a']), 'T', c.backend, { onUpdate: v => void views.push(v), signal: controller.signal })
  await tick()
  controller.abort()
  const result = await running
  expect('result' in result ? result.result : '').toBe('## Stopped\n\n- A')
  expect(views.at(-1)?.result).toBe('## Stopped\n\n- A')
})

test('a seeded agent is done and reused, never started, and feeds its successor', async () => {
  const g = connect(connect(graphOf(['a', 'b']), 'a', 'b', 'handoff'), 'a', 'h', 'delegate')
  g.nodes.push(node('h'))
  const prepared: Graph[] = []
  const c = controlled()
  const backend: Backend = { ...c.backend, prepare: async graph => { prepared.push(graph); return [] } }
  const views: RunView[] = []
  const files = [{ id: 'f1', name: 'draft.md', fromNode: 'a' }]
  const seed = { a: { output: 'saved-a', files, runId: 'r0', at: 500, startedAt: 100, endedAt: 200, costUsd: 0.3 } }
  const running = runGraph(g, 'T', backend, { onUpdate: v => void views.push(v) }, seed)
  await tick()
  expect(c.started.map(s => s.id)).toEqual(['b'])
  expect(c.started[0]!.prompt).toContain('## Handoff from A\n\nsaved-a')
  expect(c.started[0]!.prompt).toContain('draft.md')
  // The seeded agent's output and files reach the successor as its handoff input.
  expect(c.started[0]!.inputs).toEqual([{ from: 'a', text: 'saved-a', files }])
  expect(views[0]?.nodes['a']).toEqual({ status: 'done', output: 'saved-a', reusedFrom: { runId: 'r0', at: 500 }, startedAt: 100, endedAt: 200, costUsd: 0.3 })
  expect(views[0]?.nodes['b']).toEqual({ status: 'waiting' })
  await c.finish('b')
  const result = await running
  expect('files' in result && result.files['a']).toEqual(files)
  expect('files' in result && result.files['b']).toEqual([])
  expect('endFiles' in result && result.endFiles).toEqual([])
  expect(views.at(-1)?.nodes['a']?.reusedFrom).toEqual({ runId: 'r0', at: 500 })
  expect(views.at(-1)?.result).toBe('## B\n\nout-b')
  // The backend prepares only what will run: no seeded agent, no edge touching it, no helper only it used.
  expect(prepared).toHaveLength(1)
  expect(prepared[0]!.nodes.map(n => n.id)).toEqual(['b'])
  expect(prepared[0]!.edges).toEqual([])
})

test('prepare keeps a helper that an agent which runs also delegates to', async () => {
  let g = graphOf(['a', 'b', 'h'])
  g = connect(connect(connect(g, 'a', 'b', 'handoff'), 'a', 'h', 'delegate'), 'b', 'h', 'delegate')
  const prepared: Graph[] = []
  const c = controlled()
  const backend: Backend = { ...c.backend, prepare: async graph => { prepared.push(graph); return [] } }
  const running = runGraph(g, 'T', backend, { onUpdate: () => {} }, { a: { output: 'x', files: [], runId: 'r0', at: 1 } })
  await tick()
  await c.finish('b')
  await running
  expect(prepared[0]!.nodes.map(n => n.id)).toEqual(['b', 'h'])
  expect(prepared[0]!.edges.map(e => `${e.from}>${e.to}`)).toEqual(['b>h'])
})

// A gate the test opens: each call is recorded and settles when the test says so.
function gates() {
  const calls: Array<{ id: string; prompt: string }> = []
  const open = new Map<string, (text: string) => void>()
  const gate = (id: string, prompt: string) => {
    calls.push({ id, prompt })
    return new Promise<string>(resolve => open.set(id, resolve))
  }
  return { calls, gate, release: async (id: string, text: string) => { open.get(id)!(text); await tick() } }
}

test('an agent in pauses is paused until its gate resolves, then starts with the returned prompt', async () => {
  const g = connect(graphOf(['a', 'b']), 'a', 'b', 'handoff')
  const c = controlled()
  const gt = gates()
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), gate: gt.gate, pauses: new Set(['b']) })
  await tick()
  await c.finish('a')
  expect(c.started.map(s => s.id)).toEqual(['a'])
  expect(views.at(-1)?.nodes['b']?.status).toBe('paused')
  expect(gt.calls).toEqual([{ id: 'b', prompt: 'T\n\n## Handoff from A\n\nout-a' }])
  await gt.release('b', 'MY EDIT')
  expect(c.started.map(s => s.id)).toEqual(['a', 'b'])
  expect(c.started[1]!.prompt).toBe('MY EDIT')
  await c.finish('b')
  await running
  expect(views.at(-1)?.nodes['b']).toMatchObject({ status: 'done', inputEdited: true, prompt: 'MY EDIT' })
  expect(views.at(-1)?.nodes['a']?.inputEdited).toBeUndefined()
})

test('a gate that returns the built prompt does not mark the input edited', async () => {
  const c = controlled()
  const gt = gates()
  const views: RunView[] = []
  const running = runGraph(graphOf(['a']), 'T', c.backend, { onUpdate: v => void views.push(v), gate: gt.gate, pauses: new Set(['a']) })
  await tick()
  await gt.release('a', 'T')
  expect(c.started[0]!.prompt).toBe('T')
  await c.finish('a')
  await running
  const entry = views.at(-1)!.nodes['a']!
  expect(entry.status).toBe('done')
  expect(entry.inputEdited).toBeUndefined()
  expect(entry.prompt).toBeUndefined()
})

test('a paused agent does not hold back a branch that does not depend on it', async () => {
  let g = graphOf(['a', 'b', 'c'])
  g = connect(connect(g, 'a', 'b', 'handoff'), 'a', 'c', 'handoff')
  const c = controlled()
  const gt = gates()
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), gate: gt.gate, pauses: new Set(['b']) })
  await tick()
  await c.finish('a')
  expect(c.started.map(s => s.id)).toEqual(['a', 'c'])
  await c.finish('c')
  expect(views.at(-1)?.nodes['c']?.status).toBe('done')
  expect(views.at(-1)?.nodes['b']?.status).toBe('paused')
  await gt.release('b', 'T\n\n## Handoff from A\n\nout-a')
  await c.finish('b')
  await running
  expect(views.at(-1)?.nodes['b']?.status).toBe('done')
})

test('paused agents do not count toward the parallel limit', async () => {
  const c = controlled()
  const gt = gates()
  const running = runGraph(graphOf(['a', 'b', 'c', 'd', 'e']), 'T', c.backend, { onUpdate: () => {}, gate: gt.gate, pauses: new Set(['a']) })
  await tick()
  expect(c.started.map(s => s.id)).toEqual(['b', 'c', 'd', 'e'])
  // Once released it starts and counts as running.
  await gt.release('a', 'T')
  expect(c.started.map(s => s.id)).toEqual(['b', 'c', 'd', 'e', 'a'])
  for (const id of ['b', 'c', 'd', 'e', 'a']) await c.finish(id)
  await running
})

test('a stop while an agent is paused skips it, never starts it, and ends the run', async () => {
  const g = connect(connect(graphOf(['a', 'b', 'c']), 'a', 'b', 'handoff'), 'b', 'c', 'handoff')
  const c = controlled()
  const gt = gates()
  const controller = new AbortController()
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), gate: gt.gate, pauses: new Set(['b']), signal: controller.signal })
  await tick()
  await c.finish('a')
  expect(views.at(-1)?.nodes['b']?.status).toBe('paused')
  controller.abort()
  await running
  const last = views.at(-1)!
  expect(last.isRunning).toBe(false)
  expect(last.nodes['b']?.status).toBe('skipped')
  expect(last.nodes['c']?.status).toBe('skipped')
  expect(c.started.map(s => s.id)).toEqual(['a'])
})

test('a gate that settles after a stop does not start the agent', async () => {
  const c = controlled()
  const gt = gates()
  const controller = new AbortController()
  const views: RunView[] = []
  const running = runGraph(graphOf(['a']), 'T', c.backend, { onUpdate: v => void views.push(v), gate: gt.gate, pauses: new Set(['a']), signal: controller.signal })
  await tick()
  controller.abort()
  await running
  await gt.release('a', 'late')
  expect(c.started).toEqual([])
  expect(views.at(-1)?.nodes['a']?.status).toBe('skipped')
})

test('a seeded agent in pauses never calls the gate', async () => {
  const g = connect(graphOf(['a', 'b']), 'a', 'b', 'handoff')
  const c = controlled()
  const gt = gates()
  const running = runGraph(g, 'T', c.backend, { onUpdate: () => {}, gate: gt.gate, pauses: new Set(['a']) }, { a: { output: 'saved', files: [], runId: 'r0', at: 1 } })
  await tick()
  expect(gt.calls).toEqual([])
  expect(c.started.map(s => s.id)).toEqual(['b'])
  await c.finish('b')
  await running
})

test('without a gate nothing pauses', async () => {
  const c = controlled()
  const running = runGraph(graphOf(['a']), 'T', c.backend, { onUpdate: () => {}, pauses: new Set(['a']) })
  await tick()
  expect(c.started.map(s => s.id)).toEqual(['a'])
  await c.finish('a')
  await running
})

test('a prompts entry is the agent prompt and marks the input edited', async () => {
  const g = connect(graphOf(['a', 'b']), 'a', 'b', 'handoff')
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v) }, { a: { output: 'saved', files: [], runId: 'r0', at: 1 } }, { b: 'CUSTOM' })
  await tick()
  expect(c.started.map(s => ({ id: s.id, prompt: s.prompt }))).toEqual([{ id: 'b', prompt: 'CUSTOM' }])
  await c.finish('b')
  await running
  expect(views.at(-1)?.nodes['b']).toMatchObject({ status: 'done', inputEdited: true, prompt: 'CUSTOM' })
})

test('a paused agent keeps its dependants waiting', async () => {
  const g = connect(graphOf(['a', 'b']), 'a', 'b', 'handoff')
  const c = controlled()
  const gt = gates()
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), gate: gt.gate, pauses: new Set(['a']) })
  await tick()
  expect(views.at(-1)?.nodes['a']?.status).toBe('paused')
  expect(views.at(-1)?.nodes['b']?.status).toBe('waiting')
  await gt.release('a', 'T')
  await c.finish('a')
  await c.finish('b')
  await running
})

// A promise the test settles by hand.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => (resolve = r))
  return { promise, resolve }
}

test('a clock that rejects for the start time does not fail the node', async () => {
  const c = controlled()
  const views: RunView[] = []
  let calls = 0
  const running = runGraph(graphOf(['a']), 'T', c.backend, {
    onUpdate: v => void views.push(v),
    now: async () => {
      if (++calls === 1) throw new Error('clock down')
      return 77
    },
  })
  await until(() => c.started.length === 1)
  await c.finish('a')
  await running
  const entry = views.at(-1)!.nodes['a']!
  expect(entry.status).toBe('done')
  expect(entry.startedAt).toBeUndefined()
  expect(entry.endedAt).toBe(77)
})

test('the start time is published before the backend has started the agent', async () => {
  const gate = deferred<NodeRun>()
  const backend: Backend = { prepare: async () => [], start: () => gate.promise }
  const views: RunView[] = []
  const running = runGraph(graphOf(['a']), 'T', backend, { onUpdate: v => void views.push(v), now: () => 4321 })
  await until(() => views.some(v => v.nodes['a']?.startedAt === 4321))
  expect(views.at(-1)?.nodes['a']).toMatchObject({ status: 'running', startedAt: 4321 })
  gate.resolve({ done: Promise.resolve({ ok: true, text: 'x', files: [] }), stop: async () => {} })
  await running
})

// A backend over `controlled()` whose updates hold still once the agent has been started.
function holdingAfterStart() {
  const c = controlled()
  const hold = deferred<void>()
  let holding = false
  const backend: Backend = {
    ...c.backend,
    start: async (n, p, i, onCost) => {
      holding = true
      return c.backend.start(n, p, i, onCost)
    },
  }
  const onUpdate = async (v: RunView) => {
    if (holding && v.nodes['a']?.status === 'running') await hold.promise
  }
  return { c, backend, hold, onUpdate }
}

test('a run is asked to stop once even when the abort lands while the start is being published', async () => {
  const h = holdingAfterStart()
  const controller = new AbortController()
  const running = runGraph(graphOf(['a']), 'T', h.backend, { signal: controller.signal, onUpdate: h.onUpdate })
  await until(() => h.c.started.length === 1)
  await tick()
  controller.abort()
  await tick()
  h.hold.resolve()
  await running
  expect(h.c.stopped).toEqual(['a'])
})

test('a stop that lands while the start time is published never starts the agent, and ends it cancelled', async () => {
  const c = controlled()
  const hold = deferred<void>()
  let held = false
  const controller = new AbortController()
  const views: RunView[] = []
  const onUpdate = async (v: RunView) => {
    views.push(v)
    if (!held && v.nodes['a']?.startedAt !== undefined) {
      held = true
      await hold.promise
    }
  }
  const running = runGraph(graphOf(['a']), 'T', c.backend, { onUpdate, signal: controller.signal, now: () => 55 })
  await until(() => held)
  controller.abort()
  await tick()
  hold.resolve()
  await running
  expect(c.started).toEqual([])
  expect(views.at(-1)?.nodes['a']).toMatchObject({ status: 'cancelled', error: 'Stopped.' })
})

test('an update callback that throws or rejects does not break the run', async () => {
  for (const onUpdate of [
    () => { throw new Error('sync boom') },
    async () => { throw new Error('async boom') },
  ]) {
    const c = controlled()
    const running = runGraph(graphOf(['a']), 'T', c.backend, { onUpdate })
    await until(() => c.started.length === 1)
    await c.finish('a')
    const result = await running
    expect('result' in result ? result.result : '').toBe('## A\n\nout-a')
  }
})

test('the abort listener is removed once the run is over', async () => {
  const listeners = new Set<() => void>()
  const signal = {
    aborted: false,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
  } as unknown as AbortSignal
  const c = controlled()
  const running = runGraph(graphOf(['a']), 'T', c.backend, { onUpdate: () => {}, signal })
  await until(() => c.started.length === 1)
  expect(listeners.size).toBe(1)
  await c.finish('a')
  await running
  expect(listeners.size).toBe(0)
})

test('a start that resolves just as the stop deadline passes ends the node as stopped, not as unconfirmed', async () => {
  const gate = deferred<NodeRun>()
  const stopped: string[] = []
  const backend: Backend = { prepare: async () => [], start: () => gate.promise }
  const controller = new AbortController()
  const views: RunView[] = []
  const running = runGraph(graphOf(['a']), 'T', backend, { onUpdate: v => void views.push(v), signal: controller.signal, wait: async () => {} })
  await tick()
  controller.abort()
  // The run never confirms through `done`, but its stop is accepted.
  gate.resolve({ done: new Promise<NodeOutcome>(() => {}), stop: async () => void stopped.push('a') })
  await running
  expect(stopped).toEqual(['a'])
  expect(views.at(-1)?.nodes['a']).toEqual({ status: 'cancelled', error: 'Stopped.' })
})

test('a backend start that never returns does not hold a stopped run, and a late start is stopped', async () => {
  const gate = deferred<NodeRun>()
  const stopped: string[] = []
  const backend: Backend = { prepare: async () => [], start: () => gate.promise }
  const controller = new AbortController()
  const views: RunView[] = []
  let release!: () => void
  const running = runGraph(graphOf(['a']), 'T', backend, {
    onUpdate: v => void views.push(v),
    signal: controller.signal,
    wait: () => new Promise<void>(resolve => (release = resolve)),
  })
  await tick()
  controller.abort()
  await tick()
  release()
  await running
  expect(views.at(-1)?.nodes['a']).toEqual({ status: 'cancelled', error: 'Stopped (not confirmed).' })
  expect(stopped).toEqual([])
  gate.resolve({ done: new Promise<NodeOutcome>(() => {}), stop: async () => void stopped.push('a') })
  await until(() => stopped.length === 1)
})

test('a failure that landed before the stop stays a failure', async () => {
  const h = holdingAfterStart()
  const controller = new AbortController()
  const views: RunView[] = []
  const running = runGraph(graphOf(['a']), 'T', h.backend, {
    signal: controller.signal,
    onUpdate: v => {
      views.push(v)
      return h.onUpdate(v)
    },
  })
  await until(() => h.c.started.length === 1)
  await tick()
  // The agent fails, then the person presses Stop before the runner has looked at the outcome.
  h.c.finishers.get('a')!({ ok: false, reason: 'a broke' })
  await tick()
  controller.abort()
  h.hold.resolve()
  await running
  expect(views.at(-1)?.nodes['a']).toEqual({ status: 'failed', error: 'a broke' })
})

test('a seeded agent that a running agent delegates to is kept for the backend, with that arrow only', async () => {
  const g = connect(connect(graphOf(['a', 'b']), 'a', 'b', 'handoff'), 'b', 'a', 'delegate')
  const prepared: Graph[] = []
  const c = controlled()
  const backend: Backend = { ...c.backend, prepare: async graph => { prepared.push(graph); return [] } }
  const running = runGraph(g, 'T', backend, { onUpdate: () => {} }, { a: { output: 'saved', files: [], runId: 'r0', at: 1 } })
  await until(() => c.started.length === 1)
  expect(c.started.map(s => s.id)).toEqual(['b'])
  await c.finish('b')
  await running
  expect(prepared[0]!.nodes.map(n => n.id)).toEqual(['a', 'b'])
  expect(prepared[0]!.edges.map(e => `${e.from}>${e.to}:${e.kind}`)).toEqual(['b>a:delegate'])
})

test('problems on a reused agent do not stop the run, problems on one that runs do', async () => {
  const nameless = (id: string): Graph => {
    const g = connect(graphOf(['a', 'b']), 'a', 'b', 'handoff')
    g.nodes = g.nodes.map(n => (n.id === id ? { ...n, name: '' } : n))
    return g
  }
  const seed = { a: { output: 'saved', files: [], runId: 'r0', at: 1 } }
  const c = controlled()
  const reused = runGraph(nameless('a'), 'T', c.backend, { onUpdate: () => {} }, seed)
  await until(() => c.started.length === 1)
  await c.finish('b')
  expect('result' in (await reused)).toBe(true)
  const blocked = await runGraph(nameless('b'), 'T', controlled().backend, { onUpdate: () => {} }, seed)
  expect('problems' in blocked ? blocked.problems.map(p => p.message) : []).toEqual(['Give this agent a name.'])
})

test('a ready paused agent shows paused even while every slot is taken', async () => {
  const c = controlled()
  const gt = gates()
  const views: RunView[] = []
  const running = runGraph(graphOf(['a', 'b', 'c', 'd', 'e']), 'T', c.backend, { onUpdate: v => void views.push(v), gate: gt.gate, pauses: new Set(['e']) })
  await until(() => c.started.length === 4 && gt.calls.length === 1)
  expect(views.at(-1)?.nodes['e']?.status).toBe('paused')
  expect(c.started.map(s => s.id)).toEqual(['a', 'b', 'c', 'd'])
  for (const id of ['a', 'b', 'c', 'd']) await c.finish(id)
  await gt.release('e', 'T')
  await c.finish('e')
  await running
})

test('a gate that rejects fails that agent and skips what follows it', async () => {
  const g = connect(graphOf(['a', 'b']), 'a', 'b', 'handoff')
  const c = controlled()
  const views: RunView[] = []
  const result = await runGraph(g, 'T', c.backend, {
    onUpdate: v => void views.push(v),
    gate: async () => { throw new Error('gate broke') },
    pauses: new Set(['a']),
  })
  const last = views.at(-1)!
  expect(c.started).toEqual([])
  expect(last.nodes['a']).toMatchObject({ status: 'failed', error: 'gate broke' })
  expect(last.nodes['b']?.status).toBe('skipped')
  expect('failures' in result ? result.failures : {}).toEqual({ a: 'gate broke' })
})

test('an already-aborted signal starts nothing and skips every agent', async () => {
  const g = connect(graphOf(['a', 'b']), 'a', 'b', 'handoff')
  const c = controlled()
  const controller = new AbortController()
  controller.abort()
  const views: RunView[] = []
  await runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), signal: controller.signal })
  expect(c.started).toEqual([])
  const last = views.at(-1)!
  expect(last.isRunning).toBe(false)
  expect(last.nodes['a']?.status).toBe('skipped')
  expect(last.nodes['b']?.status).toBe('skipped')
})

test('a cost reported after the run is over publishes nothing', async () => {
  const c = controlled()
  let report!: (usd: number) => void
  const backend: Backend = { ...c.backend, start: (n, p, i, onCost) => { report = onCost; return c.backend.start(n, p, i, onCost) } }
  const views: RunView[] = []
  const running = runGraph(graphOf(['a']), 'T', backend, { onUpdate: v => void views.push(v) })
  await until(() => c.started.length === 1)
  await c.finish('a')
  await running
  const before = views.length
  report(0.5)
  await tick()
  expect(views).toHaveLength(before)
  expect(views.at(-1)?.isRunning).toBe(false)
})

test('a kept seeded helper brings the helpers only it delegated to', async () => {
  let g = connect(connect(graphOf(['a', 'b']), 'a', 'b', 'handoff'), 'b', 'a', 'delegate')
  g = connect(g, 'a', 'x', 'delegate')
  g.nodes.push(node('x'))
  const prepared: Graph[] = []
  const c = controlled()
  const backend: Backend = { ...c.backend, prepare: async graph => { prepared.push(graph); return [] } }
  const running = runGraph(g, 'T', backend, { onUpdate: () => {} }, { a: { output: 'saved', files: [], runId: 'r0', at: 1 } })
  await until(() => c.started.length === 1)
  await c.finish('b')
  await running
  expect(prepared[0]!.nodes.map(n => n.id).sort()).toEqual(['a', 'b', 'x'])
  expect(prepared[0]!.edges.map(e => `${e.from}>${e.to}:${e.kind}`).sort()).toEqual(['a>x:delegate', 'b>a:delegate'])
})

const clockOf = () => {
  let t = 0
  return { now: () => t, set: (n: number) => (t = n) }
}

test('the runner copies an agent activity and current call into the view', async () => {
  const clock = clockOf()
  const tracker = createTracker(() => {}, clock.now)
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(graphOf(['a', 'b']), 'T', c.backend, { onUpdate: v => void views.push(v), activity: tracker })
  await until(() => c.started.length === 2)
  expect(views.at(-1)!.nodes['a']!.activity).toBeUndefined()
  tracker.watch('ka', 'a')
  const id = tracker.callStart('ka', 'Bash', { command: 'npm test' })!
  await tick()
  expect(views.at(-1)!.nodes['a']).toMatchObject({ status: 'running', current: 'npm test', activity: [{ id, tool: 'Bash', status: 'running', input: '{"command":"npm test"}' }] })
  expect(views.at(-1)!.nodes['b']!.activity).toBeUndefined()
  tracker.callEnd(id, { ok: true, result: 'ok' })
  await tick()
  expect(views.at(-1)!.nodes['a']!.current).toBeUndefined()
  expect(views.at(-1)!.nodes['a']!.activity).toMatchObject([{ status: 'ok', result: 'ok' }])
  await c.finish('a')
  await c.finish('b')
  await running
  expect(views.at(-1)!.nodes['a']).toMatchObject({ status: 'done', activity: [{ id }] })
})

test('a call still running when the agent ends is no longer its current call', async () => {
  const tracker = createTracker(() => {}, () => 0)
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(graphOf(['a']), 'T', c.backend, { onUpdate: v => void views.push(v), activity: tracker })
  await until(() => c.started.length === 1)
  tracker.watch('ka', 'a')
  tracker.callStart('ka', 'Bash', { command: 'sleep 9' })
  await tick()
  expect(views.at(-1)!.nodes['a']!.current).toBe('sleep 9')
  await c.finish('a')
  await running
  expect(views.at(-1)!.nodes['a']!.current).toBeUndefined()
})

test('a delegate helper gets an entry while it is called, and keeps its calls', async () => {
  const clock = clockOf()
  const tracker = createTracker(() => {}, clock.now)
  const g = connect(graphOf(['a', 'h']), 'a', 'h', 'delegate')
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), activity: tracker })
  await until(() => c.started.length === 1)
  expect(Object.keys(views.at(-1)!.nodes)).toEqual(['a'])
  tracker.watch('ka', 'a')
  clock.set(100)
  const call = tracker.callStart('ka', 'Agent', { description: 'ask the helper' })!
  tracker.childOf('ka', 'kh', 'H', 'h')
  clock.set(150)
  const inner = tracker.callStart('kh', 'Read', { file_path: '/f' })!
  await tick()
  expect(views.at(-1)!.nodes['h']).toEqual({
    status: 'running', calledBy: 'a', startedAt: 100, current: '/f',
    activity: [expect.objectContaining({ id: inner, tool: 'Read', status: 'running' })],
  })
  clock.set(200)
  tracker.callEnd(inner, { ok: true })
  tracker.callEnd(call, { ok: true, result: 'answer' })
  await tick()
  const ended = views.at(-1)!.nodes['h']!
  expect(ended).toMatchObject({ status: 'done', calledBy: 'a', startedAt: 100, endedAt: 200 })
  expect(ended.current).toBeUndefined()
  await c.finish('a')
  const result = await running
  const last = views.at(-1)!
  expect(last.nodes['h']!.status).toBe('done')
  expect(last.nodes['a']!.activity).toMatchObject([{ tool: 'Agent', delegate: { nodeId: 'h', items: [{ tool: 'Read' }] } }])
  expect('failures' in result ? result.failures : null).toEqual({})
})

test('a helper whose call failed ends failed without failing the run or its result', async () => {
  const tracker = createTracker(() => {}, () => 1)
  const g = connect(graphOf(['a', 'h']), 'a', 'h', 'delegate')
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), activity: tracker })
  await until(() => c.started.length === 1)
  tracker.watch('ka', 'a')
  const id = tracker.childOf('ka', 'kh', 'H', 'h')!
  tracker.callEnd(id, { ok: false, error: 'helper broke' })
  await tick()
  expect(views.at(-1)!.nodes['h']).toMatchObject({ status: 'failed', error: 'helper broke', calledBy: 'a' })
  await c.finish('a')
  const result = await running
  expect('result' in result ? result.result : '').toBe('## A\n\nout-a')
  expect('failures' in result ? result.failures : null).toEqual({})
})

test('a call still open when its agent ends is failed "Not finished when the run ended.", and so is its helper', async () => {
  const tracker = createTracker(() => {}, () => 1)
  const g = connect(graphOf(['a', 'h']), 'a', 'h', 'delegate')
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), activity: tracker, now: () => 7 })
  await until(() => c.started.length === 1)
  tracker.watch('ka', 'a')
  tracker.childOf('ka', 'kh', 'H', 'h')
  await tick()
  await c.finish('a')
  await running
  const last = views.at(-1)!
  expect(last.nodes['a']!.activity).toMatchObject([{ status: 'failed', error: 'Not finished when the run ended.', endedAt: 1 }])
  expect(last.nodes['h']).toMatchObject({ status: 'failed', error: 'Not finished when the run ended.', endedAt: 1 })
})

test('a stop ends the calls still open as failed "Stopped."; the stopped helper is cancelled', async () => {
  const tracker = createTracker(() => {}, () => 5)
  const g = connect(graphOf(['a', 'h']), 'a', 'h', 'delegate')
  const c = controlled()
  const ctl = new AbortController()
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), activity: tracker, signal: ctl.signal })
  await until(() => c.started.length === 1)
  tracker.watch('ka', 'a')
  const bash = tracker.callStart('ka', 'Bash', { command: 'sleep 99' })!
  tracker.callStart('ka', 'Agent', { description: 'ask' })
  tracker.childOf('ka', 'kh', 'H', 'h')
  tracker.callStart('kh', 'Read', { file_path: '/f' })
  await tick()
  ctl.abort()
  await running
  const last = views.at(-1)!
  expect(last.nodes['a']!.status).toBe('cancelled')
  expect(last.nodes['a']!.activity).toMatchObject([
    { id: bash, status: 'failed', error: 'Stopped.', endedAt: 5 },
    { tool: 'Agent', status: 'failed', error: 'Stopped.', delegate: { items: [{ status: 'failed', error: 'Stopped.', endedAt: 5 }] } },
  ])
  expect(last.nodes['h']).toMatchObject({ status: 'cancelled', error: 'Stopped.', endedAt: 5 })
  expect(last.nodes['h']!.activity).toMatchObject([{ status: 'failed', error: 'Stopped.' }])
  // A hook that answers after the stop changes nothing.
  tracker.callEnd(bash, { ok: true, result: 'late' })
  expect(tracker.itemsOf('a')[0]).toMatchObject({ status: 'failed', error: 'Stopped.' })
})

test('a reused agent keeps the activity of the run it is reused from', async () => {
  const g = connect(graphOf(['a', 'b']), 'a', 'b', 'handoff')
  const c = controlled()
  const views: RunView[] = []
  const activity = [{ id: 'c1', tool: 'Bash', summary: 'ls', status: 'ok' as const, startedAt: 1, endedAt: 2 }]
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v) }, { a: { output: 'saved', files: [], runId: 'r0', at: 9, activity } })
  await until(() => c.started.length === 1)
  expect(c.started[0]!.id).toBe('b')
  await c.finish('b')
  await running
  expect(views.at(-1)!.nodes['a']).toMatchObject({ status: 'done', reusedFrom: { runId: 'r0', at: 9 }, activity })
})

test('a delegate call to a node that runs on its own is not given a helper entry', async () => {
  const tracker = createTracker(() => {}, () => 1)
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(graphOf(['a', 'b']), 'T', c.backend, { onUpdate: v => void views.push(v), activity: tracker })
  await until(() => c.started.length === 2)
  tracker.watch('ka', 'a')
  tracker.childOf('ka', 'kb', 'B', 'b')
  await tick()
  expect(views.at(-1)!.nodes['b']).toEqual({ status: 'running' })
  await c.finish('a')
  await c.finish('b')
  await running
})

test('activity publishes are throttled to every 250 ms with a trailing publish', async () => {
  const clock = clockOf()
  const tracker = createTracker(() => {}, clock.now)
  const waits: Array<{ ms: number; release: () => void }> = []
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(graphOf(['a']), 'T', c.backend, {
    onUpdate: v => void views.push(v),
    activity: tracker,
    now: clock.now,
    wait: ms => new Promise<void>(resolve => waits.push({ ms, release: resolve })),
  })
  await until(() => c.started.length === 1)
  await tick()
  tracker.watch('ka', 'a')
  const base = views.length
  // A burst is one publish.
  for (let i = 0; i < 5; i++) tracker.callStart('ka', 'Bash', { command: `c${i}` })
  await tick()
  expect(views.length).toBe(base + 1)
  expect(views.at(-1)!.nodes['a']!.activity).toHaveLength(5)
  // Soon after: held back, and the wait is for what is left of the 250 ms.
  clock.set(100)
  for (let i = 5; i < 8; i++) tracker.callStart('ka', 'Bash', { command: `c${i}` })
  await tick()
  expect(views.length).toBe(base + 1)
  expect(waits.map(w => w.ms)).toEqual([150])
  tracker.callStart('ka', 'Bash', { command: 'c8' })
  await tick()
  expect(waits).toHaveLength(1)
  // The trailing publish has everything.
  clock.set(250)
  waits[0]!.release()
  await tick()
  expect(views.length).toBe(base + 2)
  expect(views.at(-1)!.nodes['a']!.activity).toHaveLength(9)
  // After a quiet time a change publishes at once.
  clock.set(1000)
  tracker.callStart('ka', 'Bash', { command: 'late' })
  await tick()
  expect(views.length).toBe(base + 3)
  expect(waits).toHaveLength(1)
  await c.finish('a')
  await running
})

test('a trailing activity publish never goes out after the run is over', async () => {
  const clock = clockOf()
  const tracker = createTracker(() => {}, clock.now)
  const waits: Array<() => void> = []
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(graphOf(['a']), 'T', c.backend, {
    onUpdate: v => void views.push(v),
    activity: tracker,
    now: clock.now,
    wait: () => new Promise<void>(resolve => waits.push(resolve)),
  })
  await until(() => c.started.length === 1)
  tracker.watch('ka', 'a')
  tracker.callStart('ka', 'Bash', { command: 'one' })
  await tick()
  clock.set(10)
  tracker.callStart('ka', 'Bash', { command: 'two' })
  await tick()
  expect(waits).toHaveLength(1)
  await c.finish('a')
  await running
  const before = views.length
  expect(views.at(-1)!.isRunning).toBe(false)
  waits[0]!()
  tracker.callStart('ka', 'Bash', { command: 'after' })
  await tick()
  await tick()
  expect(views).toHaveLength(before)
  expect(views.at(-1)!.nodes['a']!.activity).toHaveLength(2)
})

test('a view callback that fails while activity comes in does not fail the run', async () => {
  const tracker = createTracker(() => {}, () => 1)
  const c = controlled()
  let calls = 0
  const running = runGraph(graphOf(['a']), 'T', c.backend, { onUpdate: () => { if (++calls > 1) throw new Error('view broke') }, activity: tracker })
  await until(() => c.started.length === 1)
  tracker.watch('ka', 'a')
  tracker.callStart('ka', 'Bash', { command: 'x' })
  await tick()
  await c.finish('a')
  const result = await running
  expect('result' in result).toBe(true)
})

test('a clock that fails at the end of the run still leaves no helper running', async () => {
  const tracker = createTracker(() => {}, () => 1)
  const g = connect(graphOf(['a', 'h']), 'a', 'h', 'delegate')
  const c = controlled()
  const views: RunView[] = []
  let calls = 0
  const running = runGraph(g, 'T', c.backend, {
    onUpdate: v => void views.push(v),
    activity: tracker,
    now: () => { if (++calls > 3) throw new Error('clock'); return calls },
  })
  await until(() => c.started.length === 1)
  tracker.watch('ka', 'a')
  tracker.childOf('ka', 'kh', 'H', 'h')
  await tick()
  await c.finish('a')
  await running
  expect(views.at(-1)!.nodes['h']!.status).toBe('failed')
})

test('a string abort reason is the error of the agents the stop ends, whichever way they end; a plain abort stays "Stopped."', async () => {
  const REASON = 'Stopped: the run reached its $1.00 cap.'
  for (const [reason, expected] of [[REASON, REASON], [undefined, 'Stopped.']] as const) {
    // a is running when the stop comes (its backend words the stop as "Stopped."); b was waiting for it.
    const g = connect(graphOf(['a', 'b']), 'a', 'b', 'handoff')
    const c = controlled()
    const controller = new AbortController()
    const views: RunView[] = []
    const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), signal: controller.signal })
    await until(() => c.started.length === 1)
    if (reason !== undefined) controller.abort(reason)
    else controller.abort()
    await running
    expect(c.stopped).toEqual(['a'])
    expect(views.at(-1)?.nodes['a']).toMatchObject({ status: 'cancelled', error: expected })
    expect(views.at(-1)?.nodes['b']?.status).toBe('skipped')
  }
})

test('a stop that came before an agent started gives it the abort reason too, and a failure of its own keeps its text', async () => {
  const REASON = 'Stopped: the run reached its $2.00 cap.'
  const c = controlled(['b'])
  const controller = new AbortController()
  const g = graphOf(['a', 'b'])
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v), signal: controller.signal })
  await until(() => c.started.length === 2)
  // b fails by itself before the stop; a is then stopped by the cap.
  await c.finish('b')
  controller.abort(REASON)
  await running
  expect(views.at(-1)?.nodes['b']).toMatchObject({ status: 'failed', error: 'b broke' })
  expect(views.at(-1)?.nodes['a']).toMatchObject({ status: 'cancelled', error: REASON })
})

test('an agent without a retry arrow out is not a judge: no verdict is read and no rounds are kept', async () => {
  const g = connect(graphOf(['a', 'b']), 'a', 'b', 'handoff')
  const c = controlled()
  const views: RunView[] = []
  const running = runGraph(g, 'T', c.backend, { onUpdate: v => void views.push(v) })
  await tick()
  await c.finish('a')
  await c.finish('b')
  await running
  expect(c.started.map(s => s.id)).toEqual(['a', 'b'])
  for (const id of ['a', 'b']) {
    expect(views.at(-1)?.nodes[id]).toEqual({ status: 'done', output: `out-${id}` })
  }
})
