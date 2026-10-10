import { expect } from 'claude-code/testing'
import { test } from './kit'

import {
  completions, confirmEdge, deleteGraph, deleteNode, editLastInput, isBusy, latestRun, loadLastRun, openGraph, openRun, runFromNode, runWithInput, saveOutputs, saveTranscript, settings, startRun, stopRun,
  stashed, toggleAllRuns, toggleLastRunMore, togglePane, useRunTask, type Host,
} from '../hooks/actions'
import { EMPTY_UI, type Slots } from '../hooks/state'
import type { AgentNode, Graph, RunIndex, RunRecord } from '../types'

declare const setTimeout: (run: () => void, ms?: number) => unknown

// The actions over a host made of plain maps: state, store and files in memory, and a local
// agent that answers at once (or is held until it is stopped).
const node = (id: string, name: string, x: number): AgentNode => ({
  id, name, x, y: 1, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
const flow = (id: string): Graph => ({
  id, name: 'Flow', description: '', backend: 'local', layout: 2,
  nodes: [node('a', 'Alpha', 2), node('b', 'Bravo', 40)],
  edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }],
})

function memory(g: Graph, held: string[] = [], failing: string[] = []) {
  const kv = new Map<string, unknown>([[`graph:${g.id}`, g]])
  const fs = new Map<string, string>(g.nodes.map(n => [n.instructionsFile, `Instructions of ${n.name}.`] as const))
  const slots: Slots = { index: [], graph: g, ui: { ...EMPTY_UI, graphId: g.id }, run: null }
  const toasts: string[] = []
  let spawned = 0
  // Writes of the run view that fail, and what happens when an agent is started.
  const gate: { register?: Promise<void>; registered: number } = { registered: 0 }
  const fail = { updates: 0, isFinalPublishLost: false, onSpawn: () => {} }
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
        const target = argv[argv.length - 1]!
        fs.delete(target)
        // A folder (rm -rf) takes everything in it along.
        if (argv.includes('-rf')) for (const path of [...fs.keys()]) if (path.startsWith(`${target}/`)) fs.delete(path)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    tool: {
      register: async () => undefined,
      // TaskStop: the stopped agent's turn ends.
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
      register: async () => {
        gate.registered++
        await gate.register
      },
      spawn: async (args: { description: string }) => {
        const name = args.description.split(' ')[0]!
        const agentId = `ag${++spawned}`
        fail.onSpawn()
        if (failing.includes(name)) void Promise.resolve().then(() => completions.complete({ agentId, answer: '', reason: 'error' }))
        else if (!held.includes(name)) void Promise.resolve().then(() => completions.complete({ agentId, answer: `${name.toUpperCase()}-OUT`, reason: 'answer' }))
        return { model: 'm', agentId }
      },
    },
    prompt: { submit: async () => undefined, fill: async () => undefined },
    read: async (slot: keyof Slots) => slots[slot],
    update: async (slot: keyof Slots, change: (value: unknown) => unknown) => {
      if (slot === 'run' && fail.updates > 0) {
        fail.updates--
        throw new Error('the pane is gone')
      }
      const next = change(slots[slot]) as { isRunning?: boolean; result?: string } | null
      // The runner's last publish (the run over, the result in), lost once.
      if (slot === 'run' && fail.isFinalPublishLost && next?.isRunning === false && next.result !== undefined) {
        fail.isFinalPublishLost = false
        throw new Error('the pane is gone')
      }
      return ((slots as Record<string, unknown>)[slot] = next)
    },
  } as unknown as Host
  return { host, slots, kv, fs, toasts, fail, gate, spawnedCount: () => spawned }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 2))
async function until(done: () => boolean) {
  for (let i = 0; i < 500 && !done(); i++) await tick()
  expect(done()).toBe(true)
}

type Memory = ReturnType<typeof memory>
const indexOf = (m: Memory, id: string) => m.kv.get(`runs:${id}`) as RunIndex
const recordFile = (m: Memory, graphId: string, runId: string) => `./.claude/agent-graph/${graphId}/runs/${runId}.json`
const recordOf = (m: Memory, graphId: string, runId: string) => JSON.parse(m.fs.get(recordFile(m, graphId, runId))!) as RunRecord

async function runTo(m: Memory, g: Graph, task: string) {
  const ends = m.toasts.filter(t => /finished|was stopped/.test(t)).length
  expect(await startRun(m.host, g, task, 'pane')).toBeUndefined()
  await until(() => m.toasts.filter(t => /finished|was stopped/.test(t)).length > ends)
}

test('a finished run gives the run view its id; openRun shows a past run as historic; latestRun the newest', async () => {
  const g = flow('h-open')
  const m = memory(g)
  await runTo(m, g, 'First task')
  await runTo(m, g, 'Second task')
  const [second, first] = indexOf(m, g.id).runs
  expect(m.slots.run).toMatchObject({ runId: second!.id, isRunning: false })
  expect(m.slots.run?.isHistoric).toBeUndefined()

  await openRun(m.host, first!.id)
  expect(m.slots.run).toMatchObject({
    graphId: g.id, graphName: 'Flow', runId: first!.id, isHistoric: true, isRunning: false, task: 'First task',
    result: recordOf(m, g.id, first!.id).result,
    nodes: { a: { status: 'done', output: 'ALPHA-OUT' }, b: { status: 'done', output: 'BRAVO-OUT' } },
  })
  expect(m.slots.ui.notice).toBeNull()

  // The newest run is shown as the current one, not as a past one.
  await latestRun(m.host)
  expect(m.slots.run).toMatchObject({ runId: second!.id, isHistoric: false, task: 'Second task' })
})

test('a past run keeps which agents were reused', async () => {
  const g = flow('h-reused')
  const m = memory(g)
  await runTo(m, g, 'Task')
  const [full] = indexOf(m, g.id).runs
  // A from-here record, as the actions write it: Alpha reused, Bravo run.
  const saved = recordOf(m, g.id, full!.id)
  const reused: RunRecord = {
    ...saved, id: 'r_reused', mode: 'from-here', fromNode: 'b',
    nodes: { a: { ...saved.nodes['a']!, reusedFrom: { runId: full!.id, at: 5 } }, b: saved.nodes['b']! },
  }
  m.fs.set(recordFile(m, g.id, 'r_reused'), JSON.stringify(reused))
  await openRun(m.host, 'r_reused')
  expect(m.slots.run?.nodes['a']).toMatchObject({ status: 'done', reusedFrom: { runId: full!.id, at: 5 } })
  expect(m.slots.run?.nodes['b']?.reusedFrom).toBeUndefined()
})

test('a missing record shows a notice and is dropped from the index', async () => {
  const g = flow('h-missing')
  const m = memory(g)
  await runTo(m, g, 'First task')
  await runTo(m, g, 'Second task')
  const [second, first] = indexOf(m, g.id).runs
  m.fs.delete(recordFile(m, g.id, first!.id))
  await openRun(m.host, first!.id)
  expect(m.slots.ui.notice).toBe("That run's record is missing.")
  expect(indexOf(m, g.id).runs.map(r => r.id)).toEqual([second!.id])
  // The run on show is left as it was.
  expect(m.slots.run).toMatchObject({ runId: second!.id })
  m.fs.set(recordFile(m, g.id, second!.id), 'garbage')
  await openRun(m.host, second!.id)
  expect(m.slots.ui.notice).toBe("That run's record is missing.")
  expect(indexOf(m, g.id).runs).toEqual([])
})

test('latestRun with no saved runs clears the run view', async () => {
  const g = flow('h-none')
  const m = memory(g)
  m.slots.run = { graphId: g.id, graphName: 'Flow', isRunning: false, nodes: {}, result: 'old' }
  await latestRun(m.host)
  expect(m.slots.run).toBeNull()
})

test('useRunTask copies the task of the run on show into the task box', async () => {
  const g = flow('h-task')
  const m = memory(g)
  await runTo(m, g, 'Task of the run')
  m.slots.ui = { ...m.slots.ui, task: 'Typed since' }
  await useRunTask(m.host)
  expect(m.slots.ui.task).toBe('Task of the run')
  m.slots.run = null
  m.slots.ui = { ...m.slots.ui, task: 'Kept' }
  await useRunTask(m.host)
  expect(m.slots.ui.task).toBe('Kept')
})

test('the last-run and all-runs toggles flip their flags', async () => {
  const m = memory(flow('h-flags'))
  await toggleLastRunMore(m.host)
  await toggleAllRuns(m.host)
  expect(m.slots.ui).toMatchObject({ lastRunMore: true, allRuns: true })
  await toggleLastRunMore(m.host)
  expect(m.slots.ui).toMatchObject({ lastRunMore: false, allRuns: true })
})

test('openRun and latestRun are refused while a run is going', async () => {
  const g = flow('h-busy')
  const m = memory(g, ['Alpha'])
  m.slots.ui = { ...m.slots.ui, task: 'Do it' }
  expect(await startRun(m.host, g, 'Do it', 'pane')).toBeUndefined()
  await until(() => m.spawnedCount() > 0)
  await openRun(m.host, 'r_other')
  expect(m.slots.ui.notice).toBe('Stop the run before opening a past one.')
  await latestRun(m.host)
  expect(m.slots.run).toMatchObject({ isRunning: true })
  stopRun()
  await until(() => m.toasts.includes('Agent graph "Flow" was stopped'))
  const [stopped] = indexOf(m, g.id).runs
  expect(stopped).toMatchObject({ ending: 'stopped' })
  expect(m.slots.run).toMatchObject({ runId: stopped!.id, isRunning: false })
})

test('a pane that cannot take an update does not fail the run: the run is still recorded in full', async () => {
  const g = flow('h-throw')
  const m = memory(g)
  // Both agents finish, but the runner's last publish of the view is refused.
  m.fail.isFinalPublishLost = true
  expect(await startRun(m.host, g, 'Do it', 'pane')).toBeUndefined()
  await until(() => indexOf(m, g.id) !== undefined)
  const [finished] = indexOf(m, g.id).runs
  expect(finished).toMatchObject({ ending: 'finished', mode: 'full' })
  const record = recordOf(m, g.id, finished!.id)
  expect(record.nodes['a']).toMatchObject({ status: 'done', output: 'ALPHA-OUT' })
  expect(record.nodes['b']).toMatchObject({ status: 'done' })
  expect(record.result).not.toContain('failed')

  const early = flow('h-throw-early')
  const n = memory(early)
  n.fail.updates = 1
  expect(await startRun(n.host, early, 'Do it', 'pane')).toBeUndefined()
  await until(() => indexOf(n, early.id) !== undefined)
  expect(indexOf(n, early.id).runs[0]).toMatchObject({ ending: 'finished' })
})

test('a run whose last update is refused keeps the files of the agents it reused', async () => {
  const g = flow('h-throw-seed')
  const m = memory(g)
  m.fail.isFinalPublishLost = true
  const notes = [{ id: 'f1', name: 'notes.md', fromNode: 'a' }]
  const seed = { a: { output: 'ALPHA-OUT', files: notes, runId: 'r0', at: 5 } }
  expect(await startRun(m.host, g, 'Do it', 'pane', { mode: 'from-here', fromNode: 'b', seed, full: g })).toBeUndefined()
  await until(() => indexOf(m, g.id) !== undefined)
  const [saved] = indexOf(m, g.id).runs
  expect(saved).toMatchObject({ ending: 'finished', mode: 'from-here' })
  expect(recordOf(m, g.id, saved!.id).nodes['a']).toMatchObject({ status: 'done', reusedFrom: { runId: 'r0', at: 5 }, files: notes })
})

test('a blank task box takes the newest run\'s task when a graph opens or the pane opens on it; a typed one is kept', async () => {
  const g = flow('h-prefill')
  const m = memory(g)
  m.kv.set('graphs', [{ id: g.id, name: g.name }])
  await runTo(m, g, 'First task\nwith a second line')
  m.slots.ui = { ...m.slots.ui, task: '' }
  await openGraph(m.host, g.id)
  expect(m.slots.ui.task).toBe('First task\nwith a second line')
  m.slots.ui = { ...m.slots.ui, task: 'Mine' }
  await openGraph(m.host, g.id)
  expect(m.slots.ui.task).toBe('Mine')
  // The pane opening with the graph already open.
  m.slots.ui = { ...m.slots.ui, task: '  ', isOpen: false }
  await togglePane(m.host)
  expect(m.slots.ui.task).toBe('First task\nwith a second line')
  // A graph that has never run leaves the box as it is.
  const fresh = flow('h-prefill-none')
  const n = memory(fresh)
  await openGraph(n.host, fresh.id)
  expect(n.slots.ui.task).toBe('')
})

test('a run stopped before any agent starts writes no record', async () => {
  const g = flow('h-early-stop')
  const m = memory(g)
  let release!: () => void
  m.gate.register = new Promise<void>(resolve => (release = resolve))
  expect(await startRun(m.host, g, 'Do it', 'pane')).toBeUndefined()
  await until(() => m.gate.registered > 0)
  // Stopped while the agents are still being set up.
  stopRun()
  release()
  await until(() => m.toasts.includes('Agent graph "Flow" was stopped'))
  expect(m.spawnedCount()).toBe(0)
  expect(m.kv.get(`runs:${g.id}`)).toBeUndefined()
  expect([...m.fs.keys()].filter(p => p.includes('/runs/'))).toEqual([])
})

test('a run in which an agent failed is recorded as failed', async () => {
  const g = flow('h-failed')
  const m = memory(g, [], ['Bravo'])
  await runTo(m, g, 'Do it')
  const [run] = indexOf(m, g.id).runs
  expect(run).toMatchObject({ ending: 'failed' })
  const record = recordOf(m, g.id, run!.id)
  expect(record.ending).toBe('failed')
  expect(record.nodes['a']!.status).toBe('done')
  expect(record.nodes['b']!.status).toBe('failed')
  // The toast says that an agent failed, not just "finished".
  expect(m.toasts).toContain('Agent graph "Flow" finished with 1 failed agent')
  expect(m.toasts).not.toContain('Agent graph "Flow" finished')
  // An all-done run is finished.
  const ok = flow('h-ok')
  const n = memory(ok)
  await runTo(n, ok, 'Do it')
  expect(indexOf(n, ok.id).runs[0]).toMatchObject({ ending: 'finished' })
  expect(n.toasts).toContain('Agent graph "Flow" finished')
})

test('a run started by Claude reports its failed agents in the message it sends', async () => {
  const g = flow('h-failed-tool')
  const m = memory(g, [], ['Alpha', 'Bravo'])
  const sent: string[] = []
  m.host.prompt.submit = (async ({ text }: { text: string }) => void sent.push(text)) as unknown as Host['prompt']['submit']
  expect(await startRun(m.host, g, 'Do it', 'tool')).toBeUndefined()
  await until(() => sent.length > 0)
  expect(sent[0]!.startsWith('Agent graph "Flow" finished with 1 failed agent.\n\n')).toBe(true)
})

test('loadLastRun reads an entry once, and a miss once too', async () => {
  const g = flow('h-last')
  const m = memory(g)
  await runTo(m, g, 'Do it')
  let reads = 0
  const read = m.host.fs.read
  m.host.fs.read = async path => {
    if (path.includes('/runs/')) reads++
    return read(path)
  }
  const hit = await loadLastRun(m.host, g.id, 'b')
  expect(hit?.record).toMatchObject({ status: 'done', output: 'BRAVO-OUT', inputs: ['a'] })
  expect(hit?.names).toEqual({ a: 'Alpha', b: 'Bravo' })
  expect(hit?.outputs).toEqual({ a: 'ALPHA-OUT' })
  await loadLastRun(m.host, g.id, 'b')
  expect(reads).toBe(1)
  // No entry for the agent: no read at all.
  expect(await loadLastRun(m.host, g.id, 'zzz')).toBeUndefined()
  expect(reads).toBe(1)

  // The file is gone: the miss is remembered, not read again every frame.
  const lost = flow('h-lost')
  const n = memory(lost)
  await runTo(n, lost, 'Do it')
  const [only] = indexOf(n, lost.id).runs
  const saved = n.fs.get(recordFile(n, lost.id, only!.id))!
  n.fs.delete(recordFile(n, lost.id, only!.id))
  let lostReads = 0
  n.host.fs.exists = async path => {
    if (path.includes('/runs/')) lostReads++
    return n.fs.has(path)
  }
  // A run's own record write cleared the entries; the first look reads, the next ones do not.
  expect(await loadLastRun(n.host, lost.id, 'a')).toBeUndefined()
  const firstLook = lostReads
  expect(firstLook).toBeGreaterThan(0)
  expect(await loadLastRun(n.host, lost.id, 'a')).toBeUndefined()
  expect(lostReads).toBe(firstLook)
  // The file coming back does not matter until the next run clears the misses.
  n.fs.set(recordFile(n, lost.id, only!.id), saved)
  expect(await loadLastRun(n.host, lost.id, 'a')).toBeUndefined()
  await runTo(n, lost, 'Again')
  expect((await loadLastRun(n.host, lost.id, 'a'))?.record).toMatchObject({ output: 'ALPHA-OUT' })
})

test('while a run is paused, editing a past input or running with it is refused and the gate\'s file is left alone', async () => {
  const g = flow('h-paused')
  const m = memory(g)
  await runTo(m, g, 'Old task')
  const paused: Graph = { ...g, nodes: g.nodes.map(n => (n.id === 'b' ? { ...n, pauseBefore: true } : n)) }
  expect(await startRun(m.host, paused, 'New task', 'pane')).toBeUndefined()
  await until(() => m.slots.run?.nodes['b']?.status === 'paused')
  const input = './.claude/agent-graph/h-paused/inputs/b.md'
  const gateText = m.fs.get(input)
  expect(gateText).toContain('New task')
  await editLastInput(m.host, 'b')
  expect(m.slots.ui.notice).toBe('Stop the run first.')
  expect(m.fs.get(input)).toBe(gateText)
  m.slots.ui = { ...m.slots.ui, notice: null }
  await runWithInput(m.host, 'b')
  expect(m.slots.ui.notice).toBe('Stop the run first.')
  stopRun()
  await until(() => m.toasts.includes('Agent graph "Flow" was stopped'))
})

test('connecting agents is refused as soon as the run of that graph starts, even before its first update', async () => {
  const g = flow('h-connect-lock')
  const m = memory(g, ['Alpha'])
  expect(await startRun(m.host, g, 'Do it', 'pane')).toBeUndefined()
  // The start has not fired yet: no run view exists, but the graph is already being run.
  expect(m.slots.run).toBeNull()
  m.slots.ui = { ...m.slots.ui, connecting: { stage: 'kind', from: 'b', to: 'a' } }
  await confirmEdge(m.host, 'delegate')
  expect(m.slots.graph?.edges).toEqual(g.edges)
  expect(m.slots.ui.notice).toBe('Stop the run before deleting agents or editing arrows.')
  await until(() => m.spawnedCount() > 0)
  m.slots.ui = { ...m.slots.ui, connecting: { stage: 'kind', from: 'b', to: 'a' }, notice: null }
  await confirmEdge(m.host, 'delegate')
  expect(m.slots.graph?.edges).toEqual(g.edges)
  expect(m.slots.ui.notice).toBe('Stop the run before deleting agents or editing arrows.')
  stopRun()
  await until(() => m.toasts.includes('Agent graph "Flow" was stopped'))
})

test('a record that is saved is not reported as unsaved when only the pane refresh after it fails', async () => {
  const g = flow('h-refresh')
  const m = memory(g)
  const update = m.host.update
  // The pane refuses the run view that carries the new record's id.
  m.host.update = (async (slot: string, change: (value: unknown) => unknown) => {
    if (slot === 'run' && (change(m.slots.run) as { runId?: string } | null)?.runId !== undefined) throw new Error('the pane is gone')
    return update(slot as 'run', change as never)
  }) as unknown as Host['update']
  await runTo(m, g, 'Do it')
  expect(m.toasts.some(t => t.startsWith('Could not save this run'))).toBe(false)
  expect(indexOf(m, g.id).runs).toHaveLength(1)
})

test('a record being written cannot outlive the graph that is deleted meanwhile', async () => {
  const g = flow('h-race')
  const m = memory(g)
  m.kv.set('graphs', [{ id: g.id, name: g.name }])
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  let isWriting = false
  const write = m.host.fs.write
  m.host.fs.write = async (path, text) => {
    if (path.includes('/runs/')) {
      isWriting = true
      await held
    }
    return write(path, text)
  }
  expect(await startRun(m.host, g, 'Do it', 'pane')).toBeUndefined()
  await until(() => isWriting)
  const deleting = deleteGraph(m.host)
  for (let i = 0; i < 10; i++) await tick()
  release()
  await deleting
  await until(() => !isBusy())
  expect([...m.fs.keys()].filter(p => p.includes(`/${g.id}/`))).toEqual([])
  expect(m.kv.has(`runs:${g.id}`)).toBe(false)
})

// The host with a real home (USERPROFILE set), on the given OS; the commands run are collected.
function withHome(m: Memory, os: string | undefined = undefined) {
  m.host.env.get = (async (name: string) => (name === 'USERPROFILE' ? '/home/u' : name === 'OS' ? os : undefined)) as Host['env']['get']
  const argvs: string[][] = []
  const run = m.host.process.run
  m.host.process.run = (async (argv: string[], options?: unknown) => (argvs.push(argv), run(argv, options as never))) as Host['process']['run']
  return argvs
}
const folderDeletes = (argvs: string[][]) => argvs.filter(argv => argv.includes('-rf') || argv.includes('rmdir'))

test('deleting a graph removes its folder in one process and drops the stashed texts of its deleted agents', async () => {
  const g = flow('h-folder')
  const m = memory(g)
  m.kv.set('graphs', [{ id: g.id, name: g.name }])
  const argvs = withHome(m)
  await runTo(m, g, 'First task')
  await runTo(m, g, 'Second task')
  await deleteNode(m.host, 'b')
  expect(stashed.has('/tmp/b.md')).toBe(true)
  argvs.length = 0
  await deleteGraph(m.host)
  expect(stashed.has('/tmp/b.md')).toBe(false)
  expect(folderDeletes(argvs)).toEqual([['rm', '-rf', `/home/u/.claude/agent-graph/${g.id}`]])
  // The folder takes the instructions files along: no process per file.
  expect(argvs).toHaveLength(1)
})

test('on Windows the graph folder is removed with rmdir and backslashes', async () => {
  const g = flow('h-win')
  const m = memory(g)
  m.kv.set('graphs', [{ id: g.id, name: g.name }])
  const argvs = withHome(m, 'Windows_NT')
  await deleteGraph(m.host)
  expect(folderDeletes(argvs)).toEqual([['cmd', '/c', 'rmdir', '/s', '/q', `\\home\\u\\.claude\\agent-graph\\${g.id}`]])
})

test('a graph id that is not a plain token never reaches the recursive delete; its known files are removed instead', async () => {
  for (const id of ['', '../x', 'a/b', 'x"&y']) {
    const g = flow(id)
    const m = memory(g)
    m.kv.set('graphs', [{ id: g.id, name: g.name }])
    const argvs = withHome(m)
    await runTo(m, g, 'Do it')
    m.fs.set('/home/u/.claude/agent-graph/other/n.md', 'Other graph.')
    const records = [...m.fs.keys()].filter(p => p.includes('/runs/'))
    expect(records.length, `id "${id}": a record was written`).toBe(1)
    await deleteGraph(m.host)
    expect(folderDeletes(argvs), `id "${id}"`).toEqual([])
    expect(m.fs.has('/home/u/.claude/agent-graph/other/n.md'), `id "${id}": other graphs keep their files`).toBe(true)
    expect([...m.fs.keys()].filter(p => p.includes('/runs/')), `id "${id}": records removed one by one`).toEqual([])
  }
})

test('without a real home (USERPROFILE and HOME unset) the graph folder is not deleted in one go', async () => {
  const g = flow('h-nohome')
  const m = memory(g)
  m.kv.set('graphs', [{ id: g.id, name: g.name }])
  const argvs: string[][] = []
  const run = m.host.process.run
  m.host.process.run = (async (argv: string[], options?: unknown) => (argvs.push(argv), run(argv, options as never))) as Host['process']['run']
  await runTo(m, g, 'Do it')
  await deleteGraph(m.host)
  expect(folderDeletes(argvs)).toEqual([])
  expect([...m.fs.keys()].filter(p => p.includes('/runs/'))).toEqual([])
})

test('a read that fails, or a file that does not parse yet, is looked at again; only a gone file is remembered as a miss', async () => {
  const g = flow('h-flaky')
  const m = memory(g)
  await runTo(m, g, 'Do it')
  const read = m.host.fs.read
  let isFailing = true
  m.host.fs.read = async p => {
    if (isFailing && p.includes('/runs/')) throw new Error('busy')
    return read(p)
  }
  expect(await loadLastRun(m.host, g.id, 'a')).toBeUndefined()
  isFailing = false
  expect((await loadLastRun(m.host, g.id, 'a'))?.record).toMatchObject({ output: 'ALPHA-OUT' })
  // A half-written file does not parse; once it is whole the entry shows.
  const other = flow('h-flaky-parse')
  const n = memory(other)
  await runTo(n, other, 'Do it')
  const [run] = indexOf(n, other.id).runs
  const file = recordFile(n, other.id, run!.id)
  const whole = n.fs.get(file)!
  n.fs.set(file, whole.slice(0, 20))
  expect(await loadLastRun(n.host, other.id, 'b')).toBeUndefined()
  n.fs.set(file, whole)
  expect((await loadLastRun(n.host, other.id, 'b'))?.record).toMatchObject({ output: 'BRAVO-OUT' })
})

test('a reused entry shows the edited input of the run it came from', async () => {
  const g = flow('h-reused-input')
  const m = memory(g)
  await runTo(m, g, 'Task')
  const [full] = indexOf(m, g.id).runs
  // Bravo got an edited input in that run (as the actions write it), and a later run reused it.
  const origin = recordOf(m, g.id, full!.id)
  m.fs.set(recordFile(m, g.id, full!.id), JSON.stringify({ ...origin, nodes: { ...origin.nodes, b: { ...origin.nodes['b']!, inputEdited: true, prompt: 'MY INPUT' } } }))
  const reused: RunRecord = {
    ...origin, id: 'r_reused', mode: 'from-here', fromNode: 'c',
    nodes: { a: { ...origin.nodes['a']!, reusedFrom: { runId: full!.id, at: 5 } }, b: { ...origin.nodes['b']!, reusedFrom: { runId: full!.id, at: 5 } } },
  }
  m.fs.set(recordFile(m, g.id, 'r_reused'), JSON.stringify(reused))
  const index = indexOf(m, g.id)
  m.kv.set(`runs:${g.id}`, { ...index, latest: { ...index.latest, a: { ...index.latest['a']!, runId: 'r_reused' }, b: { ...index.latest['b']!, runId: 'r_reused' } } })
  await openGraph(m.host, g.id)
  const b = await loadLastRun(m.host, g.id, 'b')
  expect(b?.record).toMatchObject({ reusedFrom: { runId: full!.id }, inputEdited: true, prompt: 'MY INPUT' })
  // The one that was not edited stays plain, and so does an entry whose origin record is gone.
  expect((await loadLastRun(m.host, g.id, 'a'))?.record.inputEdited).toBeUndefined()
  m.fs.delete(recordFile(m, g.id, full!.id))
  await openGraph(m.host, g.id)
  expect((await loadLastRun(m.host, g.id, 'b'))?.record).toMatchObject({ reusedFrom: { runId: full!.id } })
})

test('From here on a helper that only another agent delegates to names it in the notice', async () => {
  const base = flow('h-helper')
  const g: Graph = { ...base, nodes: [node('c', 'Coordinator', 2), node('h', 'Helper', 40)], edges: [{ id: 'e1', from: 'c', to: 'h', kind: 'delegate' }] }
  const m = memory(g)
  m.slots.ui = { ...m.slots.ui, task: 'Do it' }
  await runFromNode(m.host, 'h')
  expect(m.slots.ui.notice).toBe('Runs Helper')
  await until(() => m.toasts.some(t => /finished/.test(t)))
})

test('From here drops a reused run whose record file is gone from the index', async () => {
  const g = flow('h-gone')
  const m = memory(g)
  await runTo(m, g, 'Task')
  const [first] = indexOf(m, g.id).runs
  m.fs.delete(recordFile(m, g.id, first!.id))
  m.slots.ui = { ...m.slots.ui, task: 'Task' }
  const ends = m.toasts.filter(t => /finished/.test(t)).length
  await runFromNode(m.host, 'b')
  // Before the new run saves anything: the missing run and the entries naming it are gone.
  expect(indexOf(m, g.id)).toEqual({ runs: [], latest: {} })
  await until(() => m.toasts.filter(t => /finished/.test(t)).length > ends)
  // Alpha had no readable entry, so it ran again.
  expect(recordOf(m, g.id, indexOf(m, g.id).runs[0]!.id).nodes['a']!.reusedFrom).toBeUndefined()
})

test('a problem on an agent that is reused does not stop the run; one on an agent that runs does', async () => {
  const base = flow('h-reused-problem')
  const nameless = (id: string): Graph => ({ ...base, nodes: base.nodes.map(n => (n.id === id ? { ...n, name: '' } : n)) })
  const seed = { a: { output: 'ALPHA-OUT', files: [], runId: 'r0', at: 5 } }
  const m = memory(base)
  const blocked = nameless('b')
  expect(await startRun(m.host, blocked, 'Do it', 'pane', { mode: 'from-here', fromNode: 'b', seed, full: blocked })).toContain('- Give this agent a name.')
  const reused = nameless('a')
  expect(await startRun(m.host, reused, 'Do it', 'pane', { mode: 'from-here', fromNode: 'b', seed, full: reused })).toBeUndefined()
  await until(() => m.toasts.some(t => /finished/.test(t)))
})

test('a run that cannot be set up says so, keeps no record and frees the run lock', async () => {
  const g: Graph = { ...flow('h-setup'), nodes: [{ ...node('a', 'Alpha', 2), contextFiles: ['/ctx'] }, node('b', 'Bravo', 40)] }
  const m = memory(g)
  m.fs.set('/ctx', 'context')
  const exists = m.host.fs.exists
  let isBroken = true
  m.host.fs.exists = async path => {
    if (isBroken && path === '/ctx') throw new Error('disk gone')
    return exists(path)
  }
  const sent: string[] = []
  m.host.prompt.submit = (async ({ text }: { text: string }) => void sent.push(text)) as unknown as Host['prompt']['submit']
  expect(await startRun(m.host, g, 'Do it', 'tool')).toBeUndefined()
  await until(() => sent.length > 0)
  expect(sent[0]).toBe('Agent graph "Flow" failed: disk gone')
  expect(m.slots.run).toMatchObject({ isRunning: false, result: 'Agent graph "Flow" failed: disk gone' })
  expect(m.kv.get(`runs:${g.id}`)).toBeUndefined()
  expect(m.spawnedCount()).toBe(0)
  await until(() => !isBusy())
  isBroken = false
  expect(await startRun(m.host, g, 'Again', 'pane')).toBeUndefined()
  await until(() => m.toasts.some(t => /finished/.test(t)))
})

test('output files whose cleaned names collide are saved under distinct names', async () => {
  const g = flow('h-outputs')
  const m = memory(g)
  const key = settings.anthropicApiKey
  settings.anthropicApiKey = 'key'
  try {
    m.host.http.fetch = (async (url: string) => ({ status: 200, ok: true, headers: {}, text: `body of ${url.split('/').at(-2)}` })) as unknown as Host['http']['fetch']
    const file = (id: string, name: string) => ({ id, name, fromNode: 'b' })
    m.slots.run = {
      graphId: g.id, graphName: 'Flow', isRunning: false, nodes: {}, result: 'r',
      outputs: [file('f1', 'a/report.md'), file('f2', 'b/report.md'), file('f3', 'REPORT.md'), file('f4', 'notes'), file('f5', 'x.png'), file('f6', 'x.png')],
    }
    await saveOutputs(m.host)
    const saved = [...m.fs.keys()].filter(p => p.startsWith('agent-graph-outputs/'))
    const names = saved.map(p => p.split('/').at(-1)!).sort()
    expect(names).toEqual(['REPORT (3).md', 'report (2).md', 'report.md'])
    const text = (name: string) => m.fs.get(saved.find(p => p.endsWith(`/${name}`))!)
    expect([text('report.md'), text('report (2).md'), text('REPORT (3).md')]).toEqual(['body of f1', 'body of f2', 'body of f3'])
    // The skipped names are distinct too.
    expect(m.toasts.at(-1)).toContain('Skipped 3 binary file(s): notes, x.png, x (2).png')
  } finally {
    settings.anthropicApiKey = key
  }
})

test('two runs save their transcripts to their own folders, also when neither has a record id', async () => {
  const g = flow('h-folders')
  const m = memory(g)
  const view = (runId?: string) => ({ graphId: g.id, graphName: 'Flow', isRunning: false, nodes: {}, task: 'Same task', result: 'r', ...(runId !== undefined ? { runId } : {}) })
  const saveFor = async (runId?: string) => {
    m.slots.run = view(runId)
    await saveTranscript(m.host)
    return m.toasts.at(-1)!
  }
  const first = await saveFor('r_one')
  // The folder is named by the time.
  await tick()
  const second = await saveFor('r_two')
  expect(second).not.toBe(first)
  // The same run again goes to the same folder.
  expect(await saveFor('r_two')).toBe(second)
  // A run that started no agent keeps no record, so no id: the next run's folder is still its own.
  await tick()
  const early = await saveFor()
  expect(await saveFor()).toBe(early)
  await runTo(m, g, 'Another')
  await tick()
  expect(await saveFor()).not.toBe(early)
})

test('From here forgets a reused run whose file is gone, but never one that merely cannot be read now', async () => {
  const g = flow('h-locked')
  const m = memory(g)
  await runTo(m, g, 'Task')
  const [first] = indexOf(m, g.id).runs
  const file = recordFile(m, g.id, first!.id)
  const read = m.host.fs.read
  let isLocked = true
  m.host.fs.read = async p => {
    if (isLocked && p.includes('/runs/')) throw new Error('EBUSY')
    return read(p)
  }
  m.slots.ui = { ...m.slots.ui, task: 'Task' }
  const ends = m.toasts.filter(t => /finished/.test(t)).length
  await runFromNode(m.host, 'b')
  // Alpha runs again, but the record and the index entries naming it are untouched.
  expect(m.fs.has(file)).toBe(true)
  expect(indexOf(m, g.id).runs.map(r => r.id)).toEqual([first!.id])
  expect(indexOf(m, g.id).latest['a']?.runId).toBe(first!.id)
  await until(() => m.toasts.filter(t => /finished/.test(t)).length > ends)
  isLocked = false
  expect(m.fs.has(file)).toBe(true)
  expect(recordOf(m, g.id, first!.id).nodes['a']).toMatchObject({ status: 'done' })
})

test('From here is refused while a run is going', async () => {
  const g = flow('h-from-busy')
  const m = memory(g, ['Alpha'])
  m.slots.ui = { ...m.slots.ui, task: 'Do it' }
  expect(await startRun(m.host, g, 'Do it', 'pane')).toBeUndefined()
  await until(() => m.spawnedCount() > 0)
  await runFromNode(m.host, 'b')
  expect(m.slots.ui.notice).toBe('Stop the run first.')
  stopRun()
  await until(() => m.toasts.includes('Agent graph "Flow" was stopped'))
})

test('a run stopped before its start fires still says it was stopped', async () => {
  const g = flow('h-early-notice')
  const m = memory(g)
  const sent: string[] = []
  m.host.prompt.submit = (async ({ text }: { text: string }) => void sent.push(text)) as unknown as Host['prompt']['submit']
  expect(await startRun(m.host, g, 'Do it', 'tool')).toBeUndefined()
  stopRun()
  await until(() => sent.length > 0)
  expect(sent).toEqual(['Agent graph "Flow" was stopped.'])
  expect(await startRun(m.host, g, 'Again', 'pane')).toBeUndefined()
  stopRun()
  expect(m.toasts).toContain('Agent graph "Flow" was stopped')
})

test('Run with this input on a card inside a retry loop plans from that card: the target is reused and, when the judge fails, sent back with its saved answer', async () => {
  // Alpha -> Bravo -> Charlie; Charlie (a reviewer with no VERDICT line, so it fails every round) sends work back to Alpha once.
  const g: Graph = {
    id: 'h-loop-input', name: 'Flow', description: '', backend: 'local', layout: 2,
    nodes: [node('a', 'Alpha', 2), node('b', 'Bravo', 40), node('c', 'Charlie', 78)],
    edges: [
      { id: 'e1', from: 'a', to: 'b', kind: 'handoff' }, { id: 'e2', from: 'b', to: 'c', kind: 'handoff' },
      { id: 'e3', from: 'c', to: 'a', kind: 'retry', retries: 1 },
    ],
  }
  const m = memory(g)
  m.slots.ui = { ...m.slots.ui, task: 'Task' }
  m.host.process.run = (async () => ({ exitCode: 0, stdout: '', stderr: '' })) as unknown as Host['process']['run']
  const spawned: Array<{ name: string; prompt: string }> = []
  const spawn = m.host.agent.spawn
  m.host.agent.spawn = (async (args: { description: string; prompt: string }) => {
    spawned.push({ name: args.description.split(' ')[0]!, prompt: args.prompt })
    return spawn(args as never)
  }) as unknown as Host['agent']['spawn']
  await runTo(m, g, 'Task')
  expect(spawned.map(s => s.name)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Alpha', 'Bravo', 'Charlie'])
  spawned.length = 0
  // The person edits what Bravo is given and runs from there.
  await editLastInput(m.host, 'b')
  m.fs.set('./.claude/agent-graph/h-loop-input/inputs/b.md', 'EDITED INPUT FOR BRAVO')
  await runWithInput(m.host, 'b')
  expect(m.slots.ui.notice).toBe('Uses your input for Bravo · reuses Alpha · runs Bravo, Charlie')
  await until(() => m.toasts.filter(t => /finished/.test(t)).length >= 2)
  // Round 1: Alpha is reused (not run), Bravo gets the edit. Round 2: Charlie failed, so Alpha runs again.
  expect(spawned.map(s => s.name)).toEqual(['Bravo', 'Charlie', 'Alpha', 'Bravo', 'Charlie'])
  expect(spawned[0]!.prompt).toBe('EDITED INPUT FOR BRAVO')
  expect(spawned[2]!.prompt).toContain('## Charlie failed (retry 1 of 1)')
  expect(spawned[2]!.prompt).toContain('## Your answer last round\n\nALPHA-OUT')
  const [newest] = indexOf(m, g.id).runs
  expect(recordOf(m, g.id, newest!.id)).toMatchObject({ mode: 'from-here', fromNode: 'b' })
})
