import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph } from '../types'
import { DEFAULT_RETRIES, LAYOUT, connect, endNodes, emptyGraph, freeSpot, isCheck, isDelegateOnly, loopContaining, loopOf, nextKind, retryOut, retype, reverse, runStart, startNodes, subgraphFrom, upgradeLayout, validate, warningsOf, withoutDisabled, withoutNode, INSTRUCTIONS_TEMPLATE } from '../hooks/model'

const node = (id: string, name = id, tools: string[] = []): AgentNode => ({
  id, name, x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools, model: null, budgetUsd: 2,
})
const graph = (over: Partial<Graph> = {}): Graph => ({
  id: 'g', name: 'G', description: '', backend: 'local', nodes: [node('a'), node('b'), node('c')], edges: [], ...over,
})
const messages = (g: Graph) => validate(g).map(p => p.message)

test('a handoff chain is valid and has one start and one end', async () => {
  const g = connect(connect(graph(), 'a', 'b', 'handoff'), 'b', 'c', 'handoff')
  expect(validate(g)).toEqual([])
  expect(startNodes(g).map(n => n.id)).toEqual(['a'])
  expect(endNodes(g).map(n => n.id)).toEqual(['c'])
})

test('connect ignores an exact duplicate', async () => {
  const g = connect(connect(graph(), 'a', 'b', 'handoff'), 'a', 'b', 'handoff')
  expect(g.edges).toHaveLength(1)
})

test('names must be present and unique', async () => {
  const g = graph({ nodes: [node('a', ''), node('b', 'Same'), node('c', 'same')] })
  expect(messages(g)).toContain('Give this agent a name.')
  expect(messages(g).filter(m => m.startsWith('Another agent is also called'))).toHaveLength(2)
})

test('an empty graph cannot run', async () => {
  expect(messages(graph({ nodes: [] }))).toContain('Add at least one agent.')
})

test('handoff cycles are rejected but delegate cycles are not', async () => {
  const cyclic = connect(connect(graph(), 'a', 'b', 'handoff'), 'b', 'a', 'handoff')
  expect(validate(cyclic).filter(p => p.message.startsWith('Handoff arrows form a loop'))).toHaveLength(2)
  const delegating = connect(connect(graph(), 'a', 'b', 'delegate'), 'b', 'a', 'delegate')
  expect(messages(delegating).some(m => m.startsWith('Handoff arrows form a loop'))).toBe(false)
})

test('self, dangling and duplicate edges are rejected', async () => {
  const g = graph({
    edges: [
      { id: 'e1', from: 'a', to: 'a', kind: 'handoff' },
      { id: 'e2', from: 'a', to: 'zz', kind: 'handoff' },
      { id: 'e3', from: 'a', to: 'b', kind: 'delegate' },
      { id: 'e4', from: 'a', to: 'b', kind: 'delegate' },
    ],
  })
  expect(messages(g)).toContain('An agent cannot connect to itself.')
  expect(messages(g)).toContain('This arrow points to an agent that no longer exists.')
  expect(messages(g)).toContain('This arrow is a duplicate.')
})

test('a node reached only by delegation does not start or end a run', async () => {
  const g = connect(connect(graph(), 'a', 'b', 'handoff'), 'b', 'c', 'delegate')
  expect(isDelegateOnly(g, 'c')).toBe(true)
  expect(startNodes(g).map(n => n.id)).toEqual(['a'])
  expect(endNodes(g).map(n => n.id)).toEqual(['b'])
})

test('a graph whose agents are all delegate-only has no start node, unless a handoff loop explains it', async () => {
  const delegating = connect(connect(graph({ nodes: [node('a'), node('b')] }), 'a', 'b', 'delegate'), 'b', 'a', 'delegate')
  expect(startNodes(delegating)).toEqual([])
  expect(validate(delegating)).toEqual([{ target: { kind: 'graph' }, message: 'No agent can start the run: every agent is only reached by delegation.' }])
  const looping = connect(connect(graph({ nodes: [node('a'), node('b')] }), 'a', 'b', 'handoff'), 'b', 'a', 'handoff')
  expect(messages(looping).some(m => m.startsWith('No agent can start'))).toBe(false)
  expect(messages(graph({ nodes: [] })).some(m => m.startsWith('No agent can start'))).toBe(false)
})

test('cloud tool names are looked up as own keys only', async () => {
  const g = graph({ backend: 'cloud', nodes: [node('a', 'a', ['constructor', 'toString'])] })
  expect(messages(g)).toContain('On Cloud, these tools are not available: constructor, toString.')
})

test('cloud graphs allow one level of delegation and cloud tools only', async () => {
  const chain = connect(connect(graph({ backend: 'cloud' }), 'a', 'b', 'delegate'), 'b', 'c', 'delegate')
  expect(messages(chain)).toContain('On Cloud, an agent that is delegated to cannot delegate further (one level only).')
  const tools = graph({ backend: 'cloud', nodes: [node('a', 'a', ['Read', 'PowerShell'])] })
  expect(messages(tools)).toContain('On Cloud, these tools are not available: PowerShell.')
  expect(validate({ ...tools, backend: 'local' })).toEqual([])
})

test('removing a node removes its edges', async () => {
  const g = withoutNode(connect(graph(), 'a', 'b', 'handoff'), 'b')
  expect(g.nodes.map(n => n.id)).toEqual(['a', 'c'])
  expect(g.edges).toEqual([])
})

test('freeSpot finds a place that overlaps no node', async () => {
  const g = graph({ nodes: [{ ...node('a'), x: 2, y: 1 }] })
  const spot = freeSpot(g)
  expect(spot).toEqual({ x: 34, y: 1 })
})

test('freeSpot skips slots that a node off the grid only partly overlaps', async () => {
  const g = graph({ nodes: [{ ...node('a'), x: 20, y: 3 }] })
  expect(freeSpot(g)).toEqual({ x: 2, y: 15 })
})

test('freeSpot uses two columns, so a new card stays inside an 80-column canvas', async () => {
  const g = graph({ nodes: [{ ...node('a'), x: 2, y: 1 }, { ...node('b'), x: 34, y: 1 }] })
  expect(freeSpot(g)).toEqual({ x: 2, y: 8 })
})

test('graphs saved with the old boxes are spread once for the cards', async () => {
  const old = graph({ nodes: [{ ...node('a'), x: 2, y: 1 }, { ...node('b'), x: 26, y: 6 }] })
  const up = upgradeLayout(old)
  expect(up.layout).toBe(LAYOUT)
  expect(up.nodes.map(n => [n.x, n.y])).toEqual([[3, 2], [39, 12]])
  expect(upgradeLayout(up)).toBe(up)
  expect(emptyGraph('X').layout).toBe(LAYOUT)
})

test('subgraphFrom keeps the node and everything downstream of it', async () => {
  let g = graph({ nodes: [node('a'), node('b'), node('c'), node('d')] })
  g = connect(connect(connect(g, 'a', 'b', 'handoff'), 'b', 'c', 'handoff'), 'b', 'd', 'delegate')
  const sub = subgraphFrom(g, 'b')
  expect(sub.id).toBe(g.id)
  expect(sub.name).toBe(g.name)
  expect(sub.nodes.map(n => n.id)).toEqual(['b', 'c', 'd'])
  expect(sub.edges.map(e => `${e.from}>${e.to}`)).toEqual(['b>c', 'b>d'])
  expect(subgraphFrom(g, 'missing').nodes).toEqual([])
})

test('reverse flips an arrow, or merges it into the arrow it would duplicate', async () => {
  const g = connect(graph(), 'a', 'b', 'handoff')
  const id = g.edges[0]!.id
  expect(reverse(g, id).edges).toEqual([{ id, from: 'b', to: 'a', kind: 'handoff' }])
  const both = connect(g, 'b', 'a', 'handoff')
  expect(reverse(both, id).edges.map(e => `${e.from}>${e.to}`)).toEqual(['b>a'])
  expect(reverse(g, 'missing')).toBe(g)
})

test('retype drops the arrow when the retyped one already exists', async () => {
  const g = graph({ edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }, { id: 'e2', from: 'a', to: 'b', kind: 'delegate' }] })
  expect(retype(g, 'e1', 'delegate').edges).toEqual([{ id: 'e2', from: 'a', to: 'b', kind: 'delegate' }])
  expect(retype(g, 'e2', 'delegate')).toEqual(g)
  const lone = graph({ edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }] })
  expect(retype(lone, 'e1', 'delegate').edges).toEqual([{ id: 'e1', from: 'a', to: 'b', kind: 'delegate' }])
})

const pairs = (g: Graph) => g.edges.map(e => `${e.from}>${e.to}:${e.kind}`).sort()
const off = (g: Graph, ...ids: string[]): Graph => ({ ...g, nodes: g.nodes.map(n => (ids.includes(n.id) ? { ...n, disabled: true } : n)) })

test('a disabled agent is passed over: its predecessors hand off to its successors', async () => {
  const g = off(connect(connect(graph(), 'a', 'b', 'handoff'), 'b', 'c', 'handoff'), 'b')
  const run = withoutDisabled(g)
  expect(run.nodes.map(n => n.id)).toEqual(['a', 'c'])
  expect(pairs(run)).toEqual(['a>c:handoff'])
  expect(validate(run)).toEqual([])
})

test('chains of disabled agents are passed over, and joins are not duplicated', async () => {
  let g = graph({ nodes: [node('a'), node('b'), node('c'), node('d')] })
  g = connect(connect(connect(connect(g, 'a', 'b', 'handoff'), 'b', 'c', 'handoff'), 'c', 'd', 'handoff'), 'a', 'd', 'handoff')
  expect(pairs(withoutDisabled(off(g, 'b', 'c')))).toEqual(['a>d:handoff'])
})

test('delegate arrows touching a disabled agent are dropped', async () => {
  const g = off(connect(connect(graph(), 'a', 'b', 'delegate'), 'c', 'a', 'delegate'), 'b')
  const run = withoutDisabled(g)
  expect(pairs(run)).toEqual(['c>a:delegate'])
  expect(run.nodes.map(n => n.id)).toEqual(['a', 'c'])
})

test('a graph with nothing disabled is unchanged', async () => {
  const g = connect(connect(graph(), 'a', 'b', 'handoff'), 'a', 'c', 'delegate')
  expect(withoutDisabled(g)).toEqual(g)
})

test('a fan-in and fan-out through a disabled agent joins every pair', async () => {
  let g = graph({ nodes: [node('a'), node('b'), node('x'), node('c'), node('d')] })
  g = connect(connect(connect(connect(g, 'a', 'x', 'handoff'), 'b', 'x', 'handoff'), 'x', 'c', 'handoff'), 'x', 'd', 'handoff')
  expect(pairs(withoutDisabled(off(g, 'x')))).toEqual(['a>c:handoff', 'a>d:handoff', 'b>c:handoff', 'b>d:handoff'])
})

test('warnings: a delegate target without a when-to-use, and starter instructions', async () => {
  const g = connect(graph(), 'a', 'b', 'delegate')
  const written = (n: AgentNode) => `${n.name} does real work.`
  expect(warningsOf(g, written).map(w => w.target)).toEqual([{ kind: 'node', id: 'b' }])
  expect(warningsOf({ ...g, nodes: g.nodes.map(n => (n.id === 'b' ? { ...n, whenToUse: ' Use for X ' } : n)) }, written)).toEqual([])
  const starter = warningsOf(graph(), n => (n.id === 'c' ? `  ${INSTRUCTIONS_TEMPLATE('c')}\n\n` : written(n)))
  expect(starter.map(w => w.target)).toEqual([{ kind: 'node', id: 'c' }])
  expect(starter[0]!.message).toContain('starter template')
  expect(warningsOf(graph(), () => undefined)).toEqual([])
})

test('the starter-template warning ignores renames, and a real edit clears it', async () => {
  const renamed = { ...graph(), nodes: graph().nodes.map(n => (n.id === 'c' ? { ...n, name: 'Researcher' } : n)) }
  const old = INSTRUCTIONS_TEMPLATE('Agent 3')
  const found = warningsOf(renamed, n => (n.id === 'c' ? old : 'Real instructions.'))
  expect(found.map(w => w.target)).toEqual([{ kind: 'node', id: 'c' }])
  expect(warningsOf(renamed, n => (n.id === 'c' ? `${old}More.` : 'Real instructions.'))).toEqual([])
  expect(warningsOf(renamed, n => (n.id === 'c' ? 'You are a careful reviewer.' : 'Real instructions.'))).toEqual([])
})

test('a helper whose only delegator is disabled is dropped, with the helpers it alone delegated to', async () => {
  let g = graph({ nodes: [node('a'), node('x'), node('d'), node('c'), node('e')] })
  g = connect(connect(connect(connect(connect(g, 'a', 'x', 'handoff'), 'x', 'd', 'handoff'), 'x', 'c', 'delegate'), 'c', 'e', 'delegate'), 'a', 'c', 'delegate')
  // c is also delegated to by the live a, so it stays (and so does e).
  expect(withoutDisabled(off(g, 'x')).nodes.map(n => n.id)).toEqual(['a', 'd', 'c', 'e'])
  const solo = connect(connect(connect(connect(graph({ nodes: [node('a'), node('x'), node('d'), node('c'), node('e')] }), 'a', 'x', 'handoff'), 'x', 'd', 'handoff'), 'x', 'c', 'delegate'), 'c', 'e', 'delegate')
  const run = withoutDisabled(off(solo, 'x'))
  expect(run.nodes.map(n => n.id)).toEqual(['a', 'd'])
  expect(pairs(run)).toEqual(['a>d:handoff'])
})

test('a disabled start or end agent just leaves the chain shorter', async () => {
  const chain = connect(connect(graph(), 'a', 'b', 'handoff'), 'b', 'c', 'handoff')
  const noStart = withoutDisabled(off(chain, 'a'))
  expect(noStart.nodes.map(n => n.id)).toEqual(['b', 'c'])
  expect(pairs(noStart)).toEqual(['b>c:handoff'])
  const noEnd = withoutDisabled(off(chain, 'c'))
  expect(noEnd.nodes.map(n => n.id)).toEqual(['a', 'b'])
  expect(pairs(noEnd)).toEqual(['a>b:handoff'])
})

// Check cards and retry arrows.
const check = (id: string, command = 'npm test'): AgentNode => ({ ...node(id), instructionsFile: '', check: { command, timeoutMin: 10 } })
const chainOf = (nodes: AgentNode[], over: Partial<Graph> = {}): Graph =>
  nodes.slice(1).reduce((g, n, i) => connect(g, nodes[i]!.id, n.id, 'handoff'), graph({ nodes, ...over }))
const retryEdge = (g: Graph, from: string, to: string) => g.edges.find(e => e.kind === 'retry' && e.from === from && e.to === to)!
const loopIds = (g: Graph, from: string, to: string) => [...loopOf(g, retryEdge(g, from, to))].sort()
const kinds = (x: Graph) => x.edges.map(e => `${e.from}>${e.to}:${e.kind}`)

test('isCheck is true only for a node with a check', async () => {
  expect(isCheck(check('k'))).toBe(true)
  expect(isCheck(node('a'))).toBe(false)
  expect(isCheck(undefined)).toBe(false)
})

test('connect gives a retry arrow the default retries, and handoffs none', async () => {
  const g = connect(connect(graph(), 'a', 'b', 'handoff'), 'b', 'a', 'retry')
  expect(g.edges.find(e => e.kind === 'retry')!.retries).toBe(DEFAULT_RETRIES)
  expect(g.edges.find(e => e.kind === 'handoff')).not.toHaveProperty('retries')
  expect(connect(g, 'b', 'a', 'retry').edges).toHaveLength(2)
})

test('a retry loop that returns to an agent which hands on to the judge is valid', async () => {
  const g = connect(chainOf([node('a'), node('b'), node('c')]), 'c', 'a', 'retry')
  expect(validate(g)).toEqual([])
  expect(startNodes(g).map(n => n.id)).toEqual(['a'])
  expect(endNodes(g).map(n => n.id)).toEqual(['c'])
  const withCheck = connect(chainOf([node('a'), node('b'), check('k')]), 'k', 'b', 'retry')
  expect(validate(withCheck)).toEqual([])
})

test('retryOut finds the arrow that leaves a card', async () => {
  const g = connect(chainOf([node('a'), node('b')]), 'b', 'a', 'retry')
  expect(retryOut(g, 'b')?.to).toBe('a')
  expect(retryOut(g, 'a')).toBeUndefined()
})

test('loopOf holds the target, the judge and the cards between them on a three-card chain', async () => {
  const g = connect(chainOf([node('a'), node('b'), node('c')]), 'c', 'a', 'retry')
  expect(loopIds(g, 'c', 'a')).toEqual(['a', 'b', 'c'])
  const inner = connect(chainOf([node('a'), node('b'), node('c')]), 'c', 'b', 'retry')
  expect(loopIds(inner, 'c', 'b')).toEqual(['b', 'c'])
})

test('loopOf on a diamond holds both branches, and leaves out cards before the target', async () => {
  let g = graph({ nodes: [node('s'), node('a'), node('b'), node('c'), node('d'), node('z')] })
  for (const [from, to] of [['s', 'a'], ['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['d', 'z']] as const) g = connect(g, from, to, 'handoff')
  g = connect(g, 'd', 'a', 'retry')
  expect(loopIds(g, 'd', 'a')).toEqual(['a', 'b', 'c', 'd'])
  expect(validate(g)).toEqual([])
  expect(loopContaining(g, 'b')?.from).toBe('d')
  expect(loopContaining(g, 's')).toBeUndefined()
  expect(loopContaining(g, 'z')).toBeUndefined()
})

test('a retry arrow must point back to an agent that hands work on to its judge', async () => {
  const forward = connect(chainOf([node('a'), node('b')]), 'a', 'b', 'retry')
  expect(validate(forward)).toEqual([{ target: { kind: 'edge', id: retryEdge(forward, 'a', 'b').id }, message: 'A retry arrow must point back to an agent that hands work on to this card.' }])
  const unrelated = connect(connect(graph(), 'a', 'b', 'handoff'), 'b', 'c', 'retry')
  expect(messages(unrelated)).toEqual(['A retry arrow must point back to an agent that hands work on to this card.'])
  const self = connect(graph(), 'a', 'a', 'retry')
  expect(messages(self)).toContain('A retry arrow must point back to an agent that hands work on to this card.')
  // Delegating is not handing on.
  const delegating = connect(connect(graph(), 'a', 'b', 'delegate'), 'b', 'a', 'retry')
  expect(messages(delegating)).toContain('A retry arrow must point back to an agent that hands work on to this card.')
})

test('a retry arrow cannot point to a check', async () => {
  const g = connect(chainOf([check('k'), node('b')]), 'b', 'k', 'retry')
  expect(validate(g)).toEqual([{ target: { kind: 'edge', id: retryEdge(g, 'b', 'k').id }, message: 'A retry arrow must point to an agent, not a check.' }])
})

test('only one retry arrow can leave a card', async () => {
  const g = connect(connect(chainOf([node('a'), node('b'), node('c')]), 'c', 'b', 'retry'), 'c', 'a', 'retry')
  expect(validate(g).filter(p => p.message === 'Only one retry arrow can leave a card.')).toEqual([{ target: { kind: 'node', id: 'c' }, message: 'Only one retry arrow can leave a card.' }])
  expect(messages(connect(chainOf([node('a'), node('b'), node('c')]), 'c', 'b', 'retry'))).toEqual([])
})

test("retry loops can't overlap", async () => {
  const overlap = connect(connect(chainOf([node('a'), node('b'), node('c')]), 'b', 'a', 'retry'), 'c', 'b', 'retry')
  expect(validate(overlap).filter(p => p.message === "Retry loops can't overlap.").map(p => p.target)).toEqual([{ kind: 'node', id: 'b' }, { kind: 'node', id: 'c' }])
  // Side by side, loops share nothing.
  const apart = chainOf([node('a'), node('b'), node('c'), node('d'), node('e')])
  const separate = connect(connect(apart, 'b', 'a', 'retry'), 'e', 'd', 'retry')
  expect(messages(separate)).not.toContain("Retry loops can't overlap.")
  // A loop inside another shares its cards.
  const nested = connect(connect(apart, 'e', 'a', 'retry'), 'c', 'b', 'retry')
  expect(messages(nested)).toContain("Retry loops can't overlap.")
})

test('work cannot leave a retry loop before its check', async () => {
  let g = chainOf([node('a'), node('b'), node('c')])
  g = { ...connect(connect(g, 'b', 'x', 'handoff'), 'c', 'a', 'retry'), nodes: [...g.nodes, node('x', 'Exit')] }
  expect(validate(g)).toEqual([{ target: { kind: 'node', id: 'b' }, message: 'Work leaves this retry loop before its check: b hands off to Exit.' }])
  // The judge itself may hand on outside the loop.
  const ok = { ...connect(connect(chainOf([node('a'), node('b')]), 'b', 'x', 'handoff'), 'b', 'a', 'retry'), nodes: [node('a'), node('b'), node('x')] }
  expect(validate(ok)).toEqual([])
})

test('check cards need a Local graph', async () => {
  const cloud = graph({ backend: 'cloud', nodes: [check('k'), node('a')] })
  expect(validate(cloud)).toEqual([{ target: { kind: 'node', id: 'k' }, message: 'Check cards need a Local graph.' }])
  expect(messages(graph({ nodes: [check('k'), node('a')] }))).toEqual([])
  // Headless runs checks the way Local does.
  expect(messages(graph({ backend: 'headless', nodes: [check('k'), node('a')] }))).toEqual([])
})

test("Cloud's delegate and tool limits do not apply to a Headless graph", async () => {
  const chain = connect(connect(graph({ backend: 'headless' }), 'a', 'b', 'delegate'), 'b', 'c', 'delegate')
  expect(validate(chain)).toEqual([])
  const tools = graph({ backend: 'headless', nodes: [node('a', 'a', ['Read', 'PowerShell'])] })
  expect(validate(tools)).toEqual([])
})

test("a check card can't delegate or be delegated to", async () => {
  const to = connect(connect(graph({ nodes: [node('a'), check('k')] }), 'a', 'k', 'handoff'), 'a', 'k', 'delegate')
  expect(validate(to)).toEqual([{ target: { kind: 'node', id: 'k' }, message: "A check card can't delegate or be delegated to." }])
  const from = connect(graph({ nodes: [node('a'), check('k')] }), 'k', 'a', 'delegate')
  expect(messages(from)).toContain("A check card can't delegate or be delegated to.")
  expect(messages(connect(graph({ nodes: [node('a'), check('k')] }), 'a', 'k', 'handoff'))).toEqual([])
})

test('a check needs a command', async () => {
  expect(validate(graph({ nodes: [node('a'), check('k', '   ')] }))).toEqual([{ target: { kind: 'node', id: 'k' }, message: 'Give this check a command.' }])
  expect(messages(graph({ nodes: [node('a'), check('k', 'make')] }))).toEqual([])
})

test('handoff-cycle detection and start and end nodes ignore retry arrows', async () => {
  const g = connect(chainOf([node('a'), node('b')]), 'b', 'a', 'retry')
  expect(messages(g).some(m => m.startsWith('Handoff arrows form a loop'))).toBe(false)
  expect(startNodes(g).map(n => n.id)).toEqual(['a'])
  expect(endNodes(g).map(n => n.id)).toEqual(['b'])
  expect(isDelegateOnly(g, 'a')).toBe(false)
})

test('withoutDisabled drops a retry arrow whose judge or target is disabled, and keeps it otherwise', async () => {
  const g = connect(chainOf([node('a'), node('b'), node('c'), node('d')]), 'c', 'b', 'retry')
  expect(kinds(withoutDisabled(g))).toContain('c>b:retry')
  expect(kinds(withoutDisabled(off(g, 'c')))).toEqual(['a>b:handoff', 'b>d:handoff'])
  expect(kinds(withoutDisabled(off(g, 'b'))).some(k => k.endsWith(':retry'))).toBe(false)
  // A disabled card inside the loop is passed over and the arrow stays.
  const inside = connect(chainOf([node('a'), node('b'), node('c'), node('d')]), 'd', 'b', 'retry')
  const run = withoutDisabled(off(inside, 'c'))
  expect(kinds(run)).toContain('d>b:retry')
  expect(validate(run)).toEqual([])
  expect(withoutDisabled(inside)).toBe(inside)
})

test('retype cycles handoff, delegate, retry, handoff', async () => {
  expect([nextKind('handoff'), nextKind('delegate'), nextKind('retry')]).toEqual(['delegate', 'retry', 'handoff'])
  let g = connect(graph(), 'a', 'b', 'handoff')
  const id = g.edges[0]!.id
  g = retype(g, id, nextKind(g.edges[0]!.kind))
  expect(g.edges[0]).toMatchObject({ kind: 'delegate' })
  g = retype(g, id, nextKind(g.edges[0]!.kind))
  expect(g.edges[0]).toMatchObject({ kind: 'retry', retries: DEFAULT_RETRIES })
  g = retype({ ...g, edges: [{ ...g.edges[0]!, retries: 7 }] }, id, nextKind('retry'))
  expect(g.edges[0]).toEqual({ id, from: 'a', to: 'b', kind: 'handoff' })
})

test('warnings skip check cards', async () => {
  const g = connect(graph({ nodes: [node('a'), check('k')] }), 'a', 'k', 'handoff')
  expect(warningsOf(g, n => (n.check === undefined ? 'Real.' : INSTRUCTIONS_TEMPLATE('Check')))).toEqual([])
})

test('a retry arrow whose target does not hand work on to its judge makes no loop, so From here stays on the card', async () => {
  // a -> k -> x with a mistaken retry k -> x.
  const forward = connect(chainOf([node('a'), node('k'), node('x')]), 'k', 'x', 'retry')
  expect(loopIds(forward, 'k', 'x')).toEqual([])
  expect(loopContaining(forward, 'k')).toBeUndefined()
  expect(loopContaining(forward, 'x')).toBeUndefined()
  expect(['a', 'k', 'x'].map(id => runStart(forward, id))).toEqual(['a', 'k', 'x'])
  // An arrow back to its own card, and one to a card off the chain.
  const self = { ...chainOf([node('a'), node('k')]), edges: [...chainOf([node('a'), node('k')]).edges, { id: 'r', from: 'k', to: 'k', kind: 'retry' as const, retries: 3 }] }
  expect(loopIds(self, 'k', 'k')).toEqual([])
  expect(loopContaining(self, 'k')).toBeUndefined()
  const apart = connect(graph({ nodes: [node('a'), node('k'), node('z')] }), 'a', 'k', 'handoff')
  expect(loopContaining(connect(apart, 'k', 'z', 'retry'), 'z')).toBeUndefined()
  // A valid arrow still makes its loop.
  const valid = connect(chainOf([node('a'), node('k'), node('x')]), 'k', 'a', 'retry')
  expect(runStart(valid, 'k')).toBe('a')
})
