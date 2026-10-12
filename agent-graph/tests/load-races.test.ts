import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { FsEntry, FsStat } from 'claude-code'

import {
  cachedInstructions, cachedRunIndex, cachedSkills, cachedTests, deleteGraph, loadLibrary, newGraph, openGraph, patchNode, renameGraph, setBackend, startRun, stopRun, toolName, togglePane, type Host,
} from '../hooks/actions'
import { EMPTY_UI, type Slots } from '../hooks/state'
import type { AgentNode, Graph } from '../types'

declare const setTimeout: (run: () => void, ms?: number) => unknown

// One test per race of a load. The run-tool registry is module memory shared by every test in this file:
// a load retires the run tools an earlier test's graphs left live, so each test looks only at what it sends
// after its own first load, and the test that expects the editor tools comes first.

const HOME = '/home/u'
const IMPORT = `${HOME}/.claude/agent-graph/import`

const agent = (graphId: string, id: string, name: string): AgentNode => ({
  id, name, x: 2, y: 1, instructionsFile: `${HOME}/.claude/agent-graph/${graphId}/${id}.md`,
  skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
const flow = (id: string, name: string, nodes: AgentNode[] = [agent(id, 'a', 'Alpha')]): Graph => ({
  id, name, description: '', backend: 'local', layout: 2, nodes, edges: [],
})

type Spec = { name: string; description: string }
type Gate = { reached: Promise<void>; release: () => void }

// The actions over a host of plain maps. A store call can be held at a gate: `hold('set', 'graphs', v => …)`
// holds the next matching call (a get keeps the value it read) until released.
function memory(graphs: Graph[], imports: Record<string, Graph> = {}) {
  const kv = new Map<string, unknown>([...graphs.map(g => [`graph:${g.id}`, g] as const), ['graphs', graphs.map(g => ({ id: g.id, name: g.name }))]])
  const files = new Map<string, string>(Object.entries(imports).map(([name, g]) => [`${IMPORT}/${name}`, JSON.stringify(g)] as const))
  const slots: Slots = { index: [], graph: graphs[0] ?? null, ui: { ...EMPTY_UI, graphId: graphs[0]?.id ?? null }, run: null, agents: [] }
  const sent: Spec[] = []
  const toasts: string[] = []
  // What tool.list answers, by full name.
  const listed: Spec[] = []
  // Tool names whose register rejects.
  const failing = new Set<string>()
  // Folders other than the import folder, and what fs.stat answers (by path).
  const dirs = new Map<string, FsEntry[]>()
  const stats = new Map<string, FsStat>()
  // Called on every write of a state slot, before the value is set.
  const watch = { write: (_slot: keyof Slots, _value: unknown): void => undefined }
  const gates: Array<{ op: 'get' | 'set'; key: string; when: (value: unknown) => boolean; arrive: () => void; wait: Promise<void> }> = []
  const pass = async (op: 'get' | 'set', key: string, value: unknown) => {
    const at = gates.findIndex(g => g.op === op && g.key === key && g.when(value))
    if (at < 0) return
    const [gate] = gates.splice(at, 1)
    gate!.arrive()
    await gate!.wait
  }
  const hold = (op: 'get' | 'set', key: string, when: (value: unknown) => boolean = () => true): Gate => {
    let arrive!: () => void
    let release!: () => void
    const reached = new Promise<void>(resolve => (arrive = resolve))
    const wait = new Promise<void>(resolve => (release = resolve))
    gates.push({ op, key, when, arrive, wait })
    return { reached, release }
  }
  const host = {
    env: { get: async (name: string) => (name === 'USERPROFILE' ? HOME : undefined) },
    store: {
      get: async (key: string) => {
        const value = kv.get(key)
        await pass('get', key, value)
        return value
      },
      set: async (key: string, value: unknown) => {
        await pass('set', key, value)
        kv.set(key, JSON.parse(JSON.stringify(value)))
      },
      delete: async (key: string) => void kv.delete(key),
    },
    fs: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => files.get(path) ?? '',
      write: async (path: string, text: string) => void files.set(path, text),
      list: async (path: string) => {
        if (path === IMPORT) return [...files.keys()].filter(p => p.startsWith(`${IMPORT}/`)).map(p => ({ name: p.slice(IMPORT.length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false }))
        const entries = dirs.get(path)
        if (entries === undefined) throw new Error(`${path}: no such folder`)
        return entries
      },
      stat: async (path: string) => {
        const stat = stats.get(path)
        if (stat === undefined) throw new Error(`${path}: not found`)
        return stat
      },
    },
    process: { run: async (argv: string[]) => (files.delete(argv[argv.length - 1]!), { exitCode: 0, stdout: '', stderr: '' }) },
    tool: {
      register: async (spec: Spec) => {
        if (failing.has(spec.name)) throw new Error(`could not register ${spec.name}`)
        sent.push({ name: spec.name, description: spec.description })
      },
      list: async () => listed.map(t => ({ ...t, mcp: true })),
    },
    clock: { after: () => undefined, now: async () => 0 },
    ui: { toast: async (text: string) => void toasts.push(text), open: async () => ({ isPlaced: true }), close: async () => undefined },
    read: async (slot: keyof Slots) => slots[slot],
    update: async (slot: keyof Slots, change: (value: unknown) => unknown) => {
      const value = change(slots[slot])
      watch.write(slot, value)
      ;(slots as Record<string, unknown>)[slot] = value
    },
  } as unknown as Host
  return { host, kv, files, dirs, stats, slots, sent, toasts, listed, failing, hold, watch }
}

// Lets everything that can go on without a held gate go on.
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => void setTimeout(resolve, 0))
}
const names = (specs: Spec[]) => specs.map(s => s.name)

test('R1: a run tool that cannot be registered does not keep the others from theirs, and says so once', async () => {
  const [g1, g2, g3] = [flow('r1a', 'One'), flow('r1b', 'Two'), flow('r1c', 'Three')]
  const m = memory([g1!, g2!, g3!])
  m.failing.add(toolName(g2!))
  await loadLibrary(m.host)
  expect(names(m.sent)).toEqual(['read_graph', 'edit_graph', toolName(g1!), toolName(g3!)])
  expect(m.toasts).toEqual([`Agent Graph: 1 tool could not be registered (could not register ${toolName(g2!)}).`])
})

test('R2: an import during a load and a new graph at the same time both stay in the index', async () => {
  const pane = flow('r2a', 'Pane')
  const shared = flow('r2b', 'Shared')
  const m = memory([pane], { 'shared.json': shared })
  // The import has read the index and waits to write it.
  const gate = m.hold('set', 'graphs', list => (list as Array<{ id: string }>).some(e => e.id !== pane.id))
  const load = loadLibrary(m.host)
  await gate.reached
  const created = newGraph(m.host)
  await settle()
  gate.release()
  await Promise.all([load, created])
  const index = m.kv.get('graphs') as Array<{ name: string }>
  expect(index.map(e => e.name)).toEqual(['New graph', 'Pane', 'Shared'])
})

test('R5: two loads publish the index in order, so the last one read wins', async () => {
  const g = flow('r5a', 'First')
  const m = memory([g])
  const gate = m.hold('get', 'graphs')
  const a = loadLibrary(m.host)
  await gate.reached
  // Another session adds a graph while load A holds the old index.
  const later = flow('r5b', 'Second')
  m.kv.set(`graph:${later.id}`, later)
  m.kv.set('graphs', [{ id: g.id, name: g.name }, { id: later.id, name: later.name }])
  const b = loadLibrary(m.host)
  await settle()
  gate.release()
  await Promise.all([a, b])
  expect(m.slots.index.map(e => e.name)).toEqual(['First', 'Second'])
})

test('R6a: a graph edited into a state that cannot run keeps its tool until the next load retires it; fixed, it is sent again', async () => {
  const g = flow('r6a', 'Pair', [agent('r6a', 'a', 'Alpha'), agent('r6a', 'b', 'Beta')])
  const m = memory([g])
  await loadLibrary(m.host)
  expect(names(m.sent)).toContain(toolName(g))
  m.sent.length = 0
  // Two agents of one name: a problem, so the graph cannot run.
  await patchNode(m.host, 'b', { name: 'Alpha' })
  expect(m.sent).toEqual([])
  await loadLibrary(m.host)
  expect(m.sent).toEqual([{ name: toolName(g), description: 'Retired: its agent graph is gone or cannot run now. Do not call this tool.' }])
  m.sent.length = 0
  await patchNode(m.host, 'b', { name: 'Beta' })
  expect(names(m.sent)).toEqual([toolName(g)])
  expect(m.sent[0]!.description).toMatch(/^Runs the agent graph "Pair"/)
})

test('R6b: a listed run tool no graph wants is retired once; one already retired is left alone', async () => {
  const m = memory([flow('r6b', 'Kept')])
  m.listed.push(
    { name: 'mcp__agent-graph__run_gone_123456', description: 'Runs the agent graph "Gone".' },
    { name: 'mcp__agent-graph__run_old_654321', description: 'Retired: the agent graph "Old" was deleted. Do not call this tool.' },
  )
  await loadLibrary(m.host)
  expect(m.sent.filter(s => s.name === 'run_gone_123456' || s.name === 'run_old_654321')).toEqual([
    { name: 'run_gone_123456', description: 'Retired: its agent graph is gone or cannot run now. Do not call this tool.' },
  ])
  m.sent.length = 0
  await loadLibrary(m.host)
  expect(m.sent).toEqual([])
})

test('R7: an edit that leaves the run tool as it was sends nothing; a rename sends the new tool and retires the old name', async () => {
  const g = flow('r7', 'Flow')
  const m = memory([g])
  await loadLibrary(m.host)
  m.sent.length = 0
  await setBackend(m.host, 'headless')
  expect(m.sent).toEqual([])
  await renameGraph(m.host, 'Beta')
  const renamed = { ...g, name: 'Beta' }
  expect(names(m.sent)).toEqual([toolName(renamed), toolName(g)])
  expect(m.sent[0]!.description).toMatch(/^Runs the agent graph "Beta"/)
  expect(m.sent[1]!.description).toBe('Retired: the agent graph "Flow" was renamed. Do not call this tool.')
})

test('R3: a load replaces a stale open graph with the stored one and ends a run view nothing runs any more', async () => {
  const stored = flow('r3', 'Stored', [agent('r3', 'a', 'Alpha')])
  const m = memory([stored])
  // The atoms as an earlier module instance left them: an older copy with a card the store no longer has, selected,
  // and a run that was going when the mod was reloaded.
  m.slots.graph = { ...stored, nodes: [agent('r3', 'a', 'Alpha'), agent('r3', 'b', 'Beta')] }
  m.slots.ui = { ...m.slots.ui, selected: 'b' }
  m.slots.run = { graphId: stored.id, graphName: stored.name, isRunning: true, nodes: { a: { status: 'running' }, b: { status: 'done', output: 'ok' } } }
  await loadLibrary(m.host)
  expect(m.slots.graph).toEqual(stored)
  expect(m.slots.ui.selected).toBeNull()
  expect(m.slots.run).toEqual({
    graphId: stored.id, graphName: stored.name, isRunning: false, nodes: { a: { status: 'cancelled' }, b: { status: 'done', output: 'ok' } },
    result: 'Stopped: Agent Graph was reloaded while this run went.',
  })
})

// After R3: starting a run here makes this module instance one that has run, for every test below it.
test('R3b: a load leaves a run view alone once this instance has started a run, also after that run was released', async () => {
  const g = flow('r3b', 'Started')
  const m = memory([g])
  expect(await startRun(m.host, g, 'Do it', 'pane')).toBeUndefined()
  // The engine never calls the start back, so the stop releases the run: nothing is busy now.
  stopRun()
  const view = { graphId: g.id, graphName: g.name, isRunning: true, nodes: { a: { status: 'running' as const } } }
  m.slots.run = view
  await loadLibrary(m.host)
  expect(m.slots.run).toEqual(view)
})

test('R4a: a load with the pane open and no graph open opens the first graph; with the pane closed it opens none', async () => {
  const [a, b] = [flow('r4a-a', 'Alpha'), flow('r4a-b', 'Beta')]
  const closed = memory([a, b])
  closed.slots.graph = null as Graph | null
  await loadLibrary(closed.host)
  expect(closed.slots.graph).toBeNull()
  const open = memory([a, b])
  open.slots.graph = null as Graph | null
  open.slots.ui = { ...open.slots.ui, isOpen: true, graphId: null }
  await loadLibrary(open.host)
  expect(open.slots.graph?.id).toBe(a.id)
  expect(open.slots.ui.graphId).toBe(a.id)
})

test('R4b: opening a graph clears the selection before the graph changes, and its caches are warm by then', async () => {
  const from = flow('r4b-a', 'From')
  const to = flow('r4b-b', 'To', [agent('r4b-b', 'a', 'Alpha'), agent('r4b-b', 'b', 'Beta')])
  const m = memory([from, to])
  m.slots.ui = { ...m.slots.ui, selected: 'a' }
  const writes: Array<{ slot: keyof Slots; selected?: string | null; warm?: boolean }> = []
  m.watch.write = (slot, value) => {
    if (slot === 'ui') writes.push({ slot, selected: (value as Slots['ui']).selected })
    if (slot === 'graph') writes.push({ slot, warm: cachedRunIndex(to.id) !== undefined && cachedTests(to.id) !== undefined && to.nodes.every(n => cachedInstructions(n.instructionsFile) !== undefined) })
  }
  await openGraph(m.host, to.id)
  expect(writes).toEqual([{ slot: 'ui', selected: null }, { slot: 'graph', warm: true }])
  expect(m.slots.graph?.id).toBe(to.id)
})

test('skills wiring: opening the pane finds a linked skill whose folder is inside home', async () => {
  const m = memory([flow('sk', 'Skills')])
  const skills = `${HOME}/.claude/skills`
  m.dirs.set(skills, [{ name: 'linked', kind: 'other', size: 0, mtimeMs: 0, isLink: true }])
  m.stats.set(HOME, { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: HOME })
  m.stats.set(`${skills}/linked`, { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, realPath: `${HOME}/.agents/skills/linked` })
  m.files.set(`${skills}/linked/SKILL.md`, 'A skill.')
  await togglePane(m.host, true)
  expect(cachedSkills()).toContain('linked')
})

test('a skills scan that rejects does not keep the pane from opening, and the list stays as it was', async () => {
  const g = flow('sk2', 'Scan')
  const m = memory([g])
  const before = cachedSkills()
  // A listing that throws at once, not as a rejected promise: the scan rejects instead of finding nothing.
  const list = m.host.fs.list
  m.host.fs.list = ((path: string) => {
    if (path.endsWith('.claude/skills')) throw new Error('no listing')
    return list(path)
  }) as typeof list
  await togglePane(m.host)
  expect(m.slots.ui.isOpen).toBe(true)
  expect(m.slots.graph?.id).toBe(g.id)
  expect(cachedSkills()).toEqual(before)
})

// Kept last: with a fix reverted the library lock stays taken, and every later load would wait too.
test('deadlock: deleting graphs, a new graph and a first load of an empty library all finish', async () => {
  const done = (work: Promise<unknown>) => Promise.race([work.then(() => 'done'), new Promise(resolve => void setTimeout(() => resolve('stuck'), 2000))])
  const m = memory([flow('dl-a', 'Alpha'), flow('dl-b', 'Beta')])
  // The open graph goes, and the next one opens; then the last one goes, and a new graph takes its place.
  expect(await done(deleteGraph(m.host))).toBe('done')
  expect(m.slots.graph?.name).toBe('Beta')
  expect(await done(deleteGraph(m.host))).toBe('done')
  expect(m.slots.graph?.name).toBe('New graph')
  expect(m.slots.index.map(e => e.name)).toEqual(['New graph'])
  expect(await done(newGraph(m.host))).toBe('done')
  expect(m.slots.index.map(e => e.name)).toEqual(['New graph', 'New graph 2'])
  expect(m.slots.graph?.name).toBe('New graph 2')
  const empty = memory([])
  expect(await done(loadLibrary(empty.host, { show: true }))).toBe('done')
  expect(empty.slots.graph?.name).toBe('New graph')
  expect(empty.slots.index.map(e => e.name)).toEqual(['New graph'])
})
