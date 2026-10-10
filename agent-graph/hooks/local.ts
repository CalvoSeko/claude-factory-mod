import type { AgentNode, Graph, OutputFile } from '../types'
import type { Tracker } from './activity'
import type { Meter } from './cost'
import {
  agentType, contextSize, firstLine, gatherContext, LOCAL_CONTEXT_LIMIT, localPrompt, localSpec, systemText, VERDICT_SECTION,
  type ContextSource, type LocalAgentSpec,
} from './compile'
import type { Guard } from './guard'
import { isCheck, nodeById, outgoing, retryOut, type Problem } from './model'
import { handoffSection, type Backend, type Handoff, type NodeOutcome, type NodeRun } from './runner'

export type TurnEnd = {
  agentId: string
  answer: string
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  refusal?: string
}

const EARLY_LIMIT = 50

// How the activity tracker knows a Local agent: its engine id, so no id of another backend can clash.
export const localKey = (agentId: string) => `local:${agentId}`

// Matches sub-agent turn endings (from turn.complete) to the runs waiting on them.
export function createCompletions() {
  const waiting = new Map<string, (end: TurnEnd) => void>()
  const early = new Map<string, TurnEnd>()

  return {
    wait(agentId: string): Promise<TurnEnd> {
      const ended = early.get(agentId)
      if (ended !== undefined) {
        early.delete(agentId)
        return Promise.resolve(ended)
      }
      return new Promise(resolve => {
        waiting.set(agentId, resolve)
        // A run whose turn end never comes would wait for ever: past the cap, the oldest ends as an error.
        if (waiting.size > EARLY_LIMIT) {
          const [oldest, settle] = waiting.entries().next().value!
          waiting.delete(oldest)
          settle({ agentId: oldest, answer: '', reason: 'error' })
        }
      })
    },
    complete(end: TurnEnd): void {
      const resolve = waiting.get(end.agentId)
      if (resolve !== undefined) {
        waiting.delete(end.agentId)
        resolve(end)
        return
      }
      early.set(end.agentId, end)
      if (early.size > EARLY_LIMIT) early.delete(early.keys().next().value!)
    },
  }
}

export type Completions = ReturnType<typeof createCompletions>

export function outcomeOf(end: TurnEnd): NodeOutcome {
  if (end.reason === 'answer') return { ok: true, text: end.answer, files: [] }
  if (end.reason === 'aborted') return { ok: false, reason: 'Stopped.' }
  if (end.reason === 'refusal') return { ok: false, reason: end.refusal ? `Refused: ${end.refusal}` : 'Refused.' }
  return { ok: false, reason: 'The agent stopped with an error.' }
}

// A command the host runs: its output piece by piece, then how it ended. Leaving the stream kills the child.
export type CommandChunk = { stream: 'stdout' | 'stderr'; text: string }
export type CommandEnd = { code: number | null; signal: string | null }
export type CommandDeps = {
  // `$.process.spawn` by argv (no shell), with `env` set over the host's own.
  spawn(argv: string[], env?: Record<string, string>): AsyncGenerator<CommandChunk, CommandEnd>
  // The OS is Windows (`OS` is `Windows_NT`).
  isWindows(): Promise<boolean>
  // Resolves after `ms` (the host clock); a rejection means there is no timeout.
  wait(ms: number): Promise<void>
}

// The variable that carries a check's command on Windows.
export const CHECK_ENV = 'AGENT_GRAPH_CHECK'
export const CHECK_KEEP_CHARS = 64_000
export const CHECK_DETAIL_CHARS = 4000
export const CHECK_PASS_CHARS = 2000

export type LocalDeps = {
  register(spec: LocalAgentSpec): Promise<unknown>
  spawn(args: { prompt: string; subagentType: string; description: string }): Promise<{ agentId?: string; deny?: string }>
  stopAgent(agentId: string): Promise<void>
  instructions(node: AgentNode): Promise<string>
  context: ContextSource
  completions: Completions
  guard: Guard
  // The tracker of the run in progress (one per run, made when it starts), if any.
  tracker?: () => Tracker | undefined
  // The meter of the run in progress (one per run, made when it starts), if any: it counts the agent's cost.
  meter?: () => Meter | undefined
  // Runs the commands of check cards; without it a check card cannot start.
  command?: CommandDeps
}

const lastChars = (text: string, n: number) => (text.length <= n ? text : text.slice(text.length - n))

export function createLocalBackend(graph: Graph, deps: LocalDeps): Backend {
  let checks = 0

  // A check card: its command runs instead of an agent. No cost is ever reported for it.
  function startCheck(node: AgentNode, inputs: Handoff[]): NodeRun {
    const check = node.check!
    const command = check.command
    const tracker = deps.tracker?.()
    const key = `check:${node.id}:${++checks}`
    let callId: string | undefined
    try {
      tracker?.watch(key, node.id)
      callId = tracker?.callStart(key, 'Check', { command })
    } catch {
      // Activity is only for display.
    }
    const endCall = (ok: boolean, output: string, error?: string) => {
      try {
        if (callId !== undefined) tracker?.callEnd(callId, { ok, result: lastChars(output, CHECK_PASS_CHARS), ...(error !== undefined ? { error } : {}) })
        tracker?.unwatch(key)
      } catch {
        // Activity is only for display.
      }
    }

    // The check's one ending: the first of the child's end, the timeout and the stop settles it, the rest do nothing.
    // No promise that lives on (the timer's, the stop's) is ever chained onto a pull, so a chunk is only held by the
    // capped `output` below.
    let output = ''
    let isOver = false
    let stream: AsyncGenerator<CommandChunk, CommandEnd> | undefined
    let settle!: (outcome: NodeOutcome) => void
    const done = new Promise<NodeOutcome>(resolve => (settle = resolve))
    const fail = (reason: string): NodeOutcome => ({ ok: false, reason, detail: lastChars(output, CHECK_DETAIL_CHARS) })
    // `fire` is what the timer's callback reaches: once the check is over it is dropped, so the callback (which
    // may wait up to the timeout in the host clock, that has no cancel) is a no-op holding nothing.
    const timer: { fire?: () => void } = {}
    const finish = (outcome: NodeOutcome) => {
      if (isOver) return
      isOver = true
      timer.fire = undefined
      settle(outcome)
      // Leaving the stream kills the child, but the return is not awaited and the outcome does not wait for it: on a
      // native async generator a return queues behind a pull still pending, so a child that has stopped printing may
      // only die when it next writes or exits.
      try {
        void Promise.resolve(stream?.return(undefined as never)).catch(() => undefined)
      } catch {
        // The child is gone, or was never there.
      }
      stream = undefined
    }

    const pump = async () => {
      let isStarted = false
      try {
        if (deps.command === undefined) return finish(fail('could not start: no way to run commands here.'))
        const windows = await deps.command.isWindows()
        if (isOver) return
        // On Windows the command goes through the environment, so its quotes reach cmd as they were written.
        const [argv, env] = windows
          ? [['cmd', '/d', '/s', '/c', `%${CHECK_ENV}%`], { [CHECK_ENV]: command }]
          : [['sh', '-c', command], undefined]
        const child = deps.command.spawn(argv!, env)
        stream = child
        timer.fire = () => finish(fail(`Timed out after ${check.timeoutMin} min.`))
        void deps.command.wait(Math.max(0, check.timeoutMin) * 60_000).then(() => timer.fire?.(), () => undefined)
        for (;;) {
          const step = await child.next()
          if (isOver) return
          isStarted = true
          if (!step.done) {
            output = lastChars(output + step.value.text, CHECK_KEEP_CHARS)
            continue
          }
          const { code, signal } = step.value
          if (code !== 0) return finish(fail(`\`${command}\` exited ${code ?? signal ?? 'abnormally'}.`))
          const shown = lastChars(output, CHECK_PASS_CHARS).replace(/\s+$/, '')
          const block = shown !== '' ? `\n\n\`\`\`\n${shown}\n\`\`\`` : ''
          const body = `## ${node.name} passed\n\n\`${command}\` exited 0.${block}`
          const seen = new Set<string>()
          const files: OutputFile[] = inputs.flatMap(i => i.files).filter(f => !seen.has(f.id) && seen.add(f.id) !== undefined)
          return finish({ ok: true, text: [...inputs.map(i => handoffSection(graph, i)), body].join('\n\n'), files })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        finish(fail(isStarted ? `\`${command}\` stopped with an error: ${message}` : `could not start: ${message}`))
      }
    }
    void pump()

    void done.then(outcome => endCall(outcome.ok, outcome.ok ? output : (outcome.detail ?? ''), outcome.ok ? undefined : outcome.reason))
    return {
      done,
      stop: async () => {
        finish({ ok: false, reason: 'Stopped.', detail: lastChars(output, CHECK_DETAIL_CHARS) })
        await done
      },
    }
  }


  return {
    // Its costs are priced from a list of rates, not billed.
    estimatesCost: true,

    async prepare(g) {
      const problems: Problem[] = []
      for (const node of g.nodes) {
        // A check card runs a command: it has no agent type, instructions or context.
        if (isCheck(node)) continue
        const onNode = (message: string) => problems.push({ target: { kind: 'node', id: node.id }, message })
        const gathered = await gatherContext(node.contextFiles, deps.context)
        if ('error' in gathered) {
          onNode(gathered.error)
          continue
        }
        if (contextSize(gathered.files) > LOCAL_CONTEXT_LIMIT) {
          onNode('Context files add up to more than 200 KB; trim them or use fewer.')
          continue
        }
        // A reviewer's verdict section goes after the context files, so the prompt still ends with it.
        const system = await systemText(g, node, deps.instructions, 'local', false)
        const tail = retryOut(g, node.id) !== undefined ? VERDICT_SECTION : undefined
        try {
          await deps.register(localSpec(g, node, localPrompt(system, gathered.files, tail), firstLine(system)))
        } catch (error) {
          onNode(`Could not register this agent: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return problems
    },

    async start(node, prompt, inputs, onCost) {
      if (isCheck(node)) return startCheck(node, inputs)
      const spawned = await deps.spawn({
        prompt,
        subagentType: agentType(graph, node),
        description: `${node.name} (agent graph)`,
      })
      if (spawned.agentId === undefined) {
        return { done: Promise.resolve({ ok: false, reason: spawned.deny ?? 'The agent did not start.' }), stop: async () => {} }
      }
      const agentId = spawned.agentId
      const delegates = outgoing(graph, node.id, 'delegate').flatMap(e => {
        const d = nodeById(graph, e.to)
        return d === undefined ? [] : [agentType(graph, d)]
      })
      deps.guard.allow(agentId, delegates)
      const tracker = deps.tracker?.()
      try {
        tracker?.watch(localKey(agentId), node.id)
      } catch {
        // Activity is only for display.
      }
      let isEnded = false
      // The agent is asked to stop once, whether the budget or the person gets there first.
      let stopCall: Promise<void> | undefined
      const stopNow = () => (stopCall ??= Promise.resolve().then(() => deps.stopAgent(agentId)))
      // The budget: once the agent's cost (its delegates' included) reaches it, the agent is stopped and ends failed.
      let isOverBudget = false
      const over: NodeOutcome = { ok: false, reason: `Hit its $${node.budgetUsd} budget.` }
      let settleBudget!: (outcome: NodeOutcome) => void
      const budgetEnded = new Promise<NodeOutcome>(resolve => (settleBudget = resolve))
      const meter = deps.meter?.()
      try {
        meter?.watch(agentId, total => {
          // The cost is only for display and for the budget: a callback that fails must not reach the request.
          try {
            onCost(total)
          } catch {
            // Nothing to do about it here.
          }
          // A stop the person already asked for keeps its own ending (cancelled, "Stopped.").
          if (isOverBudget || stopCall !== undefined || !Number.isFinite(node.budgetUsd) || node.budgetUsd <= 0 || total < node.budgetUsd) return
          isOverBudget = true
          // Like a person's Stop: it starts nothing more, and stays guarded and counted until its turn really ends.
          if (!isEnded) deps.guard.stop(agentId)
          // It can overshoot by the request that crossed the line; the outcome stands once the stop has been asked for.
          void stopNow().then(() => undefined, () => undefined).then(() => settleBudget(over))
        })
      } catch {
        // Without a meter the agent just has no cost.
      }
      // The agent's real turn end: only then is it forgotten, unwatched and no longer counted (requests of its
      // delegates still in flight when the budget stopped it are part of its cost).
      const ended = deps.completions.wait(agentId)
      void ended.then(() => {
        isEnded = true
        deps.guard.forget(agentId)
        try {
          tracker?.unwatch(localKey(agentId))
        } catch {
          // Activity is only for display.
        }
        try {
          meter?.unwatch(agentId)
        } catch {
          // The cost is only for display.
        }
      })
      // A budget stop is an ending of its own: the node does not wait for the engine to confirm the stop.
      const done = Promise.race([ended.then(end => (isOverBudget ? over : outcomeOf(end))), budgetEnded])
      return {
        done,
        stop: async () => {
          // A stopped agent may still be running for a moment: it starts nothing more.
          // Its guard entry goes when its turn end comes (or its wait is dropped).
          if (!isEnded) deps.guard.stop(agentId)
          await stopNow()
        },
      }
    },
  }
}
