import { expect, type Mounted } from 'claude-code/testing'
import { test } from './kit'

import type { FsEntry } from 'claude-code'

import type { AgentNode, Graph, RunIndex } from '../types'

// The engine calls a load makes, counted at the engine boundary through the real hooks, on the
// person's shape: 6 graphs of 10 agent cards, 9 skill folders and 66 linked skills.
// A round is a run of calls with at least one in flight: one that starts while none is opens a new
// round, so the rounds of a phase stand for its steps done one after another.

const HOME = '/home/u'
const ROOT = `${HOME}/.claude/agent-graph`
const SKILLS = `${HOME}/.claude/skills`
const PANE = {
  plugin: 'agent-graph', component: 'Pane', requestId: 'agent-graph',
  props: { title: 'Agent Graph', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const card = (graphId: string, i: number): AgentNode => ({
  id: `n${i}`, name: `Agent ${i}`, x: 2 + 30 * (i % 3), y: 1 + 7 * Math.floor(i / 3), instructionsFile: `${ROOT}/${graphId}/n${i}.md`,
  skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
const graphs: Graph[] = [1, 2, 3, 4, 5, 6].map(k => ({
  id: `graph${k}`, name: `Flow ${k}`, description: '', backend: 'local', layout: 2, edges: [],
  nodes: Array.from({ length: 10 }, (_, i) => card(`graph${k}`, i)),
}))
const first = graphs[0]!
const runIndex: RunIndex = { runs: [{ id: 'r1', at: 1, ending: 'finished', mode: 'full', taskLine: 'Ship it', costUsd: 0 }], latest: {} }

// The mock file system answers Windows-style paths; the maps are keyed by the plain ones.
const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const realSkills = Array.from({ length: 9 }, (_, i) => `own${i}`)
const linkedSkills = Array.from({ length: 66 }, (_, i) => `linked${i}`)
const entry = (name: string, kind: FsEntry['kind']): FsEntry => ({ name, kind, size: 0, mtimeMs: 0, isLink: kind === 'other' })
// Each link of ~/.claude/skills leads to its folder under ~/.agents/skills.
const links = new Map(linkedSkills.map(name => [`${SKILLS}/${name}`, `${HOME}/.agents/skills/${name}`]))
const resolve = (path: string) => {
  for (const [link, target] of links) if (path === link || path.startsWith(`${link}/`)) return target + path.slice(link.length)
  return path
}
const dirs = new Map<string, FsEntry[]>([
  [HOME, []],
  [`${ROOT}/import`, []],
  [`${SKILLS}/.trash`, []],
  [SKILLS, [...realSkills.map(n => entry(n, 'dir')), ...linkedSkills.map(n => entry(n, 'other')), entry('.trash', 'dir')]],
  ...[...realSkills.map(n => `${SKILLS}/${n}`), ...links.values()].map((path): [string, FsEntry[]] => [path, [entry('SKILL.md', 'file')]]),
])
const files = new Map<string, string>([
  ...graphs.flatMap(g => g.nodes.map(n => [n.instructionsFile, `Do the work of ${n.name}.`] as const)),
  ...[...realSkills.map(n => `${SKILLS}/${n}`), ...links.values()].map(dir => [`${dir}/SKILL.md`, 'A skill.'] as const),
  [`${ROOT}/${first.id}/tests.json`, '[]'],
  [`${ROOT}/${first.id}/runs/r1.json`, JSON.stringify({ id: 'r1', graphId: first.id, task: 'Ship it', mode: 'full', nodes: {} })],
])
const store = new Map<string, unknown>([
  ['graphs', graphs.map(g => ({ id: g.id, name: g.name }))],
  ...graphs.map(g => [`graph:${g.id}`, g] as const),
  [`runs:${first.id}`, runIndex],
])

type Tally = { calls: Record<string, number>; rounds: number }
let tally: Tally = { calls: {}, rounds: 0 }
let inFlight = 0

// Counts one engine call and answers it; the answer yields once more before it settles, so calls
// started together are in flight together (the counts do not depend on it; the rounds pinned below are for
// exactly one yield per answer).
async function count<T>(kind: string, answer: () => T | Promise<T>): Promise<T> {
  tally.calls[kind] = (tally.calls[kind] ?? 0) + 1
  if (inFlight === 0) tally.rounds++
  inFlight++
  try {
    const value = await answer()
    await Promise.resolve()
    return value
  } finally {
    inFlight--
  }
}

async function phase(body: () => Promise<unknown>): Promise<Tally> {
  tally = { calls: {}, rounds: 0 }
  await body()
  expect(inFlight, 'a call of the phase is still in flight').toBe(0)
  return { calls: { ...tally.calls }, rounds: tally.rounds }
}

test('the engine calls of a load, a pane open and five nudges', async ($, on) => {
  const tools = new Map<string, string>()
  on('env.get', (_$, e) => count('env.get', () => ({ value: e.name === 'USERPROFILE' ? HOME : undefined }) as never))
  on('store.get', (_$, e) => count('store.get', () => ({ value: store.get(e.key) }) as never))
  on('store.set', (_$, e) => count('store.set', () => {
    store.set(e.key, e.value)
    return { value: undefined } as never
  }))
  on('state.get', (_$, e, next) => count('state.get', () => next(e)))
  on('state.set', (_$, e, next) => count('state.set', () => next(e)))
  on('fs.exists', (_$, e) => count('fs.exists', () => {
    const path = resolve(norm(e.path))
    return { value: files.has(path) || dirs.has(path) } as never
  }))
  // A path that is not there falls through to the bottom, which rejects as the engine does.
  on('fs.read', (_$, e, next) => count('fs.read', () => {
    const text = files.get(resolve(norm(e.path)))
    return text === undefined ? next(e) : ({ value: text } as never)
  }))
  on('fs.list', (_$, e, next) => count('fs.list', () => {
    const list = dirs.get(resolve(norm(e.path)))
    return list === undefined ? next(e) : ({ value: list } as never)
  }))
  on('fs.stat', (_$, e, next) => count('fs.stat', () => {
    const path = norm(e.path)
    const real = resolve(path)
    const kind = dirs.has(real) ? 'dir' : files.has(real) ? 'file' : undefined
    return kind === undefined ? next(e) : ({ value: { kind, size: 0, mtimeMs: 0, isLink: links.has(path), realPath: real } } as never)
  }))
  on('tool.register', (_$, e) => count('tool.register', () => {
    tools.set(e.name, e.description)
    return { value: undefined } as never
  }))
  on('tool.list', () => count('tool.list', () => ({ value: [...tools].map(([name, description]) => ({ name: `mcp__agent-graph__${name}`, description, mcp: true })) }) as never))
  on('command.register', () => count('command.register', () => ({ value: undefined }) as never))
  on('ui.open', () => count('ui.open', () => ({ value: { isPlaced: true } }) as never))
  on('ui.toast', () => count('ui.toast', () => ({ value: undefined }) as never))
  on('clock.now', () => count('clock.now', () => ({ value: 1_000 }) as never))
  // What core answers beneath the mod's own hooks; not engine calls of the mod.
  on('session.start', () => ({ cwd: '/work' }))
  on('command.run', () => ({ text: '' }) as never)

  const start = await phase(() => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true }))
  let pane: Mounted<'terminal', 'Pane'> | undefined
  const firstOpen = await phase(async () => {
    await $.command.run({ command: 'agent-graph', args: '' } as never)
    pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  })
  const secondOpen = await phase(async () => {
    await $.command.run({ command: 'agent-graph', args: '' } as never)
    // An empty post settles once the pane has drawn again what the command changed.
    await pane!.post({ events: [] })
  })
  await pane!.post({ events: [{ kind: 'key', key: 'tab' }] })
  const nudges = await phase(async () => {
    for (let i = 0; i < 5; i++) await pane!.post({ events: [{ kind: 'key', key: 'right' }] })
  })
  await pane!.unmount()

  // After the change: the session start is the load (no skills scan), its graph reads side by side; a fresh
  // module registers every tool once, then sweeps against tool.list, then reads the run, graph and ui atoms.
  expect(start).toEqual({
    calls: { 'command.register': 1, 'env.get': 1, 'fs.list': 1, 'store.get': 7, 'state.get': 4, 'state.set': 1, 'tool.register': 8, 'tool.list': 1 },
    rounds: 16,
  })
  // The command (the load, which opens the first graph, with the skills scan alongside: 66 linked skills are now
  // stat-ed and found), then the pane's first draw.
  expect(firstOpen).toEqual({
    calls: { 'env.get': 1, 'fs.exists': 88, 'fs.read': 12, 'fs.list': 3, 'fs.stat': 67, 'store.get': 8, 'state.get': 15, 'state.set': 5, 'tool.list': 1, 'ui.open': 1, 'clock.now': 1 },
    rounds: 31,
  })
  // The load again, with nothing to register, and the open graph's instructions read again.
  expect(secondOpen).toEqual({
    calls: { 'env.get': 1, 'fs.exists': 86, 'fs.read': 10, 'fs.list': 3, 'fs.stat': 67, 'store.get': 7, 'state.get': 12, 'state.set': 2, 'tool.list': 1, 'ui.open': 1, 'clock.now': 2 },
    rounds: 24,
  })
  // Each nudge saves the graph and reads the index again; its run tool is unchanged, so nothing is registered.
  expect(nudges).toEqual({
    calls: { 'env.get': 5, 'store.get': 10, 'store.set': 10, 'state.get': 50, 'state.set': 10, 'clock.now': 15 },
    rounds: 100,
  })
})
