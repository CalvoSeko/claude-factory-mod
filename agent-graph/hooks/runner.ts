import type { ActivityItem, AgentNode, Graph, NodeRunView, OutputFile, RestartEntry, RoundEntry, RunView } from '../types'
import { clip, STOPPED_TEXT, UNFINISHED_TEXT, type HelperCall, type Tracker } from './activity'
import { handoffNames } from './compile'
import { DEFAULT_RETRIES, endNodes, handoffDir, incoming, isCheck, isDelegateOnly, loopOf, MAX_RETRIES, nodeById, retryOut, runnableNodes, validate, type Problem } from './model'
import { MAX_RESTARTS, restartDelay, type Transient } from './transient'

export type Handoff = { from: string; text: string; files: OutputFile[] }
// `detail` (a fail only): what a check card printed last, for the feedback of a retry.
// `transient` (a fail only): the backend found it temporary (a limit, an overload, the network), so the agent is started again.
export type NodeOutcome = { ok: true; text: string; files: OutputFile[] } | { ok: false; reason: string; detail?: string; transient?: Transient }
export type NodeRun = { done: Promise<NodeOutcome>; stop(): Promise<void>; link?: string }

export type Backend = {
  prepare(graph: Graph): Promise<Problem[]>
  // `estimated`: this one report is an estimate (a later exact report may replace it).
  start(node: AgentNode, prompt: string, inputs: Handoff[], onCost: (usd: number, estimated?: boolean) => void): Promise<NodeRun>
  // Every cost it reports is an estimate (shown with ≈).
  estimatesCost?: true
}

// Agents that are not run: they start done with a saved output, as if they had just finished (with the calls they made then).
export type Seed = Record<string, { output: string; files: OutputFile[]; runId: string; at: number; startedAt?: number; endedAt?: number; costUsd?: number; costEstimated?: boolean; activity?: ActivityItem[] }>

export type RunResult = {
  result: string
  outputs: Record<string, string>
  failures: Record<string, string>
  // The end agents' files, and every agent's files by id.
  endFiles: OutputFile[]
  files: Record<string, OutputFile[]>
}

// `wait` lets a stop end nodes whose backend never confirms it (STOP_DEADLINE_MS
// after the abort); without it a stop waits for every node's own ending.
// `pauses` are the agents to stop before; `gate` is awaited with the prompt the agent is about to get and
// answers with the prompt it should get. Without a gate nothing pauses.
export type RunHooks = {
  onUpdate(view: RunView): void | Promise<void>
  signal?: AbortSignal
  wait?: (ms: number) => Promise<void>
  now?: () => number | Promise<number>
  gate?: (nodeId: string, prompt: string) => Promise<string>
  pauses?: ReadonlySet<string>
  // What the agents call: copied into the view as it changes, and published at most every ACTIVITY_PUBLISH_MS
  // (when `wait` and `now` are given; without them each change publishes at once).
  activity?: Tracker
}

export const MAX_PARALLEL = 4
export const STOP_DEADLINE_MS = 15_000
export const ACTIVITY_PUBLISH_MS = 250

const stopQuietly = (run: NodeRun) => Promise.resolve().then(() => run.stop()).catch(() => undefined)

// A failure the backend found temporary, that came without a stop having been asked for.
const restartable = (o: NodeOutcome, stoppedAtEnd: boolean): o is Extract<NodeOutcome, { ok: false }> & { transient: Transient } =>
  !o.ok && o.transient !== undefined && !stoppedAtEnd

// One received handoff as the next card is told of it (with its files when it has any).
export function handoffSection(g: Graph, input: Handoff): string {
  const name = nodeById(g, input.from)?.name ?? input.from
  let part = `## Handoff from ${name}\n\n${input.text}`
  if (input.files.length > 0) {
    part += `\n\nFiles from ${name} are at /workspace/handoff/${handoffDir(name, input.from)}/: ${handoffNames(input.files.map(f => f.name)).join(', ')}`
  }
  return part
}

export function promptFor(g: Graph, task: string, inputs: Handoff[]): string {
  return [task, ...inputs.map(input => handoffSection(g, input))].join('\n\n')
}

// How much of a check's output and of the target's last answer a retry's feedback carries.
export const FEEDBACK_CHARS = 4000
export const NOTE_MAX = 120

const lastChars = (text: string, n: number) => (text.length <= n ? text : text.slice(text.length - n))
const VERDICT_LINE = /^\s*VERDICT:\s*(pass|fail)\b/i
const linesOf = (text: string): string[] => text.split(/\r?\n/)

// A round's note: the first line of a failure, at most NOTE_MAX characters.
export const noteOf = (text: string): string => clip(linesOf(text).map(l => l.trim()).find(l => l !== '') ?? '', NOTE_MAX)

// A reviewer's verdict: the last line that reads `VERDICT: pass|fail`; without one the work fails.
export function verdictOf(answer: string): { passed: boolean; note: string } {
  const lines = linesOf(answer)
  let at = lines.length - 1
  while (at >= 0 && !VERDICT_LINE.test(lines[at]!)) at--
  if (at < 0) return { passed: false, note: 'No VERDICT line.' }
  if (VERDICT_LINE.exec(lines[at]!)![1]!.toLowerCase() === 'pass') return { passed: true, note: 'passed' }
  const reason = lines.find(l => l.trim() !== '' && !VERDICT_LINE.test(l))
  return { passed: false, note: reason === undefined ? 'Review failed.' : clip(reason.trim(), NOTE_MAX) }
}

// The last section of a retry target's next input: why its judge failed and what it answered last round.
export const feedbackText = (judge: string, n: number, retries: number, why: string, previous: string): string =>
  `## ${judge} failed (retry ${n} of ${retries})\n\n${why}\n\n## Your answer last round\n\n${lastChars(previous, FEEDBACK_CHARS)}\n\nFix what failed, then answer as before.`

// The reused agents that are never run. A reused agent in the loop of a judge that runs may be sent back and
// run again: it is validated and set up like any agent that runs (and the backend keeps the loop's retry arrow,
// which makes its judge a reviewer).
export function reusedNeverRun(g: Graph, reused: ReadonlySet<string>): Set<string> {
  const never = new Set(reused)
  for (const e of g.edges) {
    if (e.kind !== 'retry' || reused.has(e.from) || nodeById(g, e.from) === undefined || nodeById(g, e.to) === undefined) continue
    for (const id of loopOf(g, e)) never.delete(id)
  }
  return never
}

export function resultText(g: Graph, view: RunView): string {
  const sections = endNodes(g).flatMap(n => {
    const v = view.nodes[n.id]
    return v?.status === 'done' && v.output !== undefined ? [`## ${n.name}\n\n${v.output}`] : []
  })
  // A delegate helper that failed was the caller's to deal with: only agents that run are reported.
  const ran = g.nodes.filter(n => !isDelegateOnly(g, n.id))
  const failed = ran.flatMap(n => {
    const v = view.nodes[n.id]
    return v?.status === 'failed' ? [`- ${n.name}: ${v.error ?? 'failed'}`] : []
  })
  if (failed.length > 0) sections.push(`## Failed\n\n${failed.join('\n')}`)
  const stopped = ran.flatMap(n => (view.nodes[n.id]?.status === 'cancelled' ? [`- ${n.name}`] : []))
  if (stopped.length > 0) sections.push(`## Stopped\n\n${stopped.join('\n')}`)
  return sections.length > 0 ? sections.join('\n\n') : 'The run produced no output.'
}

// What the backend has to set up: the graph without the seeded agents, the arrows touching them,
// and the helpers that only they delegate to (their own helpers in turn).
function withoutSeeded(graph: Graph, seeded: Set<string>): Graph {
  if (seeded.size === 0) return graph
  const dropped = new Set(seeded)
  for (let changed = true; changed; ) {
    changed = false
    for (const n of graph.nodes) {
      if (dropped.has(n.id) || !isDelegateOnly(graph, n.id)) continue
      const delegators = incoming(graph, n.id, 'delegate').map(e => e.from)
      if (delegators.every(d => dropped.has(d))) {
        dropped.add(n.id)
        changed = true
      }
    }
  }
  // A reused agent that an agent which runs delegates to is still a helper of that agent:
  // the backend registers it (it is not run), together with the helpers only it delegated to.
  const rescued = new Set<string>()
  for (let changed = true; changed; ) {
    changed = false
    for (const e of graph.edges) {
      if (e.kind !== 'delegate' || dropped.has(e.from) || !dropped.has(e.to)) continue
      dropped.delete(e.to)
      rescued.add(e.to)
      changed = true
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.filter(n => !dropped.has(n.id)),
    // A rescued agent keeps only its delegate arrows: its handoffs were done in the run it is reused from.
    edges: graph.edges.filter(
      e => !dropped.has(e.from) && !dropped.has(e.to) && (e.kind === 'delegate' || (!rescued.has(e.from) && !rescued.has(e.to))),
    ),
  }
}

export async function runGraph(
  graph: Graph,
  task: string,
  backend: Backend,
  hooks: RunHooks,
  seed: Seed = {},
  prompts: Record<string, string> = {},
): Promise<RunResult | { problems: Problem[] }> {
  const runnable = runnableNodes(graph)
  const seeded = new Set(runnable.filter(n => seed[n.id] !== undefined).map(n => n.id))
  // A reused agent that is never run: what is wrong with it does not matter, and the backend need not set it up.
  const neverRun = reusedNeverRun(graph, seeded)
  const invalid = validate(graph).filter(p => !(p.target.kind === 'node' && neverRun.has(p.target.id)))
  if (invalid.length > 0) return { problems: invalid }
  const prepared = await backend.prepare(withoutSeeded(graph, neverRun))
  if (prepared.length > 0) return { problems: prepared }

  const view: RunView = {
    graphId: graph.id,
    graphName: graph.name,
    isRunning: true,
    task,
    nodes: Object.fromEntries(runnable.map(n => [n.id, { status: 'waiting' } as NodeRunView])),
  }
  const files: Record<string, OutputFile[]> = {}
  // What a failed check card printed last, by node: the retry feedback is built from it.
  const details = new Map<string, string>()
  // What each card has cost in this run, all its rounds together (each start reports its own running total),
  // and the feedback section a retry target's next input ends with.
  const spent = new Map<string, number>()
  const feedback = new Map<string, string>()
  // How many times each card was started again after a temporary failure, all its rounds together.
  const restarts = new Map<string, number>()
  for (const n of runnable) {
    const saved = seed[n.id]
    if (saved === undefined) continue
    view.nodes[n.id] = {
      status: 'done',
      output: saved.output,
      reusedFrom: { runId: saved.runId, at: saved.at },
      ...(saved.startedAt !== undefined ? { startedAt: saved.startedAt } : {}),
      ...(saved.endedAt !== undefined ? { endedAt: saved.endedAt } : {}),
      ...(saved.costUsd !== undefined ? { costUsd: saved.costUsd } : {}),
      ...(saved.costEstimated === true ? { costEstimated: true } : {}),
      ...(saved.activity !== undefined && saved.activity.length > 0 ? { activity: saved.activity } : {}),
    }
    files[n.id] = saved.files
  }
  const runs = new Map<string, NodeRun>()
  const inFlight = new Set<Promise<void>>()
  let isStopped = hooks.signal?.aborted ?? false
  // What an agent the stop ended shows as its error: a string abort reason says why (a cap), a plain Stop is "Stopped.".
  const stopText = (): string => {
    const reason: unknown = hooks.signal?.reason
    return typeof reason === 'string' && reason !== '' ? reason : STOPPED_TEXT
  }

  // The view is only for display: a callback that fails must not fail the run.
  // Once the run is over nothing more is published: a backend that is still winding down (a stop
  // released its node early) must not overwrite whatever view has replaced this run's.
  let closed = false
  const publish = async () => {
    if (closed) return
    try {
      await hooks.onUpdate(JSON.parse(JSON.stringify(view)) as RunView)
    } catch {
      // Nothing to do about it here.
    }
  }

  // What the tracker knows about the agents goes into the view: each agent's calls and current call,
  // and an entry for each delegate helper that has been called (it is not run, so only the calls make it).
  const tracker = hooks.activity
  const syncAgent = (id: string) => {
    const v = view.nodes[id]
    if (tracker === undefined || v === undefined) return
    const items = tracker.itemsOf(id)
    if (items.length > 0) v.activity = items
    const current = v.status === 'running' ? tracker.currentOf(id) : undefined
    if (current !== undefined) v.current = current
    else delete v.current
  }
  const syncHelpers = () => {
    if (tracker === undefined) return
    const merged = new Map<string, HelperCall>()
    for (const n of runnable) {
      for (const h of tracker.helpersOf(n.id)) {
        if (nodeById(graph, h.nodeId) === undefined || !isDelegateOnly(graph, h.nodeId)) continue
        const prev = merged.get(h.nodeId)
        merged.set(
          h.nodeId,
          prev === undefined
            ? h
            : {
                ...h,
                status: prev.status === 'running' || h.status === 'running' ? 'running' : h.status,
                startedAt: Math.min(prev.startedAt, h.startedAt),
                ...(prev.endedAt !== undefined && h.endedAt !== undefined ? { endedAt: Math.max(prev.endedAt, h.endedAt) } : {}),
                items: [...prev.items, ...h.items],
                ...(h.current === undefined && prev.current !== undefined ? { current: prev.current } : {}),
              },
        )
      }
    }
    for (const [id, h] of merged) {
      view.nodes[id] = {
        status: h.status,
        calledBy: h.calledBy,
        startedAt: h.startedAt,
        ...(h.status !== 'running' && h.endedAt !== undefined ? { endedAt: h.endedAt } : {}),
        ...((h.status === 'failed' || h.status === 'cancelled') && h.error !== undefined ? { error: h.error } : {}),
        ...(h.items.length > 0 ? { activity: h.items } : {}),
        ...(h.status === 'running' && h.current !== undefined ? { current: h.current } : {}),
      }
    }
  }

  // Changes come in bursts: the first publishes at once, the rest wait for the end of the 250 ms and go
  // out together. A publish that was waiting never goes out once the run is over.
  let lastActivityAt = -Infinity
  let scheduled = false
  const publishActivity = async () => {
    if (closed) return
    const { now, wait } = hooks
    if (now === undefined || wait === undefined) return publish()
    if (scheduled) return
    scheduled = true
    try {
      const left = lastActivityAt + ACTIVITY_PUBLISH_MS - (await now())
      if (left > 0) await wait(left)
      lastActivityAt = await now()
    } catch {
      // The timing is only for display: publish anyway.
    }
    scheduled = false
    return publish()
  }
  let unsubscribe: (() => void) | undefined
  try {
    unsubscribe = tracker?.subscribe(nodeId => {
      if (closed) return
      try {
        syncAgent(nodeId)
        syncHelpers()
      } catch {
        // Activity is only for display.
      }
      void publishActivity().catch(() => undefined)
    })
  } catch {
    // Without a subscription the view just has no activity.
  }

  const statusOf = (id: string) => view.nodes[id]?.status
  const predecessors = (id: string) => incoming(graph, id, 'handoff').map(e => e.from)

  // Settles once a stop has had STOP_DEADLINE_MS to take; each running node's
  // `done` races it, so a node that never confirms its stop cannot hold the run.
  let unconfirmed!: (outcome: NodeOutcome) => void
  const deadline = new Promise<NodeOutcome>(resolve => (unconfirmed = resolve))
  const startDeadline = () => {
    const wait = hooks.wait
    if (wait === undefined) return
    const settle = () => unconfirmed({ ok: false, reason: 'Stopped (not confirmed).' })
    Promise.resolve().then(() => wait(STOP_DEADLINE_MS)).then(settle, settle)
  }

  // Settles once a stop is asked for; a paused agent races its gate against it.
  let stopAsked!: () => void
  const stopping = new Promise<void>(resolve => (stopAsked = resolve))
  if (isStopped) stopAsked()

  // Each run is asked to stop once, whichever of the abort and the start's ending gets there first.
  const stopRequests = new Map<NodeRun, Promise<void>>()
  const requestStop = (run: NodeRun) => {
    let asked = stopRequests.get(run)
    if (asked === undefined) {
      asked = stopQuietly(run)
      stopRequests.set(run, asked)
    }
    return asked
  }
  const onAbort = () => {
    isStopped = true
    stopAsked()
    for (const run of runs.values()) void requestStop(run)
    startDeadline()
  }
  hooks.signal?.addEventListener('abort', onAbort)

  const skipBlocked = () => {
    for (let changed = true; changed; ) {
      changed = false
      for (const n of runnable) {
        const v = view.nodes[n.id]!
        if (v.status !== 'waiting') continue
        const blocked = predecessors(n.id).some(p => statusOf(p) === 'failed' || statusOf(p) === 'cancelled' || statusOf(p) === 'skipped')
        if (isStopped || blocked) {
          v.status = 'skipped'
          changed = true
        }
      }
    }
  }

  const gateFor = (node: AgentNode) => (hooks.gate !== undefined && hooks.pauses?.has(node.id) === true ? hooks.gate : undefined)

  // A judge (the card a retry arrow leaves) that has just ended: its round is recorded, and a fail with retries
  // left sends its loop back to `waiting` with feedback for the target. It runs at once when the judge's status
  // is set (before the scheduler looks again), so what follows the judge is not skipped for a fail that is retried.
  // A fail that is not retried never ends `done`: after a stop (a cap's included) it ends cancelled, else failed.
  // What it returns settles once the round's time is known.
  const judge = (node: AgentNode, v: NodeRunView): Promise<void> | undefined => {
    const edge = retryOut(graph, node.id)
    if (edge === undefined || view.nodes[node.id] !== v || view.nodes[edge.to] === undefined) return undefined
    if (v.status !== 'done' && v.status !== 'failed') return undefined
    const check = isCheck(node)
    const verdict =
      v.status === 'failed' ? { passed: false, note: noteOf(v.error ?? '') } : check ? { passed: true, note: 'passed' } : verdictOf(v.output ?? '')
    const round = v.round ?? 1
    const entry: RoundEntry = { round, passed: verdict.passed, note: verdict.note, at: Date.now() }
    v.rounds = [...(v.rounds ?? []), entry]
    let stamping: Promise<void> | undefined
    try {
      const at = hooks.now?.()
      if (typeof at === 'number') entry.at = at
      else if (at !== undefined) stamping = at.then(t => void (entry.at = t), () => undefined)
    } catch {
      // The time is only for display.
    }
    if (verdict.passed) return stamping
    // Stopped as it ended: nothing is sent back, and its answer is not one to hand on or reuse.
    if (isStopped) {
      if (v.status === 'done') {
        v.status = 'cancelled'
        v.error = stopText()
      }
      return stamping
    }
    const retries = Number.isInteger(edge.retries) && edge.retries! >= 0 ? Math.min(edge.retries!, MAX_RETRIES) : DEFAULT_RETRIES
    if (round - 1 >= retries) {
      v.status = 'failed'
      v.error = `Still failing after ${retries} retries: ${verdict.note}`
      return stamping
    }
    const n = round
    let why: string
    if (check) {
      const tail = (details.get(node.id) ?? '').slice(-FEEDBACK_CHARS).replace(/\s+$/, '')
      why = `${v.error ?? ''}${tail !== '' ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''}`
    } else {
      why = v.status === 'done' ? (v.output ?? '') : (v.error ?? '')
    }
    feedback.set(edge.to, feedbackText(node.name, n, retries, why, view.nodes[edge.to]!.output ?? ''))
    // Every card of the loop waits again: what it cost and called so far is kept (a reused card's belongs to
    // the run it came from), the rest is cleared and set again when it runs.
    for (const id of loopOf(graph, edge)) {
      const old = view.nodes[id]
      if (old === undefined) continue
      const own = old.reusedFrom === undefined
      if (!own) spent.delete(id)
      view.nodes[id] = {
        status: 'waiting',
        round: n + 1,
        ...(own && old.costUsd !== undefined ? { costUsd: old.costUsd } : {}),
        ...(own && old.costEstimated === true ? { costEstimated: true } : {}),
        ...(own && old.activity !== undefined ? { activity: old.activity } : {}),
        ...(old.rounds !== undefined ? { rounds: old.rounds } : {}),
        ...(old.restarts !== undefined ? { restarts: old.restarts } : {}),
      }
      delete files[id]
      details.delete(id)
    }
    return stamping
  }

  const launch = (node: AgentNode) => {
    const v = view.nodes[node.id]!
    const gate = gateFor(node)
    v.status = gate !== undefined ? 'paused' : 'running'
    const inputs: Handoff[] = predecessors(node.id).map(p => ({
      from: p,
      text: view.nodes[p]?.output ?? '',
      files: files[p] ?? [],
    }))
    const job = (async () => {
      let run: NodeRun | undefined
      // The node's end: when it ended, and the last view. Its calls still open end with it, one way for every view.
      const close = async () => {
        try {
          tracker?.endOpen(isStopped ? STOPPED_TEXT : UNFINISHED_TEXT, node.id)
          syncAgent(node.id)
        } catch {
          // Activity is only for display.
        }
        if (hooks.now !== undefined) {
          try {
            v.endedAt = await hooks.now()
          } catch {
            // The ending time is only for display.
          }
        }
        await publish()
      }
      try {
        // An input the person wrote is for the first round: a card sent back gets its input built again,
        // a retry target's with the feedback last.
        const written = v.round === undefined ? prompts[node.id] : undefined
        const sentBack = v.round !== undefined ? feedback.get(node.id) : undefined
        let prompt = written ?? `${promptFor(graph, task, inputs)}${sentBack !== undefined ? `\n\n${sentBack}` : ''}`
        if (written !== undefined) {
          v.inputEdited = true
          v.prompt = prompt
        }
        if (gate !== undefined) {
          await publish()
          const answer = await Promise.race([gate(node.id, prompt), stopping.then(() => undefined)])
          if (answer === undefined || isStopped) {
            // Never started: the stop (or its own failure to answer) ends it here.
            v.status = 'skipped'
            await publish()
            return
          }
          if (answer !== prompt) {
            prompt = answer
            v.inputEdited = true
            v.prompt = answer
          }
          v.status = 'running'
        }
        if (hooks.now !== undefined) {
          try {
            v.startedAt = await hooks.now()
            await publish()
          } catch {
            // The starting time is only for display.
          }
        }
        // A stop that came after the launch but before the start (while the starting time was published)
        // means the agent is never started.
        if (isStopped) {
          v.status = 'cancelled'
          v.error = stopText()
          await close()
          return
        }
        // One start of the agent, to its ending, and whether a stop had been asked for by then.
        // Once a stop has had its time, a start that has not returned no longer holds the node;
        // if it returns later, that run is asked to stop (and never archived or deleted).
        // A card sent back by a retry (or started again after a temporary failure) costs its earlier starts plus
        // this one; a report of a start that comes after its card was sent back still counts, on the card's entry as it is now.
        const attempt = async (): Promise<{ outcome: NodeOutcome; stoppedAtEnd: boolean }> => {
          let reported = 0
          // The cost stays marked estimated when an earlier start of the card ended on an estimate; within this
          // start, an exact report (a final total) replaces the estimates before it.
          const wasEstimated = (view.nodes[node.id] ?? v).costEstimated === true
          const starting = backend.start(node, prompt, inputs, (usd, estimated) => {
            const total = (spent.get(node.id) ?? 0) + usd - reported
            reported = usd
            spent.set(node.id, total)
            const entry = view.nodes[node.id] ?? v
            entry.costUsd = total
            if (backend.estimatesCost === true || estimated === true || wasEstimated) entry.costEstimated = true
            else delete entry.costEstimated
            void publish()
          })
          const started = await Promise.race([starting, deadline.then(late => ({ late }))])
          if ('late' in started) {
            void starting.then(
              late => requestStop(late),
              () => undefined,
            )
            return { outcome: started.late, stoppedAtEnd: true }
          }
          run = started
          runs.set(node.id, run)
          if (run.link !== undefined) v.link = run.link
          // What the run said first, and whether a stop had been asked for by then.
          const settled: { outcome?: NodeOutcome; stopped: boolean } = { stopped: false }
          const finished = run.done.then(o => {
            settled.outcome = o
            settled.stopped = isStopped
            return o
          })
          finished.catch(() => undefined)
          await publish()
          if (isStopped) await requestStop(run)
          // Stopped before it had said anything: the stop was asked for, so that is how it ends.
          if (isStopped && settled.outcome === undefined) return { outcome: { ok: false, reason: stopText() }, stoppedAtEnd: true }
          const outcome = await Promise.race([finished, deadline])
          return { outcome, stoppedAtEnd: settled.outcome === outcome ? settled.stopped : true }
        }
        let { outcome, stoppedAtEnd } = await attempt()
        // A temporary failure (a limit, an overload, the network) starts the agent again, fresh and with the same input,
        // after a wait; at most MAX_RESTARTS times per agent in the run. A stop ends the wait.
        while (restartable(outcome, stoppedAtEnd) && !isStopped && hooks.wait !== undefined && (restarts.get(node.id) ?? 0) < MAX_RESTARTS) {
          const n = (restarts.get(node.id) ?? 0) + 1
          restarts.set(node.id, n)
          const at = hooks.now !== undefined ? await hooks.now() : Date.now()
          const ms = restartDelay(outcome.transient, n, at)
          const entry: RestartEntry = { attempt: n, at, kind: outcome.transient.kind, error: outcome.reason, waitMs: ms, ...(run?.link !== undefined ? { link: run.link } : {}) }
          v.restarts = [...(v.restarts ?? []), entry]
          v.restartWait = { attempt: n, of: MAX_RESTARTS, until: at + ms, kind: entry.kind, error: entry.error }
          // The failed start is asked to stop (it may still be winding down), and its calls still open end.
          if (run !== undefined) void requestStop(run)
          runs.delete(node.id)
          try {
            tracker?.endOpen(UNFINISHED_TEXT, node.id)
            syncAgent(node.id)
          } catch {
            // Activity is only for display.
          }
          delete v.current
          await publish()
          const woke = await Promise.race([
            hooks.wait(ms).then(() => 'time' as const, () => 'refused' as const),
            stopping.then(() => 'stop' as const),
          ])
          delete v.restartWait
          if (woke === 'stop' || isStopped) {
            entry.stopped = true
            outcome = { ok: false, reason: stopText() }
            stoppedAtEnd = true
            break
          }
          if (woke === 'refused') {
            // No clock to wait with: it ends failed as it came, and no retry is recorded.
            restarts.set(node.id, n - 1)
            if (v.restarts.length > 1) v.restarts = v.restarts.slice(0, -1)
            else delete v.restarts
            break
          }
          ;({ outcome, stoppedAtEnd } = await attempt())
        }
        if (!outcome.ok && outcome.transient !== undefined && !stoppedAtEnd && (restarts.get(node.id) ?? 0) >= MAX_RESTARTS) {
          outcome = { ...outcome, reason: `${outcome.reason} (gave up after ${MAX_RESTARTS} automatic retries)` }
        }
        if (outcome.ok) {
          v.status = 'done'
          v.output = outcome.text
          files[node.id] = outcome.files
          details.delete(node.id)
        } else {
          // Ending after a stop was the person's doing, not a failure.
          v.status = stoppedAtEnd ? 'cancelled' : 'failed'
          // A backend words its own stop ("Stopped."): the run's reason for the stop, when it gave one, replaces that.
          v.error = stoppedAtEnd && outcome.reason === STOPPED_TEXT ? stopText() : outcome.reason
          if (outcome.detail !== undefined) details.set(node.id, outcome.detail)
          else details.delete(node.id)
        }
      } catch (error) {
        v.status = isStopped ? 'cancelled' : 'failed'
        v.error = error instanceof Error ? error.message : String(error)
        // Its session may still be going (and billing): ask it to stop.
        if (run !== undefined) void requestStop(run)
      } finally {
        runs.delete(node.id)
      }
      // Before anything is awaited: a judge's fail that is retried must never be seen as a fail.
      const stamping = judge(node, v)
      if (stamping !== undefined) await stamping
      await close()
    })()
    inFlight.add(job)
    void job.finally(() => inFlight.delete(job))
  }

  await publish()
  try {
    for (;;) {
      skipBlocked()
      const running = runnable.filter(n => statusOf(n.id) === 'running').length
      const ready = runnable.filter(
        n => statusOf(n.id) === 'waiting' && predecessors(n.id).every(p => statusOf(p) === 'done'),
      )
      // A node that pauses on launch holds no slot, so it starts pausing even when none is free,
      // and the next ready one still gets the slot.
      let slots = MAX_PARALLEL - running
      for (const node of ready) {
        if (slots <= 0 && gateFor(node) === undefined) continue
        launch(node)
        if (statusOf(node.id) !== 'paused') slots--
      }
      if (inFlight.size === 0) break
      await Promise.race(inFlight)
    }
  } finally {
    hooks.signal?.removeEventListener('abort', onAbort)
    unsubscribe?.()
  }

  // The last calls; and a helper whose call never ended is not left running.
  try {
    for (const n of runnable) syncAgent(n.id)
    syncHelpers()
    let endedAt: number | undefined
    try {
      if (hooks.now !== undefined) endedAt = await hooks.now()
    } catch {
      // The ending time is only for display.
    }
    for (const n of Object.values(view.nodes)) {
      if (n.calledBy === undefined || n.status !== 'running') continue
      n.status = 'cancelled'
      delete n.current
      if (endedAt !== undefined) n.endedAt = endedAt
    }
  } catch {
    // Activity is only for display.
  }

  const outputs: Record<string, string> = {}
  const failures: Record<string, string> = {}
  for (const n of runnable) {
    const [id, v] = [n.id, view.nodes[n.id]!]
    if (v.status === 'done' && v.output !== undefined) outputs[id] = v.output
    if (v.status === 'failed') failures[id] = v.error ?? 'failed'
  }
  view.isRunning = false
  view.result = resultText(graph, view)
  view.outputs = endNodes(graph).flatMap(n => files[n.id] ?? [])
  await publish()
  closed = true
  return { result: view.result, outputs, failures, endFiles: view.outputs, files }
}
