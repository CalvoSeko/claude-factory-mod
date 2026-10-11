import type { ActivityItem, AgentNode, Graph, NodeRecord, OutputFile, RunIndex, RunRecord, RunSummary, RunView } from '../types'
import { incoming, loopContaining, loopOf, nodeById, outgoing, retryOut, runnableNodes, runStart, subgraphFrom, withoutDisabled } from './model'
import { testName } from './tests'

export type StaleCause = 'task' | 'changed' | 'upstream' | 'never'

// Runs kept per graph (and as many test runs, counted apart), besides any run an agent's newest entry still lives in.
export const RUNS_KEPT = 20
// The largest record written as it is (the file system refuses a write over 4 MiB); a larger one is slimmed first.
export const RECORD_MAX_CHARS = 3_500_000

const TASK_LINE_MAX = 40

// 32-bit FNV-1a over the UTF-8 bytes, as 8 hex digits.
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// A hash of everything about an agent that shapes its output: its setup, what it
// receives from (not what it receives), and the agents it can call. Undefined when
// an instructions text it needs is not cached.
export function fingerprintOf(
  g: Graph,
  nodeId: string,
  instructions: (n: AgentNode) => string | undefined,
): string | undefined {
  const rg = withoutDisabled(g)
  const canonical = (id: string, visited: Set<string>): unknown | undefined => {
    const n = nodeById(rg, id)
    if (n === undefined) return undefined
    // A check card has no instructions: its command and timeout shape its output.
    if (n.check !== undefined) return { cmd: n.check.command, min: n.check.timeoutMin, p: incoming(rg, id, 'handoff').map(e => e.from).sort() }
    const text = instructions(n)
    if (text === undefined) return undefined
    const seen = new Set(visited).add(id)
    const helpers: unknown[] = []
    for (const target of [...new Set(outgoing(rg, id, 'delegate').map(e => e.to))].sort()) {
      const helper = nodeById(rg, target)
      if (helper === undefined) continue
      if (seen.has(target)) {
        helpers.push([target, helper.whenToUse ?? '', 'loop'])
        continue
      }
      const inner = canonical(target, seen)
      if (inner === undefined) return undefined
      helpers.push([target, helper.whenToUse ?? '', inner])
    }
    return {
      i: text,
      s: n.skills,
      t: n.tools,
      m: n.model,
      c: [...n.contextFiles].sort(),
      p: incoming(rg, id, 'handoff').map(e => e.from).sort(),
      d: helpers,
      // A retry arrow out makes it a reviewer: its system text gets the verdict section.
      ...(retryOut(rg, id) !== undefined ? { r: 1 } : {}),
    }
  }
  const body = canonical(nodeId, new Set())
  return body === undefined ? undefined : fnv1a(JSON.stringify(body))
}

// Why each agent that runs has no up-to-date saved output (agents that are up to date have no entry).
export function staleOf(
  g: Graph,
  index: RunIndex,
  task: string,
  instructions: (n: AgentNode) => string | undefined,
): Record<string, StaleCause> {
  if (index.runs.length === 0) return {}
  const rg = withoutDisabled(g)
  const agents = runnableNodes(rg)
  const causes: Record<string, StaleCause> = {}
  // A blank task box has no task to compare (and cannot be run).
  const hasTask = task.trim() !== ''
  for (const n of agents) {
    const saved = index.latest[n.id]
    if (hasTask && saved !== undefined && saved.task.trim() !== task.trim()) {
      causes[n.id] = 'task'
    } else if (saved === undefined || saved.status !== 'done') {
      causes[n.id] = 'never'
    } else {
      const current = fingerprintOf(rg, n.id, instructions)
      // Unknown on either side is not a change: no false marks.
      if (current !== undefined && saved.fingerprint !== '' && current !== saved.fingerprint) causes[n.id] = 'changed'
    }
  }
  // When an agent's saved output was made; a reused one keeps the time of the run that made it.
  const madeAt = (id: string) => {
    const saved = index.latest[id]
    return saved === undefined ? undefined : (saved.producedAt ?? saved.at)
  }
  // A predecessor whose output is newer than this agent's: it ran again since (on another branch's From here).
  const isNewer = (p: string, id: string) => {
    const [before, after] = [madeAt(id), madeAt(p)]
    return before !== undefined && after !== undefined && after > before
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const n of agents) {
      if (causes[n.id] !== undefined) continue
      if (incoming(rg, n.id, 'handoff').some(e => causes[e.from] !== undefined || isNewer(e.from, n.id))) {
        causes[n.id] = 'upstream'
        changed = true
      }
    }
  }
  return causes
}

// What "From here" runs, and what it takes from the saved outputs instead. Everything
// downstream runs; a handoff predecessor outside that is reused if it is up to date,
// and otherwise runs too, with its own predecessors judged the same way.
// On a card of a retry loop the plan starts at the loop's target, so the whole loop runs; with `exact` (a run with
// an edited input) it starts at the card itself, and the loop's other cards are reused from the saved run whether
// or not they are up to date (only one with no saved output runs).
// A judge never runs without its loop: when one runs, the rest of its loop runs or is reused, so the judge can still
// send work back. A loop card that cannot be reused runs, and so does every card of the loop after it. A reused loop
// card may be sent back and run again, so what it needs is planned too.
export function planFromHere(
  g: Graph,
  nodeId: string,
  stale: Record<string, StaleCause>,
  exact = false,
): { run: string[]; reuse: string[] } {
  const rg = withoutDisabled(g)
  if (nodeById(rg, nodeId) === undefined) return { run: [], reuse: [] }
  // A retry arrow does not carry the run on to its target: that is the loop sending work back.
  const run = exact
    ? subgraphFrom({ ...rg, edges: rg.edges.filter(e => e.kind !== 'retry') }, nodeId).nodes.map(n => n.id)
    : subgraphFrom(rg, runStart(rg, nodeId)).nodes.map(n => n.id)
  const inRun = new Set(run)
  const reuse: string[] = []
  // The cards whose predecessors are planned: those that run, and the reused cards of a loop whose judge runs.
  const queue = [...run]
  const walked = new Set<string>()
  // The loop of the card an edited input starts from: its cards, and what they need, are reused when they have a
  // saved output at all (the card was asked to run on what is there).
  const ownEdge = exact ? loopContaining(rg, nodeId) : undefined
  const lenient = new Set<string>()
  const reusable = (id: string, isLenient: boolean) => stale[id] === undefined || (isLenient && stale[id] !== 'never')
  const runIt = (id: string) => {
    const at = reuse.indexOf(id)
    if (at >= 0) reuse.splice(at, 1)
    inRun.add(id)
    run.push(id)
    // A reused loop card that has to run after all is planned again as one that runs.
    walked.delete(id)
    queue.push(id)
  }
  const keepLoopOf = (judge: string) => {
    const edge = retryOut(rg, judge)
    const loop = edge === undefined ? new Set<string>() : loopOf(rg, edge)
    if (edge === undefined || loop.size === 0) return
    const isOwn = edge.id === ownEdge?.id
    const after = [...loop].filter(id => !inRun.has(id) && !reusable(id, isOwn))
    for (let id = after.shift(); id !== undefined; id = after.shift()) {
      if (inRun.has(id)) continue
      runIt(id)
      after.push(...outgoing(rg, id, 'handoff').map(e => e.to).filter(to => loop.has(to) && !inRun.has(to)))
    }
    for (const id of loop) {
      if (inRun.has(id)) continue
      if (!reuse.includes(id)) reuse.push(id)
      if (isOwn) lenient.add(id)
      queue.push(id)
    }
  }
  // That loop first: the card's own predecessors in it are reused like the rest of it.
  if (ownEdge !== undefined && inRun.has(ownEdge.from)) keepLoopOf(ownEdge.from)
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (walked.has(id)) continue
    walked.add(id)
    if (inRun.has(id)) keepLoopOf(id)
    for (const p of incoming(rg, id, 'handoff').map(e => e.from)) {
      if (inRun.has(p) || reuse.includes(p) || nodeById(rg, p) === undefined) continue
      if (reusable(p, lenient.has(id))) reuse.push(p)
      else runIt(p)
    }
  }
  return { run, reuse }
}

// The graph to hand the runner: run and reused agents with the handoffs among them,
// delegate arrows only from agents that run, and the helpers those agents call.
export function graphForRun(g: Graph, plan: { run: string[]; reuse: string[] }): Graph {
  const rg = withoutDisabled(g)
  const keep = new Set([...plan.run, ...plan.reuse])
  const runs = new Set(plan.run)
  const queue = [...plan.run]
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const e of outgoing(rg, id, 'delegate')) {
      if (nodeById(rg, e.to) === undefined) continue
      if (!keep.has(e.to)) {
        keep.add(e.to)
        runs.add(e.to)
        queue.push(e.to)
      }
    }
  }
  return {
    ...rg,
    nodes: rg.nodes.filter(n => keep.has(n.id)),
    edges: rg.edges.filter(e => keep.has(e.from) && keep.has(e.to) && (e.kind === 'handoff' || runs.has(e.from))),
  }
}

const withoutPosition = ({ x: _x, y: _y, ...rest }: AgentNode): Omit<AgentNode, 'x' | 'y'> => rest

export function recordOf(
  g: Graph,
  view: RunView,
  meta: {
    id: string
    mode: RunRecord['mode']
    fromNode?: string
    testId?: string
    startedAt: number
    endedAt: number
    ending: RunRecord['ending']
    fingerprints: Record<string, string>
    files: Record<string, OutputFile[]>
  },
): RunRecord {
  const nodes: Record<string, NodeRecord> = {}
  for (const [id, v] of Object.entries(view.nodes)) {
    nodes[id] = {
      status: v.status,
      inputs: incoming(g, id, 'handoff').map(e => e.from),
      ...(v.output !== undefined ? { output: v.output } : {}),
      ...(v.error !== undefined ? { error: v.error } : {}),
      files: meta.files[id] ?? [],
      ...(v.costUsd !== undefined ? { costUsd: v.costUsd } : {}),
      ...(v.costEstimated === true ? { costEstimated: true } : {}),
      ...(v.startedAt !== undefined ? { startedAt: v.startedAt } : {}),
      ...(v.endedAt !== undefined ? { endedAt: v.endedAt } : {}),
      fingerprint: meta.fingerprints[id] ?? '',
      ...(v.reusedFrom !== undefined ? { reusedFrom: v.reusedFrom } : {}),
      ...(v.inputEdited === true ? { inputEdited: true } : {}),
      ...(v.prompt !== undefined ? { prompt: v.prompt } : {}),
      ...(v.calledBy !== undefined ? { calledBy: v.calledBy } : {}),
      ...(v.round !== undefined ? { round: v.round } : {}),
      ...(v.rounds !== undefined ? { rounds: v.rounds } : {}),
      ...(v.restarts !== undefined ? { restarts: v.restarts } : {}),
      // A helper's calls are kept once, under its callers' delegate calls (helperActivity finds them again).
      ...(v.calledBy === undefined && v.activity !== undefined && v.activity.length > 0 ? { activity: v.activity } : {}),
    }
  }
  return {
    id: meta.id,
    graphId: g.id,
    graphName: g.name,
    task: view.task ?? '',
    mode: meta.mode,
    ...(meta.fromNode !== undefined ? { fromNode: meta.fromNode } : {}),
    ...(meta.testId !== undefined ? { testId: meta.testId } : {}),
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    ending: meta.ending,
    graph: { nodes: g.nodes.map(withoutPosition), edges: g.edges },
    nodes,
    result: view.result ?? '',
    outputs: view.outputs ?? [],
  }
}

// A helper's calls, gathered from the delegate calls made to it under every entry's activity (however deep), in order.
export function helperActivity(nodes: Record<string, NodeRecord>, helperId: string): ActivityItem[] {
  const found: ActivityItem[] = []
  const walk = (items: ActivityItem[]) => {
    for (const item of items) {
      if (item.delegate === undefined) continue
      if (item.delegate.nodeId === helperId) found.push(...item.delegate.items)
      walk(item.delegate.items)
    }
  }
  for (const n of Object.values(nodes)) walk(n.activity ?? [])
  return found
}

// The record without any call's input, result or error (summaries, statuses and times stay); when even that is over
// `max` characters, without activity at all. A run's outputs are never lost to its activity.
export function slimmed(r: RunRecord, max = RECORD_MAX_CHARS): RunRecord {
  const bare = (items: ActivityItem[]): ActivityItem[] =>
    items.map(({ input: _i, result: _r, error: _e, ...item }) => (item.delegate === undefined ? item : { ...item, delegate: { ...item.delegate, items: bare(item.delegate.items) } }))
  const withNodes = (change: (n: NodeRecord) => NodeRecord): RunRecord => ({ ...r, nodes: Object.fromEntries(Object.entries(r.nodes).map(([id, n]) => [id, change(n)])) })
  const slim = withNodes(n => (n.activity === undefined ? n : { ...n, activity: bare(n.activity) }))
  if (JSON.stringify(slim).length <= max) return slim
  return withNodes(({ activity: _a, ...n }) => n)
}

export function summaryOf(r: RunRecord, g: Graph): RunSummary {
  return summarise(r, nodeById(g, r.fromNode ?? '')?.name)
}

function summarise(r: RunRecord, currentName: string | undefined): RunSummary {
  const line = r.task.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  const fromName = r.fromNode === undefined ? undefined : (currentName ?? r.graph.nodes.find(n => n.id === r.fromNode)?.name)
  return {
    id: r.id,
    at: r.endedAt,
    ending: r.ending,
    mode: r.mode,
    ...(fromName !== undefined ? { fromName } : {}),
    ...(r.mode === 'test' ? { testName: testName(r.task) } : {}),
    taskLine: line.length > TASK_LINE_MAX ? `${line.slice(0, TASK_LINE_MAX - 1)}…` : line,
    costUsd: Object.values(r.nodes).reduce((sum, n) => sum + (n.reusedFrom === undefined ? (n.costUsd ?? 0) : 0), 0),
    ...(Object.values(r.nodes).some(n => n.reusedFrom === undefined && n.costEstimated === true) ? { costEstimated: true } : {}),
  }
}

// The index after saving a record, and the ids of the runs whose files can go.
// A test run is listed but never becomes an agent's newest entry, so running tests leaves the cards and From here alone.
export function withRecord(index: RunIndex, r: RunRecord): { index: RunIndex; dropped: string[] } {
  const latest: RunIndex['latest'] = { ...index.latest }
  // A delegate helper (called by another agent) is not an agent that ran: it has no saved output to reuse.
  for (const [id, n] of r.mode === 'test' ? [] : Object.entries(r.nodes).filter(([, n]) => n.calledBy === undefined)) {
    // A reused entry keeps what its output was made from (a stale one reused by Run with input stays stale): only the pointer moves.
    const prev = latest[id]
    latest[id] = n.reusedFrom !== undefined && prev !== undefined
      ? { ...prev, runId: r.id, at: r.endedAt, status: n.status }
      : { runId: r.id, at: r.endedAt, producedAt: n.reusedFrom?.at ?? r.endedAt, fingerprint: n.fingerprint, task: r.task, status: n.status }
  }
  const all = [summarise(r, undefined), ...index.runs.filter(s => s.id !== r.id)]
  const named = new Set(Object.values(latest).map(l => l.runId))
  // Test runs are counted apart, so running the tests cannot push the person's own runs out (nor the other way round).
  const seen = { tests: 0, runs: 0 }
  const kept = all.filter(s => ++seen[s.mode === 'test' ? 'tests' : 'runs'] <= RUNS_KEPT || named.has(s.id))
  const keptIds = new Set(kept.map(s => s.id))
  return { index: { runs: kept, latest }, dropped: all.filter(s => !keptIds.has(s.id)).map(s => s.id) }
}
