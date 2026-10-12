import { expect } from 'claude-code/testing'
import { test } from './kit'

import {
  acceptLatest, activityRun, cachedTests, compareTest, completions, deleteGraph, deleteTest, editMustHold, isBusy, isTesting, loadTests, openGraph, runAllTests, runTest, saveAsTest,
  setMustHold, startRun, stopRun, type Host,
} from '../hooks/actions'
import { EMPTY_UI, type Slots } from '../hooks/state'
import type { AgentNode, Graph, RunIndex, RunRecord, TestCase } from '../types'

declare const setTimeout: (run: () => void, ms?: number) => unknown

// The actions over a host made of plain maps (as tests/run-history.test.ts does), with a local agent that
// answers at once (or is held), and a grader that answers from a script.
// An agent card with its instructions file in its graph's own folder (no home in these tests).
const node = (graphId: string, id: string, name: string, x: number, patch: Partial<AgentNode> = {}): AgentNode => ({
  id, name, x, y: 1, instructionsFile: `./.claude/agent-graph/${graphId}/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2, ...patch,
})
const flow = (id: string, patch: Partial<AgentNode> = {}): Graph => ({
  id, name: 'Flow', description: '', backend: 'local', layout: 2,
  nodes: [node(id, 'a', 'Alpha', 2, patch), node(id, 'b', 'Bravo', 40)],
  edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }],
})

type Reply = string | Error | { refused: string }
type Grade = { model: string; prompt: string }

function memory(g: Graph) {
  const kv = new Map<string, unknown>([[`graph:${g.id}`, g], ['graphs', [{ id: g.id, name: g.name }]]])
  const fs = new Map<string, string>(g.nodes.map(n => [n.instructionsFile, `Instructions of ${n.name}.`] as const))
  const slots: Slots = { index: [], graph: g, ui: { ...EMPTY_UI, graphId: g.id }, run: null, agents: [] }
  const toasts: string[] = []
  const opened: string[] = []
  const held: string[] = []
  const spawns: string[] = []
  // What an agent (by name) costs the run, in dollars: told to the run's meter as the agent starts working.
  const costs = new Map<string, number>()
  // What the grader answers, one reply per call; the last one repeats. `onGrade` runs on each call.
  const grader: { replies: Reply[]; calls: Grade[]; onGrade: (n: number) => void; gate?: Promise<void> } = { replies: ['{"pass": true, "reason": "Same."}'], calls: [], onGrade: () => {} }
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  let spawned = 0
  const host = {
    env: { get: async () => undefined },
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
    process: {
      run: async (argv: string[]) => {
        if (argv[0] === 'rm') {
          const target = argv[argv.length - 1]!
          fs.delete(target)
          // A folder (rm -rf) takes everything in it along.
          if (argv.includes('-rf')) for (const path of [...fs.keys()]) if (path.startsWith(`${target}/`)) fs.delete(path)
        }
        else opened.push(argv[argv.length - 1]!)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    tool: {
      register: async () => undefined,
      call: async (input: { tool: string; task_id?: string }) => {
        if (input.tool === 'TaskStop') completions.complete({ agentId: input.task_id!, answer: '', reason: 'aborted' })
        return undefined
      },
    },
    ui: { open: async () => ({ isPlaced: true }), close: async () => undefined, toast: (text: string) => void toasts.push(text) },
    session: { authorize: async () => null },
    http: { fetch: async () => ({ status: 500, ok: false, headers: {}, text: '' }) },
    clock: { after: (_ms: number, run: () => void) => void setTimeout(run, 0), now: async () => Date.now() },
    agent: {
      register: async () => undefined,
      spawn: async (args: { description: string }) => {
        const name = args.description.split(' ')[0]!
        const agentId = `ag${++spawned}`
        spawns.push(name)
        const cost = costs.get(name)
        if (cost !== undefined) {
          // Sonnet 4.6 output tokens at $15 per million.
          const usage = { model: 'claude-sonnet-4-6', input_tokens: 0, output_tokens: Math.round((cost / 15) * 1e6), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
          setTimeout(() => {
            activityRun()?.meter.add(agentId, usage, 0)
            if (!held.includes(name)) completions.complete({ agentId, answer: `${name.toUpperCase()}-OUT`, reason: 'answer' })
          }, 1)
        } else if (!held.includes(name)) void Promise.resolve().then(() => completions.complete({ agentId, answer: `${name.toUpperCase()}-OUT`, reason: 'answer' }))
        return { model: 'm', agentId }
      },
    },
    prompt: { submit: async () => undefined, fill: async () => undefined },
    model: {
      complete: async (request: Grade) => {
        grader.calls.push(request)
        grader.onGrade(grader.calls.length)
        await grader.gate
        const reply = grader.replies[Math.min(grader.calls.length, grader.replies.length) - 1]!
        if (reply instanceof Error) throw reply
        if (typeof reply !== 'string') return { isAnswered: false, reason: 'api-error', status: 429, error: reply.refused, usage }
        return { isAnswered: true, text: reply, usage }
      },
    },
    read: async (slot: keyof Slots) => slots[slot],
    update: async (slot: keyof Slots, change: (value: unknown) => unknown) => ((slots as Record<string, unknown>)[slot] = change(slots[slot])),
  } as unknown as Host
  return { host, slots, kv, fs, toasts, opened, held, spawns, grader, costs }
}

type Memory = ReturnType<typeof memory>

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 2))
async function until(done: () => boolean) {
  for (let i = 0; i < 1500 && !done(); i++) await tick()
  expect(done()).toBe(true)
}

const indexOf = (m: Memory, id: string) => m.kv.get(`runs:${id}`) as RunIndex
const recordOf = (m: Memory, graphId: string, runId: string) => JSON.parse(m.fs.get(`./.claude/agent-graph/${graphId}/runs/${runId}.json`)!) as RunRecord
const testsFile = (g: Graph) => `./.claude/agent-graph/${g.id}/tests.json`
const testsOf = (m: Memory, g: Graph) => JSON.parse(m.fs.get(testsFile(g)) ?? '[]') as TestCase[]
const verdicts = (m: Memory, g: Graph) => testsOf(m, g).map(t => t.last?.verdict)
const batchToasts = (m: Memory) => m.toasts.filter(t => t.startsWith('Tests:'))

// A normal run in the pane, finished.
async function runTo(m: Memory, g: Graph, task: string) {
  const ends = m.toasts.filter(t => /finished|was stopped/.test(t)).length
  expect(await startRun(m.host, g, task, 'pane')).toBeUndefined()
  await until(() => m.toasts.filter(t => /finished|was stopped/.test(t)).length > ends)
}

// A test saved from a run of this task.
async function saved(m: Memory, g: Graph, task: string): Promise<TestCase> {
  await runTo(m, g, task)
  await saveAsTest(m.host)
  return testsOf(m, g).find(t => t.task === task)!
}

test('Save as test keeps the task and the result of the run on show, and toasts', async () => {
  const g = flow('t-save')
  const m = memory(g)
  await runTo(m, g, 'Write a haiku\nabout autumn')
  const run = m.slots.run!
  await saveAsTest(m.host)
  const [test] = testsOf(m, g)
  expect(testsOf(m, g)).toHaveLength(1)
  expect(test).toMatchObject({ name: 'Write a haiku', task: 'Write a haiku\nabout autumn', expected: run.result, mustHold: '', fromRun: run.runId })
  expect(test!.id).toMatch(/^t/)
  expect(test!.createdAt).toBeGreaterThan(0)
  expect(test!.last).toBeUndefined()
  expect(m.toasts).toContain('Saved test "Write a haiku".')
  expect(cachedTests(g.id)).toEqual(testsOf(m, g))
  // The cache is filled from the file when a graph opens.
  await loadTests(m.host, g.id)
  expect(cachedTests(g.id)).toHaveLength(1)
})

test('Save as test does nothing without a finished run that has a result', async () => {
  const g = flow('t-save-none')
  const m = memory(g)
  await saveAsTest(m.host)
  m.slots.run = { graphId: g.id, graphName: 'Flow', isRunning: true, nodes: {}, task: 'Task', result: 'partial' }
  await saveAsTest(m.host)
  m.slots.run = { graphId: g.id, graphName: 'Flow', isRunning: false, nodes: {}, result: 'no task' }
  await saveAsTest(m.host)
  expect(m.fs.has(testsFile(g))).toBe(false)
  expect(m.toasts).toEqual([])
})

test('Run one test records a test run, leaves latest alone, and saves the grade', async () => {
  const g = flow('t-one')
  const m = memory(g)
  const test = await saved(m, g, 'Write a haiku')
  const before = indexOf(m, g.id)
  // The task box is not used by a test.
  m.slots.ui = { ...m.slots.ui, task: 'Something else entirely' }
  m.grader.replies = ['Sure.\n{"pass": true, "reason": "Same haiku."}']
  await runTest(m.host, test.id)
  await until(() => batchToasts(m).length > 0)

  const after = indexOf(m, g.id)
  expect(after.runs).toHaveLength(2)
  expect(after.latest).toEqual(before.latest)
  const [summary] = after.runs
  expect(summary).toMatchObject({ mode: 'test', testName: 'Write a haiku', taskLine: 'Write a haiku', ending: 'finished' })
  const record = recordOf(m, g.id, summary!.id)
  expect(record).toMatchObject({ mode: 'test', testId: test.id, task: 'Write a haiku', ending: 'finished' })
  expect(record.nodes['b']).toMatchObject({ status: 'done', output: 'BRAVO-OUT' })

  const [graded] = testsOf(m, g)
  expect(graded!.last).toEqual({ verdict: 'pass', reason: 'Same haiku.', runId: summary!.id, at: expect.any(Number), result: record.result })
  expect(cachedTests(g.id)).toEqual(testsOf(m, g))
  expect(m.grader.calls).toHaveLength(1)
  expect(m.grader.calls[0]!.model).toBe('sonnet')
  expect(m.grader.calls[0]!.prompt).toContain('Write a haiku')
  expect(batchToasts(m)).toEqual(['Tests: 1 passed, 0 failed'])
  // Another run can start now.
  expect(await startRun(m.host, g, 'Next', 'pane')).toBeUndefined()
  await until(() => m.toasts.filter(t => /finished/.test(t)).length >= 2)
})

test('a test run never pauses, even before an agent marked to pause', async () => {
  const g = flow('t-nopause')
  const m = memory(g)
  const test = await saved(m, g, 'Task')
  // Alpha is marked to pause only now: a run in the pane would stop before it.
  m.kv.set(`graph:${g.id}`, flow(g.id, { pauseBefore: true }))
  await runTest(m.host, test.id)
  await until(() => batchToasts(m).length > 0)
  expect(m.slots.run?.nodes['a']?.status).toBe('done')
  expect(testsOf(m, g)[0]!.last?.verdict).toBe('pass')
})

test('a failed test is graded fail with the grader\'s reason; must-hold notes go to the grader', async () => {
  const g = flow('t-fail')
  const m = memory(g)
  const test = await saved(m, g, 'Task')
  await setMustHold(m.host, test.id, '  Mentions Bravo  ')
  expect(testsOf(m, g)[0]!.mustHold).toBe('Mentions Bravo')
  m.grader.replies = ['{"pass": false, "reason": "Too short."}']
  await runTest(m.host, test.id)
  await until(() => batchToasts(m).length > 0)
  expect(testsOf(m, g)[0]!.last).toMatchObject({ verdict: 'fail', reason: 'Too short.' })
  expect(m.grader.calls[0]!.prompt).toContain('Mentions Bravo')
  expect(batchToasts(m)).toEqual(['Tests: 0 passed, 1 failed'])
})

test('a refused or unreadable grading is ungraded with the reason', async () => {
  const g = flow('t-ungraded')
  const m = memory(g)
  const test = await saved(m, g, 'Task')
  const attempt = async (reply: Reply) => {
    m.grader.replies = [reply]
    m.grader.calls.length = 0
    const toasts = batchToasts(m).length
    await runTest(m.host, test.id)
    await until(() => batchToasts(m).length > toasts)
    return testsOf(m, g)[0]!.last!
  }
  const refused = await attempt({ refused: 'rate_limit' })
  expect(refused.verdict).toBe('ungraded')
  expect(refused.reason).toMatch(/^Couldn't grade: .*rate_limit/)
  const thrown = await attempt(new Error('blocked model'))
  expect(thrown).toMatchObject({ verdict: 'ungraded', reason: "Couldn't grade: blocked model" })
  const garbled = await attempt('I think it is fine.')
  expect(garbled.verdict).toBe('ungraded')
  expect(garbled.reason).toMatch(/^Couldn't grade: /)
  // The run itself is kept whatever the grading did.
  expect(garbled.runId).toBe(indexOf(m, g.id).runs[0]!.id)
  expect(garbled.result).toContain('BRAVO-OUT')
  expect(batchToasts(m)).toEqual(['Tests: 0 passed, 0 failed, 1 couldn\'t be graded', 'Tests: 0 passed, 0 failed, 1 couldn\'t be graded', 'Tests: 0 passed, 0 failed, 1 couldn\'t be graded'])
})

test('Run all tests runs them one after another and toasts the counts', async () => {
  const g = flow('t-all')
  const m = memory(g)
  await saved(m, g, 'First task')
  await saved(m, g, 'Second task')
  await saved(m, g, 'Third task')
  m.spawns.length = 0
  m.grader.replies = ['{"pass": true, "reason": "ok"}', '{"pass": false, "reason": "no"}', 'garbage']
  await runAllTests(m.host)
  // A second press while it goes is refused.
  await runAllTests(m.host)
  await until(() => batchToasts(m).length > 0)
  expect(m.spawns).toEqual(['Alpha', 'Bravo', 'Alpha', 'Bravo', 'Alpha', 'Bravo'])
  expect(verdicts(m, g)).toEqual(['pass', 'fail', 'ungraded'])
  const modes = indexOf(m, g.id).runs.map(r => `${r.mode}:${r.taskLine}`)
  expect(modes.slice(0, 3)).toEqual(['test:Third task', 'test:Second task', 'test:First task'])
  expect(batchToasts(m)).toEqual(["Tests: 1 passed, 1 failed, 1 couldn't be graded"])
  expect(m.grader.calls).toHaveLength(3)
})

test('Stop during Run all ends the batch: the stopped test keeps its last, later tests stay unrun', async () => {
  const g = flow('t-stop')
  const m = memory(g)
  await saved(m, g, 'First task')
  await saved(m, g, 'Second task')
  await saved(m, g, 'Third task')
  // The second test already has a result from before; its run is held and stopped.
  const previous = { verdict: 'fail' as const, reason: 'Old.', runId: 'r_old', at: 1, result: 'OLD' }
  const tests = testsOf(m, g).map(t => (t.task === 'Second task' ? { ...t, last: previous } : t))
  m.fs.set(testsFile(g), JSON.stringify(tests))
  await loadTests(m.host, g.id)
  m.spawns.length = 0
  m.grader.onGrade = () => void m.held.push('Alpha')
  await runAllTests(m.host)
  await until(() => m.spawns.filter(n => n === 'Alpha').length >= 2)
  stopRun()
  await until(() => batchToasts(m).length > 0)
  expect(testsOf(m, g).map(t => t.last?.verdict)).toEqual(['pass', 'fail', undefined])
  expect(testsOf(m, g)[1]!.last).toEqual(previous)
  expect(m.spawns.filter(n => n === 'Alpha')).toHaveLength(2)
  expect(batchToasts(m)).toEqual(['Tests: 1 passed, 0 failed'])
  expect(m.toasts).toContain('Agent graph "Flow" was stopped')
  expect(m.grader.calls).toHaveLength(1)
  // The stopped run is recorded as a test run that ended stopped.
  expect(indexOf(m, g.id).runs[0]).toMatchObject({ mode: 'test', ending: 'stopped' })
})

test("a test run that reaches the run cap keeps the test's earlier result, and the batch stops with the cap toast", async () => {
  const g = flow('t-cap')
  const m = memory(g)
  await saved(m, g, 'First task')
  await saved(m, g, 'Second task')
  const previous = { verdict: 'fail' as const, reason: 'Old.', runId: 'r_old', at: 1, result: 'OLD' }
  m.fs.set(testsFile(g), JSON.stringify(testsOf(m, g).map(t => ({ ...t, last: previous }))))
  await loadTests(m.host, g.id)
  // The graph gets a cap, and Alpha costs more than it (held, so the cap has to stop it).
  m.kv.set(`graph:${g.id}`, { ...g, runCapUsd: 1 })
  m.costs.set('Alpha', 1.2)
  m.held.push('Alpha')
  m.spawns.length = 0
  m.toasts.length = 0
  await runAllTests(m.host)
  await until(() => m.toasts.some(t => t.startsWith('Tests stopped')))
  expect(m.toasts.filter(t => t.startsWith('Tests')))
    .toEqual(['Tests stopped: "First task" reached the $1.00 run cap.'])
  expect(m.toasts).toContain('Agent graph "Flow" was stopped at its $1.00 cap')
  // The test keeps its earlier verdict; the second test never ran; nothing was graded.
  expect(testsOf(m, g).map(t => t.last)).toEqual([previous, previous])
  expect(m.spawns).toEqual(['Alpha'])
  expect(m.grader.calls).toHaveLength(0)
  const [summary] = indexOf(m, g.id).runs
  expect(summary).toMatchObject({ mode: 'test', ending: 'over-cap' })
  expect(recordOf(m, g.id, summary!.id).nodes['a']).toMatchObject({ status: 'cancelled', error: 'Stopped: the run reached its $1.00 cap.' })
  // The batch is over: a run can start again.
  expect(isTesting()).toBe(false)
})

test('Accept latest makes the last result the accepted one and a pass', async () => {
  const g = flow('t-accept')
  const m = memory(g)
  const test = await saved(m, g, 'Task')
  m.fs.set(testsFile(g), JSON.stringify([{ ...test, expected: 'OLD', last: { verdict: 'fail', reason: 'Different.', runId: 'r9', at: 4, result: 'NEW RESULT' } }]))
  await loadTests(m.host, g.id)
  await acceptLatest(m.host, test.id)
  expect(testsOf(m, g)[0]).toMatchObject({ expected: 'NEW RESULT', last: { verdict: 'pass', reason: 'Accepted by you.', runId: 'r9', result: 'NEW RESULT' } })
  // Nothing to accept without a last result.
  const fresh = await saved(m, g, 'Other task')
  await acceptLatest(m.host, fresh.id)
  expect(testsOf(m, g).find(t => t.id === fresh.id)).toEqual(fresh)
})

test('Compare writes the accepted and latest results to a file and opens it', async () => {
  const g = flow('t-compare')
  const m = memory(g)
  const test = await saved(m, g, 'Write a haiku\nabout autumn')
  m.fs.set(testsFile(g), JSON.stringify([{ ...test, expected: 'ACCEPTED TEXT', last: { verdict: 'fail', reason: 'Lost the point.', runId: 'r9', at: new Date(2026, 9, 8, 14, 5).getTime(), result: 'LATEST TEXT' } }]))
  await loadTests(m.host, g.id)
  await compareTest(m.host, test.id)
  const path = `./.claude/agent-graph/${g.id}/tests/${test.id}-compare.md`
  const text = m.fs.get(path)!
  expect(text).toContain('# Write a haiku')
  expect(text).toContain('Write a haiku\nabout autumn')
  expect(text).toMatch(/## Accepted\n+ACCEPTED TEXT/)
  expect(text).toMatch(/## Latest · fail · Lost the point\. · 14:05\n+LATEST TEXT/)
  expect(m.opened).toHaveLength(1)
  expect(m.opened[0]!.replace(/\\/g, '/')).toContain(`/${g.id}/tests/${test.id}-compare.md`)
  // Without a last result there is nothing to compare.
  const fresh = await saved(m, g, 'Other task')
  await compareTest(m.host, fresh.id)
  expect(m.opened).toHaveLength(1)
})

test('deleting a test takes two presses; the must-hold editor opens for one test at a time', async () => {
  const g = flow('t-delete')
  const m = memory(g)
  const one = await saved(m, g, 'First task')
  const two = await saved(m, g, 'Second task')
  await deleteTest(m.host, one.id)
  expect(m.slots.ui.armedTest).toBe(one.id)
  expect(testsOf(m, g)).toHaveLength(2)
  // Another test's delete re-arms instead of deleting.
  await deleteTest(m.host, two.id)
  expect(m.slots.ui.armedTest).toBe(two.id)
  expect(testsOf(m, g)).toHaveLength(2)
  await deleteTest(m.host, two.id)
  expect(m.slots.ui.armedTest).toBeNull()
  expect(testsOf(m, g).map(t => t.id)).toEqual([one.id])
  expect(cachedTests(g.id)!.map(t => t.id)).toEqual([one.id])

  await editMustHold(m.host, one.id)
  expect(m.slots.ui.editingTest).toBe(one.id)
  await setMustHold(m.host, one.id, 'Keep it short')
  expect(m.slots.ui.editingTest).toBeNull()
  expect(testsOf(m, g)[0]!.mustHold).toBe('Keep it short')
  await editMustHold(m.host, one.id)
  await editMustHold(m.host, null)
  expect(m.slots.ui.editingTest).toBeNull()
})

test('opening a graph reads its tests; deleting the graph removes the file and the cache', async () => {
  const g = flow('t-graph')
  const m = memory(g)
  await saved(m, g, 'Task')
  m.fs.set(testsFile(g), JSON.stringify(testsOf(m, g).map(t => ({ ...t, name: 'Edited outside' }))))
  await openGraph(m.host, g.id)
  expect(cachedTests(g.id)![0]!.name).toBe('Edited outside')
  await deleteGraph(m.host)
  expect(m.fs.has(testsFile(g))).toBe(false)
  expect(cachedTests(g.id)).toBeUndefined()
})

test('Run one test is refused while a run is going', async () => {
  const g = flow('t-busy')
  const m = memory(g)
  const test = await saved(m, g, 'Task')
  m.held.push('Alpha')
  expect(await startRun(m.host, g, 'Other', 'pane')).toBeUndefined()
  await until(() => m.spawns.length > 2)
  await runTest(m.host, test.id)
  expect(m.slots.ui.notice).toMatch(/run is still going|Stop the run/)
  expect(m.grader.calls).toHaveLength(0)
  stopRun()
  await until(() => m.toasts.includes('Agent graph "Flow" was stopped'))
  expect(batchToasts(m)).toEqual([])
})

test('deleting the graph during a test run ends the batch: no grading, no tests file, no result toast', async () => {
  const g = flow('t-del-run')
  const m = memory(g)
  await saved(m, g, 'Task')
  m.held.push('Alpha')
  m.spawns.length = 0
  await runAllTests(m.host)
  await until(() => m.spawns.length > 0)
  await deleteGraph(m.host)
  await until(() => !m.slots.run?.isRunning)
  // The batch is over: only now do the negatives below mean something.
  await until(() => !isTesting())
  expect(m.grader.calls).toHaveLength(0)
  expect(m.fs.has(testsFile(g))).toBe(false)
  expect(batchToasts(m)).toEqual([])
  expect(cachedTests(g.id)).toBeUndefined()
})

test('deleting the graph while a test is being graded saves and toasts nothing', async () => {
  const g = flow('t-del-grade')
  const m = memory(g)
  await saved(m, g, 'Task')
  let release = () => {}
  m.grader.gate = new Promise<void>(resolve => void (release = resolve))
  await runAllTests(m.host)
  await until(() => m.grader.calls.length > 0)
  await deleteGraph(m.host)
  release()
  await until(() => !isTesting())
  expect(m.fs.has(testsFile(g))).toBe(false)
  expect(batchToasts(m)).toEqual([])
  // Nothing to keep a result for, so nothing to say about one.
  expect(m.toasts.some(t => t.startsWith('Stopped while grading'))).toBe(false)
  expect(cachedTests(g.id)).toBeUndefined()
  // The batch is over: nothing holds the run lock.
  expect(await runAllTests(m.host)).toBeUndefined()
  expect(m.slots.ui.notice).toBeNull()
})

test('while a batch goes, even between two tests, a run that is not a test is refused', async () => {
  const g = flow('t-refuse')
  const m = memory(g)
  await saved(m, g, 'Task')
  expect(isTesting()).toBe(false)
  let release = () => {}
  m.grader.gate = new Promise<void>(resolve => void (release = resolve))
  await runAllTests(m.host)
  expect(isTesting()).toBe(true)
  await until(() => m.grader.calls.length > 0)
  // The test's run is over and being graded: nothing runs, but the batch still holds the lock.
  expect(isTesting()).toBe(true)
  expect(await startRun(m.host, g, 'Other', 'pane')).toBe('Tests are running; stop them first.')
  expect(await startRun(m.host, g, 'Other', 'tool')).toBe('Tests are running; stop them first.')
  release()
  await until(() => batchToasts(m).length > 0)
  await until(() => !isTesting())
  expect(await startRun(m.host, g, 'Other', 'pane')).toBeUndefined()
  await until(() => m.toasts.filter(t => /finished/.test(t)).length >= 2)
})

test('Stop releases a run whose start never fires', async () => {
  const g = flow('t-nostart')
  const m = memory(g)
  const after = m.host.clock.after
  // The engine takes the timer and never calls it back.
  const dropped: (() => void)[] = []
  m.host.clock.after = ((_ms: number, run: () => void) => void dropped.push(run)) as never
  expect(await startRun(m.host, g, 'Task', 'pane')).toBeUndefined()
  expect(isBusy()).toBe(true)
  expect(await startRun(m.host, g, 'Other', 'pane')).toBe('Another agent graph run is still going; stop it first.')
  stopRun()
  expect(isBusy()).toBe(false)
  // A start that comes late finds the run released and starts nothing.
  for (const run of dropped) run()
  for (let i = 0; i < 10; i++) await tick()
  expect(m.spawns).toEqual([])
  expect(m.slots.run).toBeNull()
  m.host.clock.after = after
  expect(await startRun(m.host, g, 'Again', 'pane')).toBeUndefined()
  await until(() => m.toasts.some(t => /finished/.test(t)))
  expect(m.spawns).toEqual(['Alpha', 'Bravo'])
})

test('Stop ends a batch whose start never fires', async () => {
  const g = flow('t-nostart-batch')
  const m = memory(g)
  await saved(m, g, 'Task')
  const after = m.host.clock.after
  m.host.clock.after = (() => undefined) as never
  await runAllTests(m.host)
  expect(isTesting()).toBe(true)
  stopRun()
  expect(isTesting()).toBe(false)
  m.host.clock.after = after
  expect(await runAllTests(m.host)).toBeUndefined()
  expect(m.slots.ui.notice).toBeNull()
  await until(() => batchToasts(m).length > 0)
  expect(m.grader.calls).toHaveLength(1)
})

test('Stop ends a batch whose test run never starts', async () => {
  const g = flow('t-nostart-run')
  const m = memory(g)
  await saved(m, g, 'Task')
  const after = m.host.clock.after
  // The batch itself starts; the run of its first test does not.
  let calls = 0
  m.host.clock.after = ((ms: number, run: () => void) => {
    if (++calls === 1) after(ms, run)
  }) as never
  await runAllTests(m.host)
  await until(() => calls >= 2)
  expect(isTesting()).toBe(true)
  stopRun()
  await until(() => !isTesting())
  expect(isBusy()).toBe(false)
  expect(m.grader.calls).toHaveLength(0)
  expect(batchToasts(m)).toEqual([])
  m.host.clock.after = after
  expect(await runAllTests(m.host)).toBeUndefined()
  await until(() => batchToasts(m).length > 0)
})

test('Stop while a test is graded says so, and the test keeps its earlier result', async () => {
  const g = flow('t-stop-grading')
  const m = memory(g)
  const test = await saved(m, g, 'Write a haiku')
  const previous = { verdict: 'fail' as const, reason: 'Old.', runId: 'r_old', at: 1, result: 'OLD' }
  m.fs.set(testsFile(g), JSON.stringify([{ ...test, last: previous }]))
  await loadTests(m.host, g.id)
  let release = () => {}
  m.grader.gate = new Promise<void>(resolve => void (release = resolve))
  await runTest(m.host, test.id)
  await until(() => m.grader.calls.length > 0)
  stopRun()
  release()
  await until(() => !isTesting())
  expect(m.toasts).toContain('Stopped while grading "Write a haiku"; it keeps its earlier result.')
  expect(testsOf(m, g)[0]!.last).toEqual(previous)
  expect(batchToasts(m)).toEqual([])
})

test('deleting a graph while its test is graded says nothing about that test', async () => {
  const g = flow('t-delete-grading')
  const m = memory(g)
  const test = await saved(m, g, 'Write a haiku')
  let release = () => {}
  m.grader.gate = new Promise<void>(resolve => void (release = resolve))
  await runTest(m.host, test.id)
  await until(() => m.grader.calls.length > 0)
  // The delete is held while it removes files, so the grade lands in the middle of it.
  let removals = 0
  let open = () => {}
  const held = new Promise<void>(resolve => void (open = resolve))
  const run = m.host.process.run
  m.host.process.run = (async (argv: string[], options?: unknown) => {
    if (argv[0] === 'rm') {
      removals++
      await held
    }
    return run(argv, options as never)
  }) as Host['process']['run']
  const deleting = deleteGraph(m.host)
  await until(() => removals > 0)
  release()
  await until(() => !isTesting())
  open()
  await deleting
  expect(m.toasts.filter(t => /keeps its earlier result/.test(t))).toEqual([])
  expect(batchToasts(m)).toEqual([])
})

test('deleting a test removes its compare file and no other', async () => {
  const g = flow('t-delete-compare')
  const m = memory(g)
  const one = await saved(m, g, 'First task')
  const two = await saved(m, g, 'Second task')
  const last = { verdict: 'fail' as const, reason: 'Different.', runId: 'r9', at: 4, result: 'NEW' }
  m.fs.set(testsFile(g), JSON.stringify([{ ...one, last }, { ...two, last }]))
  await loadTests(m.host, g.id)
  await compareTest(m.host, one.id)
  await compareTest(m.host, two.id)
  const compareFile = (id: string) => `./.claude/agent-graph/${g.id}/tests/${id}-compare.md`
  expect([m.fs.has(compareFile(one.id)), m.fs.has(compareFile(two.id))]).toEqual([true, true])
  await deleteTest(m.host, one.id)
  await deleteTest(m.host, one.id)
  expect(testsOf(m, g).map(t => t.id)).toEqual([two.id])
  expect([m.fs.has(compareFile(one.id)), m.fs.has(compareFile(two.id))]).toEqual([false, true])
})

test('a pane that cannot redraw does not turn a saved test into a failed save', async () => {
  const g = flow('t-redraw')
  const m = memory(g)
  await runTo(m, g, 'Task')
  const update = m.host.update
  m.host.update = (async (slot: string, change: (value: unknown) => unknown) => {
    if (slot === 'ui') throw new Error('the pane is gone')
    return update(slot as 'run', change as never)
  }) as unknown as Host['update']
  await saveAsTest(m.host)
  expect(m.toasts.some(t => t.startsWith('Could not save the tests'))).toBe(false)
  expect(m.toasts).toContain('Saved test "Task".')
  expect(testsOf(m, g)).toHaveLength(1)
  expect(cachedTests(g.id)).toEqual(testsOf(m, g))
})
