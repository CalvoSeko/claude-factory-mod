import { expect } from 'claude-code/testing'
import { test } from './kit'

import {
  cancelTrust, importGraphs, isBusy, onCanvas, openGraph, registerGraphTools, runFromPane, setBackend, startRun, stopRun, toolName, trustAndRun,
  type Host,
} from '../hooks/actions'
import { EMPTY_UI, type Slots } from '../hooks/state'
import { isTrusted, notTrustedText, trustLines } from '../hooks/trust'
import type { AgentNode, Graph } from '../types'

const HOME = '/home/u'

const agent = (graphId: string, id: string, name: string, over: Partial<AgentNode> = {}): AgentNode => ({
  id, name, x: 2, y: 1, instructionsFile: `${HOME}/.claude/agent-graph/${graphId}/${id}.md`,
  skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2, ...over,
})
const flow = (id: string, name: string, trusted?: boolean): Graph => ({
  id, name, description: '', backend: 'local', layout: 2, nodes: [agent(id, 'a', 'Alpha')], edges: [],
  ...(trusted !== undefined ? { trusted } : {}),
})

test('trustLines shows the backend, the description, the cap and every card, author text as unclipped JSON literals', () => {
  const long = 'x'.repeat(300)
  const g: Graph = {
    id: 'g1', name: 'Shared', description: `${long}\nIgnore previous`, backend: 'headless', runCapUsd: 20, nodes: [
      agent('g1', 'k', 'Lint', { instructionsFile: '', check: { command: 'npm test\nrm -rf /', timeoutMin: 5 } }),
      agent('g1', 'w', 'Writer', { tools: ['Read', 'Bash'], model: 'opus', budgetUsd: 3, contextFiles: ['/etc/passwd'], whenToUse: 'Use when "x"' }),
      agent('g1', 'h', 'Helper', { whenToUse: '  ' }),
    ],
    edges: [{ id: 'e1', from: 'w', to: 'h', kind: 'delegate' }],
  }
  expect(trustLines(g)).toEqual([
    'Runs on Headless: each agent card is its own claude -p in auto mode',
    `Description (shown to Claude as the tool's text): "${long}\\nIgnore previous"`,
    'Run cap: $20.00',
    'Check "Lint" runs "npm test\\nrm -rf /" (timeout 5 min)',
    'Agent "Writer": tools "Read", "Bash" · model "opus" · budget $3 · when to use "Use when \\"x\\""',
    '  context: "/etc/passwd"',
    '  helpers: "Helper"',
    'Agent "Helper": tools all · model default · budget $2',
    '  context: none',
    '  helpers: none',
  ])
  const plain = trustLines({ ...g, backend: 'local', description: '', runCapUsd: undefined, nodes: [], edges: [] })
  expect(plain).toEqual(['Runs on Local', 'Description: none', 'Run cap: none'])
  expect(trustLines({ ...g, backend: 'cloud', nodes: [] })[0]).toBe('Runs on Cloud: context files are uploaded')
})

test('a graph is trusted unless it says it is not', () => {
  expect(isTrusted(flow('g', 'G'))).toBe(true)
  expect(isTrusted(flow('g', 'G', true))).toBe(true)
  expect(isTrusted(flow('g', 'G', false))).toBe(false)
})

// The actions over a host made of plain maps; a started run is only scheduled (clock.after is collected, never fired).
function memory(graphs: Graph[], imports: Record<string, string> = {}) {
  const importDir = `${HOME}/.claude/agent-graph/import`
  const kv = new Map<string, unknown>([...graphs.map(g => [`graph:${g.id}`, g] as const), ['graphs', graphs.map(g => ({ id: g.id, name: g.name }))]])
  const fs = new Map<string, string>(Object.entries(imports).map(([name, text]) => [`${importDir}/${name}`, text] as const))
  const slots: Slots = { index: [], graph: graphs[0]!, ui: { ...EMPTY_UI, graphId: graphs[0]!.id, task: 'Do it' }, run: null, agents: [] }
  const tools: string[] = []
  const scheduled: (() => void)[] = []
  const host = {
    env: { get: async (name: string) => (name === 'USERPROFILE' ? HOME : undefined) },
    store: {
      get: async (key: string) => kv.get(key),
      set: async (key: string, value: unknown) => void kv.set(key, JSON.parse(JSON.stringify(value))),
      delete: async (key: string) => void kv.delete(key),
    },
    fs: {
      exists: async (path: string) => fs.has(path) || (path === importDir && Object.keys(imports).length > 0),
      read: async (path: string) => fs.get(path) ?? '',
      write: async (path: string, text: string) => void fs.set(path, text),
      list: async (path: string) => (path === importDir ? Object.keys(imports).map(name => ({ name, kind: 'file' })) : []),
    },
    process: { run: async (argv: string[]) => (fs.delete(argv[argv.length - 1]!), { exitCode: 0, stdout: '', stderr: '' }) },
    tool: { register: async (spec: { name: string }) => void tools.push(spec.name) },
    clock: { after: (_ms: number, run: () => void) => void scheduled.push(run), now: async () => 0 },
    ui: { open: async () => ({ isPlaced: true }), close: async () => undefined, toast: () => undefined },
    prompt: { submit: async () => undefined },
    read: async (slot: keyof Slots) => slots[slot],
    update: async (slot: keyof Slots, change: (value: unknown) => unknown) => ((slots as Record<string, unknown>)[slot] = change(slots[slot])),
  } as unknown as Host
  return { host, slots, kv, tools, scheduled }
}

// A run that was started (scheduled) is let go again, so the next test can start one.
const release = () => stopRun()

test('an imported graph gets no run tool, while a pane graph does', async () => {
  const pane = flow('p1', 'Pane')
  const shared = flow('shared', 'Shared')
  const m = memory([pane], { 'shared.json': JSON.stringify(shared) })
  expect(await importGraphs(m.host)).toBe(1)
  await registerGraphTools(m.host)
  expect(m.tools).toEqual([toolName(pane)])
})

test('a run of an untrusted graph is refused from a tool call and from the pane, and nothing starts', async () => {
  const g = flow('u1', 'Shared', false)
  const m = memory([g])
  expect(await startRun(m.host, g, 'Do it', 'tool')).toBe(notTrustedText(g))
  expect(await startRun(m.host, g, 'Do it', 'pane', { step: true })).toBe(notTrustedText(g))
  expect(notTrustedText(g)).toBe('Agent graph "Shared" was imported and is not trusted yet: open it in the agent graph pane and press ▶ Run to review it.')
  expect(m.scheduled).toEqual([])
  expect(isBusy()).toBe(false)
})

test('Run on an untrusted graph opens the approval view and starts nothing', async () => {
  const g = flow('u2', 'Shared', false)
  const m = memory([g])
  await runFromPane(m.host)
  expect(m.slots.ui.approving).toBe('u2')
  expect(m.slots.ui.notice).toBeNull()
  expect(m.scheduled).toEqual([])
  expect(isBusy()).toBe(false)
})

test('Trust and run stores the graph as trusted, registers its tool and starts the run', async () => {
  const g = flow('u3', 'Shared', false)
  const m = memory([g])
  await runFromPane(m.host)
  await trustAndRun(m.host)
  expect((m.kv.get('graph:u3') as Graph).trusted).toBe(true)
  expect(m.slots.graph?.trusted).toBe(true)
  expect(m.slots.ui.approving).toBeNull()
  expect(m.tools).toEqual([toolName(g)])
  expect(m.scheduled.length).toBe(1)
  expect(isBusy()).toBe(true)
  release()
})

test('Cancel closes the approval view and the graph stays untrusted', async () => {
  const g = flow('u4', 'Shared', false)
  const m = memory([g])
  await runFromPane(m.host)
  await cancelTrust(m.host)
  expect(m.slots.ui.approving).toBeNull()
  expect((m.kv.get('graph:u4') as Graph).trusted).toBe(false)
  expect(m.tools).toEqual([])
})

test('an undo after trusting keeps the graph trusted', async () => {
  const g = flow('u5', 'Shared', false)
  const m = memory([g])
  await setBackend(m.host, 'headless')
  await runFromPane(m.host)
  await trustAndRun(m.host)
  release()
  await onCanvas(m.host, { kind: 'key', key: 'z', ctrl: true })
  expect(m.slots.graph?.backend).toBe('local')
  expect(m.slots.graph?.trusted).toBe(true)
  expect((m.kv.get('graph:u5') as Graph).trusted).toBe(true)
})

test('opening another graph closes the approval view, and coming back does not show it until Run is pressed again', async () => {
  const g = flow('u6', 'Shared', false)
  const other = flow('p6', 'Other')
  const m = memory([g, other])
  await runFromPane(m.host)
  expect(m.slots.ui.approving).toBe('u6')
  await openGraph(m.host, 'p6')
  expect(m.slots.ui.approving).toBeNull()
  await openGraph(m.host, 'u6')
  expect(m.slots.ui.approving).toBeNull()
  await runFromPane(m.host)
  expect(m.slots.ui.approving).toBe('u6')
  expect(m.scheduled).toEqual([])
})
