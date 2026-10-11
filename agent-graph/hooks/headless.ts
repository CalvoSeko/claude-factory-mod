// The Headless backend: a card runs as its own `claude -p` process in auto mode (its prompt is the request, so auto
// mode judges its actions against it). The reader below takes what that process prints with
// `--output-format stream-json --verbose`: one JSON event per line. No engine here: the host comes in as deps.

import type { AgentNode, Graph } from '../types'
import { clip, STOPPED_TEXT, UNFINISHED_TEXT, type Tracker } from './activity'
import {
  agentName, contextSize, firstLine, gatherContext, LOCAL_CONTEXT_LIMIT, localPrompt, localSpec, systemText, VERDICT_SECTION,
  type ContextSource, type LocalAgentSpec,
} from './compile'
import { requestUsd } from './cost'
import type { CommandChunk, CommandEnd } from './local'
import { isCheck, nodeById, outgoing, retryOut, type Problem } from './model'
import type { Backend, NodeOutcome } from './runner'
import { transientOfStatus, transientOfText, type Transient } from './transient'

export type StreamSink = {
  // A tool call starts: `parent` is undefined for the card's own call, else the Agent call's tool_use id it runs under.
  callStart(id: string, tool: string, input: unknown, parent: string | undefined): void
  callEnd(id: string, ok: boolean, result: string): void
  // The live cost so far (an estimate), summed over distinct message ids.
  cost(usd: number): void
}

export type StreamEnd = {
  // `text`: the last non-empty answer of any result (the answer of a success); `ownText`: the last result's own words
  // (its `result`, else its `errors` joined), what a failure says.
  result?: { subtype: string; isError: boolean; text: string; ownText: string; costUsd?: number; apiErrorStatus?: number | null }
  other: string
}

const RESULT_CLIP = 2048
const OTHER_KEEP = 2000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

// A tool result's content is a string or an array of `{type:'text', text}` blocks.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) if (isObj(block) && typeof block.text === 'string') parts.push(block.text)
  return parts.join('\n')
}

export function createStreamReader(sink: StreamSink): { line(text: string): void; end(): StreamEnd } {
  // A sink is the caller's code: whatever it throws must not stop the reading of the stream.
  const safely = (fn: () => void) => {
    try {
      fn()
    } catch {
      // ignored on purpose
    }
  }
  const counted = new Set<string>()
  const started = new Set<string>()
  let totalUsd = 0
  let other = ''
  let last: Obj | undefined
  let answer = ''

  const addOther = (text: string) => {
    other = other ? `${other}\n${text}` : text
    if (other.length > OTHER_KEEP) other = other.slice(-OTHER_KEEP)
  }

  function onAssistant(event: Obj) {
    const message = event.message
    if (!isObj(message)) return
    const parent = str(event.parent_tool_use_id)
    // Each content block of one message arrives as its own event with the same message id: its usage counts once.
    const messageId = str(message.id)
    if (messageId !== undefined && !counted.has(messageId) && isObj(message.usage)) {
      counted.add(messageId)
      totalUsd += requestUsd({ ...(message.usage as Obj), model: str(message.model) ?? '' } as Parameters<typeof requestUsd>[0])
      safely(() => sink.cost(totalUsd))
    }
    if (!Array.isArray(message.content)) return
    for (const block of message.content) {
      if (!isObj(block) || block.type !== 'tool_use') continue
      const id = str(block.id)
      const tool = str(block.name)
      if (id === undefined || tool === undefined || started.has(id)) continue
      started.add(id)
      safely(() => sink.callStart(id, tool, block.input, parent))
    }
  }

  function onUser(event: Obj) {
    const message = event.message
    if (!isObj(message) || !Array.isArray(message.content)) return
    for (const block of message.content) {
      if (!isObj(block) || block.type !== 'tool_result') continue
      const id = str(block.tool_use_id)
      if (id === undefined) continue
      const ok = block.is_error !== true
      safely(() => sink.callEnd(id, ok, clip(textOf(block.content), RESULT_CLIP)))
    }
  }

  return {
    line(text) {
      if (!text.trim()) return
      let event: unknown
      try {
        event = JSON.parse(text)
      } catch {
        addOther(text)
        return
      }
      if (!isObj(event)) {
        addOther(text)
        return
      }
      try {
        if (event.type === 'assistant') onAssistant(event)
        else if (event.type === 'user') onUser(event)
        else if (event.type === 'result') {
          last = event
          const answerText = str(event.result)
          if (answerText) answer = answerText
        }
      } catch {
        // an event of a shape we do not know: skipped
      }
    },
    end() {
      if (!last) return { other }
      const cost = last.total_cost_usd
      const status = last.api_error_status
      const errors = Array.isArray(last.errors) ? last.errors.filter((e): e is string => typeof e === 'string' && e !== '') : []
      return {
        result: {
          subtype: str(last.subtype) ?? '',
          isError: last.is_error === true,
          text: answer,
          ownText: str(last.result) || errors.join('; '),
          ...(typeof cost === 'number' && Number.isFinite(cost) ? { costUsd: cost } : {}),
          ...(typeof status === 'number' || status === null ? { apiErrorStatus: status } : {}),
        },
        other,
      }
    },
  }
}

export type HeadlessDeps = {
  // The person's home folder (USERPROFILE, else HOME), with forward slashes.
  home(): Promise<string>
  write(path: string, text: string): Promise<void>
  // `$.process.spawn` by argv (no shell, the session's working directory), `input` on stdin, `env` over the host's own.
  spawn(argv: string[], input: string, env: Record<string, string>): AsyncGenerator<CommandChunk, CommandEnd>
  instructions(node: AgentNode): Promise<string>
  context: ContextSource
  // A Local backend: it runs the check cards (a check card is a command, the same on both).
  checks: Backend
  // The tracker of the run in progress (one per run, made when it starts), if any.
  tracker?: () => Tracker | undefined
  // The Claude Code executable this session runs (CLAUDE_CODE_EXECPATH), if it says; else `claude` from PATH.
  execPath?: () => Promise<string | undefined>
}

// The `--agents` file of a card: its own definition and its delegates' (theirs too), keyed by agent name.
export const agentsFile = (home: string, g: Graph, node: AgentNode) => `${home}/.claude/agent-graph/${g.id}/headless/${agentName(g, node)}.json`

// The child is a session of its own: it loads no agent-graph again and inherits none of this session's links to its
// desktop host (auth refresh, session ids, the messaging socket).
export const CHILD_ENV: Record<string, string> = {
  CLAUDE_CODE_PLUGIN_DIRS: '',
  CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '',
  CLAUDE_CODE_SESSION_ID: '',
  CLAUDE_CODE_HOST_SESSION_ID: '',
  CLAUDE_CODE_MESSAGING_SOCKET: '',
  CLAUDE_CODE_MESSAGING_TOKEN: '',
}

type HeadlessSpec = Omit<LocalAgentSpec, 'name'> & { disallowedTools?: string[] }

// Headless has no guard like Local's: the definition limits the Agent tool instead. A card without delegates has no
// Agent tool; one with a tool list may start only its delegates (`Agent(a, b)`). A card with every tool (an empty
// list) and delegates is not limited: a definition cannot say "every tool, Agent only for these".
function guarded(spec: HeadlessSpec, delegates: string[]): HeadlessSpec {
  if (delegates.length === 0) return { ...spec, disallowedTools: ['Agent'] }
  if (spec.tools === undefined) return spec
  return { ...spec, tools: spec.tools.map(t => (t === 'Agent' ? `Agent(${delegates.join(', ')})` : t)) }
}

const DETAIL_CHARS = 2000
// A delegate's Agent call answers at once when the delegate runs in the background.
const LAUNCHED = /^\s*Async agent launched/i

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function quietly(run: () => void): void {
  try {
    run()
  } catch {
    // Activity and costs are only for display.
  }
}

export function createHeadlessBackend(graph: Graph, deps: HeadlessDeps): Backend {
  let runs = 0

  return {
    async prepare(g) {
      const problems: Problem[] = []
      const onNode = (node: AgentNode, message: string) => problems.push({ target: { kind: 'node', id: node.id }, message })
      // Each agent card's definition, as Local registers it (the name is the key of the file instead).
      const specs = new Map<string, HeadlessSpec>()
      for (const node of g.nodes) {
        // A check card runs a command: it has no agent definition.
        if (isCheck(node)) continue
        const gathered = await gatherContext(node.contextFiles, deps.context)
        if ('error' in gathered) {
          onNode(node, gathered.error)
          continue
        }
        if (contextSize(gathered.files) > LOCAL_CONTEXT_LIMIT) {
          onNode(node, 'Context files add up to more than 200 KB; trim them or use fewer.')
          continue
        }
        // A reviewer's verdict section goes after the context files, so the prompt still ends with it.
        const system = await systemText(g, node, deps.instructions, 'headless', false)
        const tail = retryOut(g, node.id) !== undefined ? VERDICT_SECTION : undefined
        const { name: _name, ...spec } = localSpec(g, node, localPrompt(system, gathered.files, tail), firstLine(system))
        const delegates = outgoing(g, node.id, 'delegate').flatMap(e => {
          const d = nodeById(g, e.to)
          return d === undefined || isCheck(d) ? [] : [agentName(g, d)]
        })
        specs.set(node.id, guarded(spec, delegates))
      }
      for (const node of g.nodes) {
        if (!specs.has(node.id)) continue
        // The card, then its delegates, theirs and so on: a delegate's own Agent calls name agents of this file too.
        const agents: Record<string, HeadlessSpec> = {}
        const seen = new Set<string>()
        const queue = [node.id]
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          if (seen.has(id)) continue
          seen.add(id)
          const n = nodeById(g, id)
          const spec = specs.get(id)
          if (n !== undefined && spec !== undefined) agents[agentName(g, n)] = spec
          queue.push(...outgoing(g, id, 'delegate').map(e => e.to))
        }
        try {
          await deps.write(agentsFile(await deps.home(), g, node), JSON.stringify(agents))
        } catch (error) {
          onNode(node, `Could not write this agent's settings: ${messageOf(error)}`)
        }
      }
      return problems
    },

    async start(node, prompt, inputs, onCost) {
      if (isCheck(node)) return deps.checks.start(node, prompt, inputs, onCost)
      const budget = node.budgetUsd
      const hasBudget = Number.isFinite(budget) && budget > 0
      const argv = [
        (await deps.execPath?.()) || 'claude', '-p', '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose',
        // A card's run is not one to resume: it stays out of the person's session list.
        '--no-session-persistence',
        '--agents', agentsFile(await deps.home(), graph, node), '--agent', agentName(graph, node),
        ...(hasBudget ? ['--max-budget-usd', String(budget)] : []),
      ]
      const over: NodeOutcome = { ok: false, reason: `Hit its $${budget} budget.` }
      const report = (usd: number, estimated: boolean) => quietly(() => onCost(usd, estimated))

      // Activity: the card's calls under its key, a delegate's under the key its Agent call opened.
      const tracker = deps.tracker?.()
      const key = `headless:${node.id}:${++runs}`
      quietly(() => tracker?.watch(key, node.id))
      const calls = new Map<string, string>()
      const delegateKeys = new Map<string, string>()
      // The Agent calls whose delegate runs on in the background: they end with the card.
      const live = new Set<string>()
      const reader = createStreamReader({
        callStart(id, tool, input, parent) {
          if (tracker === undefined) return
          const owner = (parent === undefined ? undefined : delegateKeys.get(parent)) ?? key
          const callId = tracker.callStart(owner, tool, input)
          if (callId === undefined) return
          calls.set(id, callId)
          if (tool !== 'Agent') return
          const type = typeof input === 'object' && input !== null ? (input as { subagent_type?: unknown }).subagent_type : undefined
          const target = typeof type === 'string' ? graph.nodes.find(n => !isCheck(n) && agentName(graph, n) === type) : undefined
          const childKey = `${key}:${id}`
          const name = target?.name ?? (typeof type === 'string' && type !== '' ? type : 'Agent')
          if (tracker.childOf(owner, childKey, name, target?.id, callId) !== undefined) delegateKeys.set(id, childKey)
        },
        callEnd(id, ok, result) {
          const callId = calls.get(id)
          if (callId === undefined) return
          calls.delete(id)
          if (ok && delegateKeys.has(id) && LAUNCHED.test(result)) {
            live.add(callId)
            return
          }
          tracker?.callEnd(callId, ok ? { ok, result } : { ok, error: result })
        },
        // A running sum priced from rates: an estimate until the process reports its exact total.
        cost: usd => report(usd, true),
      })

      // The card's one ending: the first of the child's end and the stop settles it, the other does nothing.
      let isOver = false
      let stream: AsyncGenerator<CommandChunk, CommandEnd> | undefined
      let settle!: (outcome: NodeOutcome) => void
      const done = new Promise<NodeOutcome>(resolve => (settle = resolve))
      const finish = (outcome: NodeOutcome) => {
        if (isOver) return
        isOver = true
        // A card that answered had its background delegates finish too; anything else still open ends with it.
        if (outcome.ok) for (const callId of live) quietly(() => tracker?.callEnd(callId, { ok: true }))
        const isStopped = !outcome.ok && outcome.reason === STOPPED_TEXT
        quietly(() => tracker?.endOpen(isStopped ? STOPPED_TEXT : UNFINISHED_TEXT, node.id))
        for (const k of [key, ...delegateKeys.values()]) quietly(() => tracker?.unwatch(k))
        settle(outcome)
        // Leaving the stream kills the child; the outcome does not wait for it (see the check cards in local.ts).
        try {
          void Promise.resolve(stream?.return(undefined as never)).catch(() => undefined)
        } catch {
          // The child is gone, or was never there.
        }
        stream = undefined
      }
      const fail = (detail: string, transient: Transient | undefined): NodeOutcome => ({
        ok: false,
        reason: `The agent stopped with an error: ${detail}`,
        ...(transient !== undefined ? { transient } : {}),
      })
      // The process is over: its last result decides, else what it printed besides events (or how it exited).
      const outcomeOf = (end: StreamEnd, exit: string): NodeOutcome => {
        const result = end.result
        if (result === undefined) {
          const detail = end.other.trim() !== '' ? end.other.trim().slice(-DETAIL_CHARS) : exit
          return fail(detail, transientOfText(detail))
        }
        if (result.costUsd !== undefined) report(result.costUsd, false)
        if (result.subtype === 'error_max_budget_usd' || (hasBudget && result.costUsd !== undefined && result.costUsd >= budget)) return over
        if (result.subtype === 'success' && !result.isError) return { ok: true, text: result.text, files: [] }
        const detail = result.ownText !== '' ? result.ownText : end.other.trim() !== '' ? end.other.trim().slice(-DETAIL_CHARS) : result.subtype
        const status = result.apiErrorStatus
        return fail(detail, typeof status === 'number' ? transientOfStatus(status, detail) : transientOfText(detail))
      }

      const pump = async () => {
        let isStarted = false
        // Pieces are not lines: what follows a piece's last newline waits for the next piece of its pipe.
        const partial = { stdout: '', stderr: '' }
        const flush = () => {
          for (const rest of [partial.stdout, partial.stderr]) reader.line(rest)
          partial.stdout = partial.stderr = ''
        }
        try {
          const child = deps.spawn(argv, prompt, { ...CHILD_ENV })
          stream = child
          for (;;) {
            const step = await child.next()
            if (isOver) return
            isStarted = true
            if (!step.done) {
              // stderr is no event: as a line that is not JSON it goes to the reader's other output.
              const lines = (partial[step.value.stream] + step.value.text).split(/\r?\n/)
              partial[step.value.stream] = lines.pop() ?? ''
              for (const line of lines) reader.line(line)
              continue
            }
            flush()
            const { code, signal } = step.value
            return finish(outcomeOf(reader.end(), `exit ${code ?? signal ?? 'abnormally'}`))
          }
        } catch (error) {
          if (isOver) return
          if (!isStarted) return finish({ ok: false, reason: `Could not start Claude Code: ${messageOf(error)}` })
          flush()
          finish(outcomeOf(reader.end(), messageOf(error)))
        }
      }
      void pump()

      return {
        done,
        stop: async () => {
          finish({ ok: false, reason: STOPPED_TEXT })
          await done
        },
      }
    },
  }
}
