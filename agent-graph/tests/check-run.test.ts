import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph, NodeRunView } from '../types'
import { createTracker, type Tracker } from '../hooks/activity'
import { createGuard } from '../hooks/guard'
import { createCompletions, createLocalBackend, type CommandChunk, type CommandDeps, type CommandEnd, type LocalDeps } from '../hooks/local'
import { connect } from '../hooks/model'
import { runGraph, type Handoff } from '../hooks/runner'

const agent = (id: string, name: string): AgentNode => ({
  id, name, x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
const checkNode = (command: string, timeoutMin = 10): AgentNode => ({
  ...agent('k', 'Check 1'), instructionsFile: '', check: { command, timeoutMin },
})
const graph = (nodes: AgentNode[]): Graph => ({ id: 'g', name: 'Flow', description: '', backend: 'local', nodes, edges: [] })

// A scripted child: its pieces in order, then (unless it hangs) how it ended. Like a native async generator, a
// return() waits for the pull still pending: a hanging child dies only when `exit()` makes it write or exit.
type Step = CommandChunk | Error
function child(steps: Step[], end: CommandEnd | 'hang') {
  const state = { returnCalled: false, killed: false, pulls: 0, exit: () => {} }
  let pending: Promise<unknown> | undefined
  const stream = {
    next(): Promise<IteratorResult<CommandChunk, CommandEnd>> {
      const pull = (async (): Promise<IteratorResult<CommandChunk, CommandEnd>> => {
        const step = steps[state.pulls++]
        if (step instanceof Error) throw step
        if (step !== undefined) return { done: false, value: step }
        if (end === 'hang') {
          await new Promise<void>(resolve => (state.exit = resolve))
          return { done: true, value: { code: null, signal: 'SIGTERM' } }
        }
        return { done: true, value: end }
      })()
      pending = pull
      const clear = () => void (pending === pull && (pending = undefined))
      pull.then(clear, clear)
      return pull
    },
    async return(): Promise<IteratorResult<CommandChunk, CommandEnd>> {
      state.returnCalled = true
      await (pending ?? Promise.resolve()).catch(() => undefined)
      state.killed = true
      return { done: true, value: { code: null, signal: 'SIGTERM' } }
    },
    async throw(): Promise<IteratorResult<CommandChunk, CommandEnd>> {
      throw new Error('not used')
    },
    [Symbol.asyncIterator]() {
      return stream
    },
  }
  return { stream: stream as unknown as AsyncGenerator<CommandChunk, CommandEnd>, state }
}

const out = (text: string): CommandChunk => ({ stream: 'stdout', text })
const err = (text: string): CommandChunk => ({ stream: 'stderr', text })

function setup(steps: Step[], end: CommandEnd | 'hang', over: { isWindows?: boolean; tracker?: Tracker } = {}) {
  const c = child(steps, end)
  const argvs: string[][] = []
  const envs: (Record<string, string> | undefined)[] = []
  const waits: { ms: number; fire: () => void }[] = []
  const command: CommandDeps = {
    spawn: (argv, env) => (argvs.push(argv), envs.push(env), c.stream),
    isWindows: async () => over.isWindows === true,
    wait: ms => new Promise<void>(resolve => waits.push({ ms, fire: resolve })),
  }
  const deps: LocalDeps = {
    register: async () => undefined,
    spawn: async () => ({ agentId: 'never' }),
    stopAgent: async () => undefined,
    instructions: async () => '',
    context: { kind: async () => 'missing', read: async () => '', files: async () => [] },
    completions: createCompletions(),
    guard: createGuard(),
    command,
    ...(over.tracker !== undefined ? { tracker: () => over.tracker } : {}),
  }
  return { deps, argvs, envs, waits, child: c.state }
}

const upstream = (from: string, text: string, files: Handoff['files'] = []): Handoff => ({ from, text, files })

test('a check that exits 0 passes with the handoffs, a blank line and its output, and hands the files on', async () => {
  const g = graph([agent('a', 'Writer'), agent('b', 'Tester'), checkNode('npm test')])
  const file = (id: string, name: string, fromNode: string) => ({ id, name, fromNode })
  const costs: number[] = []
  const { deps, argvs } = setup([out('ok 1\n'), err('warn\n')], { code: 0, signal: null })
  const run = await createLocalBackend(g, deps).start(
    g.nodes[2]!, 'ignored', [upstream('a', 'Draft.', [file('f1', 'x.md', 'a')]), upstream('b', 'Notes.', [file('f2', 'y.md', 'b')])], usd => costs.push(usd),
  )
  const outcome = await run.done
  expect(argvs).toEqual([['sh', '-c', 'npm test']])
  expect(outcome).toEqual({
    ok: true,
    text: [
      '## Handoff from Writer\n\nDraft.\n\nFiles from Writer are at /workspace/handoff/writer-a/: x.md',
      '## Handoff from Tester\n\nNotes.\n\nFiles from Tester are at /workspace/handoff/tester-b/: y.md',
      '## Check 1 passed\n\n`npm test` exited 0.\n\n```\nok 1\nwarn\n```',
    ].join('\n\n'),
    files: [file('f1', 'x.md', 'a'), file('f2', 'y.md', 'b')],
  })
  expect(costs).toEqual([])
})

test('a passing check with no output and no handoffs says only that it passed', async () => {
  const g = graph([checkNode('true')])
  const { deps } = setup([], { code: 0, signal: null })
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  expect(await run.done).toEqual({ ok: true, text: '## Check 1 passed\n\n`true` exited 0.', files: [] })
})

test('a pass shows the last 2000 characters of a long output', async () => {
  const g = graph([checkNode('build')])
  const { deps } = setup([out('a'.repeat(70_000)), out('END')], { code: 0, signal: null })
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  const outcome = await run.done
  expect(outcome.ok && outcome.text).toBe(`## Check 1 passed\n\n\`build\` exited 0.\n\n\`\`\`\n${'a'.repeat(1997)}END\n\`\`\``)
})

test('on Windows the command goes through cmd in an environment variable, so its quotes stay', async () => {
  const command = 'node -e "console.log(1+1)"'
  const g = graph([checkNode(command)])
  const { deps, argvs, envs } = setup([], { code: 0, signal: null }, { isWindows: true })
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  await run.done
  expect(argvs).toEqual([['cmd', '/d', '/s', '/c', '%AGENT_GRAPH_CHECK%']])
  expect(envs).toEqual([{ AGENT_GRAPH_CHECK: command }])
})

test('elsewhere the command goes to sh as it is, with no environment', async () => {
  const g = graph([checkNode('echo "a b"')])
  const { deps, argvs, envs } = setup([], { code: 0, signal: null })
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  await run.done
  expect(argvs).toEqual([['sh', '-c', 'echo "a b"']])
  expect(envs).toEqual([undefined])
})

test('a non-zero exit fails with the code, and the detail is the last 4000 characters of the output', async () => {
  const g = graph([checkNode('npm test')])
  const { deps } = setup([out('x'.repeat(5000)), err('FAILED\n')], { code: 2, signal: null })
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  const outcome = await run.done
  expect(outcome).toEqual({ ok: false, reason: '`npm test` exited 2.', detail: `${'x'.repeat(3993)}FAILED\n` })
})

test('a failing check with no output has an empty detail', async () => {
  const g = graph([checkNode('false')])
  const { deps } = setup([], { code: 1, signal: null })
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  expect(await run.done).toEqual({ ok: false, reason: '`false` exited 1.', detail: '' })
})

test('a child ended by a signal fails with the signal name', async () => {
  const g = graph([checkNode('sleep 9')])
  const { deps } = setup([], { code: null, signal: 'SIGTERM' })
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  expect(await run.done).toMatchObject({ ok: false, reason: '`sleep 9` exited SIGTERM.' })
})

test('only the last 64 000 characters are kept while collecting', async () => {
  const g = graph([checkNode('noisy')])
  const chunks: Step[] = Array.from({ length: 30 }, (_, i) => out(`${i % 10}`.repeat(10_000)))
  const { deps } = setup(chunks, { code: 1, signal: null })
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  const outcome = await run.done
  expect(!outcome.ok && outcome.detail).toBe('9'.repeat(4000))
})

test('a check that runs past its timeout fails at once and its child is asked to leave', async () => {
  const g = graph([checkNode('sleep 999', 3)])
  const { deps, waits, child: c } = setup([out('working\n')], 'hang')
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(waits.map(w => w.ms)).toEqual([180_000])
  waits[0]!.fire()
  expect(await run.done).toEqual({ ok: false, reason: 'Timed out after 3 min.', detail: 'working\n' })
  // The outcome does not wait for the silent child: its return is asked for, and takes effect once it writes or exits.
  expect(c.returnCalled).toBe(true)
  expect(c.killed).toBe(false)
  c.exit()
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(c.killed).toBe(true)
})

test('stop leaves the stream at once and ends the check as stopped, however silent the child', async () => {
  const g = graph([checkNode('sleep 999')])
  const { deps, child: c } = setup([], 'hang')
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await run.stop()
  expect(await run.done).toMatchObject({ ok: false, reason: 'Stopped.' })
  expect(c.returnCalled).toBe(true)
  expect(c.killed).toBe(false)
  c.exit()
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(c.killed).toBe(true)
})

test('a stopped run marks the check card cancelled', async () => {
  const g = graph([checkNode('sleep 999')])
  const { deps } = setup([], 'hang')
  const controller = new AbortController()
  const views: NodeRunView[] = []
  const finished = runGraph(g, 'task', createLocalBackend(g, deps), { onUpdate: v => void views.push(v.nodes['k']!), signal: controller.signal })
  for (let i = 0; i < 50; i++) await Promise.resolve()
  controller.abort()
  await finished
  expect(views[views.length - 1]).toMatchObject({ status: 'cancelled', error: 'Stopped.' })
})

test('a command that cannot start fails with the reason', async () => {
  const g = graph([checkNode('nope')])
  const { deps } = setup([new Error('spawn sh ENOENT')], { code: 0, signal: null })
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  expect(await run.done).toEqual({ ok: false, reason: 'could not start: spawn sh ENOENT', detail: '' })
})

test('a check records one Check item in the activity and has no cost in the view', async () => {
  const g = connect(graph([agent('a', 'Writer'), checkNode('npm test\nsecond line')]), 'a', 'k', 'handoff')
  const tracker = createTracker(() => {}, () => 5)
  const { deps } = setup([out('3 passed\n')], { code: 0, signal: null }, { tracker })
  const seed = { a: { output: 'Draft.', files: [], runId: 'r', at: 1 } }
  const views: NodeRunView[] = []
  const result = await runGraph(g, 'task', createLocalBackend(g, deps), { onUpdate: v => void views.push(v.nodes['k']!), activity: tracker }, seed)
  expect('result' in result).toBe(true)
  const items = tracker.itemsOf('k')
  expect(items).toMatchObject([{ tool: 'Check', summary: 'npm test', status: 'ok', result: '3 passed\n' }])
  const last = views[views.length - 1]!
  expect(last.status).toBe('done')
  expect(last.costUsd).toBeUndefined()
  expect(last.activity).toMatchObject([{ tool: 'Check', status: 'ok' }])
})

test('a failed check shows as a failed activity item with the reason', async () => {
  const g = graph([checkNode('npm test')])
  const tracker = createTracker(() => {}, () => 5)
  const { deps } = setup([err('boom\n')], { code: 1, signal: null }, { tracker })
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  await run.done
  expect(tracker.itemsOf('k')).toMatchObject([{ tool: 'Check', status: 'failed', result: 'boom\n', error: '`npm test` exited 1.' }])
})

test('a tracker that throws never fails the check', async () => {
  const g = graph([checkNode('ok')])
  const broken = new Proxy({}, { get: () => () => { throw new Error('tracker down') } }) as unknown as Tracker
  const { deps } = setup([out('fine\n')], { code: 0, signal: null }, { tracker: broken })
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  expect(await run.done).toMatchObject({ ok: true })
})

test('files that arrive twice are handed on once', async () => {
  const g = graph([agent('a', 'Writer'), agent('b', 'Tester'), checkNode('true')])
  const f = { id: 'f1', name: 'x.md', fromNode: 'a' }
  const { deps } = setup([], { code: 0, signal: null })
  const inputs = [upstream('a', 'A', [f]), upstream('b', 'B', [f, { id: 'f2', name: 'y.md', fromNode: 'b' }])]
  const run = await createLocalBackend(g, deps).start(g.nodes[2]!, 'go', inputs, () => {})
  const outcome = await run.done
  expect(outcome.ok && outcome.files.map(x => x.id)).toEqual(['f1', 'f2'])
})

test('a timer that fires after the check has ended changes nothing', async () => {
  const g = graph([checkNode('true')])
  const { deps, waits } = setup([out('hi')], { code: 0, signal: null })
  const run = await createLocalBackend(g, deps).start(g.nodes[0]!, 'go', [], () => {})
  expect(await run.done).toMatchObject({ ok: true })
  waits[0]!.fire()
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(await run.done).toMatchObject({ ok: true })
})

test('a failed check fails its card in a run and skips what follows', async () => {
  const g = connect(graph([agent('a', 'Writer'), checkNode('npm test'), agent('c', 'After')]), 'k', 'c', 'handoff')
  const gg = connect(g, 'a', 'k', 'handoff')
  const { deps } = setup([out('bad\n')], { code: 3, signal: null })
  const seed = { a: { output: 'Draft.', files: [], runId: 'r', at: 1 } }
  const views: Record<string, NodeRunView> = {}
  const result = await runGraph(gg, 'task', createLocalBackend(gg, deps), { onUpdate: v => void Object.assign(views, v.nodes) }, seed)
  expect('failures' in result && result.failures).toEqual({ k: '`npm test` exited 3.' })
  expect(views['k']).toMatchObject({ status: 'failed', error: '`npm test` exited 3.' })
  expect(views['c']!.status).toBe('skipped')
})
