import type { AgentNode, Graph, OutputFile } from '../../types'
import { gatherContext, handoffNames, type ContextSource } from '../compile'
import { handoffDir, nodeById } from '../model'
import { STOPPED_TEXT, UNFINISHED_TEXT, type Tracker } from '../activity'
import type { Backend, NodeOutcome } from '../runner'
import type { SessionEvent } from './api'
import { ensureEnvironment, syncGraph, type SyncDeps } from './sync'

export type CloudDeps = SyncDeps & {
  context: ContextSource
  wait(ms: number): Promise<void>
  workspaceId: string
  onGraph(graph: Graph): Promise<void>
  // The tracker of the run in progress, if any: the session's tool calls and delegate threads go to it.
  tracker?: () => Tracker | undefined
}

export const POLL_MS = 2000
// Waits before each retry of a failed poll (about 30 s in all); then the
// session is asked to stop and the node fails.
export const RETRY_MS = [2000, 4000, 8000, 16000]
// A just-ended session can list no files for a moment: how often an empty listing is tried again
// (most agents write no files, so a longer wait would only delay every one of them).
const LISTING_RETRIES = 1
// After a stop, how many more polls wait for the session to say it is idle.
const STOP_POLLS = 3

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function textOf(event: SessionEvent): string {
  const content = event['content']
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
    .join('')
}

const reasonOf = (event: SessionEvent) =>
  ((event['stop_reason'] as { type?: string } | undefined)?.type) ?? ''

export function createCloudBackend(graph: Graph, deps: CloudDeps): Backend {
  let environmentId = ''
  let synced = graph

  async function upload(name: string, text: string): Promise<string> {
    const key = `cloud:file:${await deps.hash(text)}:${name}`
    const known = await deps.store.get(key)
    if (typeof known === 'string') return known
    const { id } = await deps.api.uploadFile(name, text)
    await deps.store.set(key, id)
    return id
  }

  // The answer stands even when its files cannot be listed.
  async function outputsOf(sessionId: string, node: AgentNode): Promise<OutputFile[]> {
    try {
      let files = await deps.api.listSessionFiles(sessionId)
      for (let retry = 0; retry < LISTING_RETRIES && files.length === 0; retry++) {
        await deps.wait(POLL_MS)
        files = await deps.api.listSessionFiles(sessionId)
      }
      return files.map(f => ({ id: f.id, name: f.filename, fromNode: node.id }))
    } catch {
      return []
    }
  }

  return {
    async prepare(g) {
      try {
        environmentId = await ensureEnvironment(deps)
      } catch (error) {
        return [{ target: { kind: 'graph' }, message: `Could not create the cloud environment: ${error instanceof Error ? error.message : String(error)}` }]
      }
      const result = await syncGraph(g, deps)
      synced = result.graph
      await deps.onGraph(synced)
      return result.problems
    },

    async start(node, prompt, inputs, onCost) {
      const current = nodeById(synced, node.id) ?? node
      if (current.cloud === undefined) return { done: Promise.resolve({ ok: false, reason: 'This agent was not synced.' }), stop: async () => {} }

      const resources: Array<Record<string, unknown>> = []
      const gathered = await gatherContext(current.contextFiles, deps.context)
      if ('error' in gathered) return { done: Promise.resolve({ ok: false, reason: gathered.error }), stop: async () => {} }
      for (const file of gathered.files) {
        if (file.text.includes('\u0000')) return { done: Promise.resolve({ ok: false, reason: `Binary context files are not supported on Cloud yet: ${file.path}` }), stop: async () => {} }
        resources.push({ type: 'file', file_id: await upload(file.relative.split('/').pop()!, file.text), mount_path: `/workspace/context/${file.relative}` })
      }
      for (const input of inputs) {
        // A reused agent is not in the prepared graph; its name comes from the whole one, as in the prompt.
        const from = nodeById(synced, input.from)?.name ?? nodeById(graph, input.from)?.name ?? input.from
        const names = handoffNames(input.files.map(f => f.name))
        input.files.forEach((file, i) => {
          resources.push({ type: 'file', file_id: file.id, mount_path: `/workspace/handoff/${handoffDir(from, input.from)}/${names[i]!}` })
        })
      }

      const session = await deps.api.createSession({
        agent: { type: 'agent', id: current.cloud.agentId, version: current.cloud.version },
        environment_id: environmentId || (await ensureEnvironment(deps)),
        title: `${synced.name} / ${current.name}`,
        resources,
        budget: { type: 'limit', max_list_cost: { amount: String(Math.round(current.budgetUsd * 100)), currency: 'USD' } },
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }],
      })
      const link = `https://platform.claude.com/workspaces/${deps.workspaceId}/sessions/${session.id}`
      let isStopped = false

      // Best effort, tried twice; never throws.
      const interrupt = async (): Promise<void> => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await deps.api.sendEvents(session.id, [{ type: 'user.interrupt' }])
            return
          } catch {
            // Try once more.
          }
        }
      }

      const activity = captureActivity(deps, graph, current, session.id)
      const poll = (async (): Promise<NodeOutcome> => {
        const seen = new Set<string>()
        let last = ''
        let failures = 0
        let stoppedPolls = 0
        for (;;) {
          // Both interrupts can fail; a session that never goes idle must not keep the node running.
          if (isStopped) {
            if (stoppedPolls >= STOP_POLLS) return { ok: false, reason: 'Stopped (the session may still be running; open its Console link).' }
            if (stoppedPolls++ > 0) await interrupt()
          }
          await deps.wait(failures === 0 ? POLL_MS : RETRY_MS[failures - 1]!)
          let events: SessionEvent[]
          try {
            events = await deps.api.listEvents(session.id)
            failures = 0
          } catch (error) {
            failures++
            if (failures <= RETRY_MS.length) continue
            await interrupt()
            return { ok: false, reason: `Lost contact with the cloud session (${errorText(error)}); it was asked to stop.` }
          }
          for (const event of events) {
            if (seen.has(event.id)) continue
            seen.add(event.id)
            await activity.event(event)
            if (event.type === 'agent.message') {
              const text = textOf(event)
              if (text !== '') last = text
            } else if (event.type === 'session.usage') {
              const amount = Number((event['list_cost'] as { amount?: string } | undefined)?.amount ?? 'NaN')
              if (Number.isFinite(amount)) onCost(amount / 100)
            } else if (event.type === 'session.error') {
              const detail = (event['error'] as { message?: string } | undefined)?.message ?? 'unknown error'
              return { ok: false, reason: `Session error: ${detail}` }
            } else if (event.type === 'session.status_terminated') {
              return last !== '' && !isStopped
                ? { ok: true, text: last, files: await outputsOf(session.id, current) }
                : { ok: false, reason: isStopped ? 'Stopped.' : 'The session ended without an answer.' }
            } else if (event.type === 'session.status_idle') {
              const reason = reasonOf(event)
              if (isStopped) return { ok: false, reason: 'Stopped.' }
              if (reason === 'end_turn') {
                return last !== ''
                  ? { ok: true, text: last, files: await outputsOf(session.id, current) }
                  : { ok: false, reason: 'The session ended without an answer.' }
              }
              if (reason === 'budget_reached') return { ok: false, reason: `Hit its $${current.budgetUsd} budget.` }
              if (reason === 'requires_action') return { ok: false, reason: 'Waiting for a tool approval; open its Console link to answer it.' }
            }
          }
          await activity.threads()
        }
      })()
      // Whatever way the poll ends, the session's open calls end with it.
      const done = poll.finally(() => activity.finish(isStopped))

      return {
        done,
        link,
        stop: async () => {
          isStopped = true
          await interrupt()
        },
      }
    },
  }
}

// ---- activity ----

// The built-in tools of a cloud agent under the names Local uses, so the summaries read the same.
const BUILT_IN: Record<string, string> = {
  bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', glob: 'Glob', grep: 'Grep', web_fetch: 'WebFetch', web_search: 'WebSearch',
}
// The coordinator's delegation tools: the delegate row (from the thread messages) stands for them. They are never
// read as an `Agent` call either: send_to_agent answers at once, which would close the delegate early.
const DELEGATION_TOOLS = new Set(['send_to_agent', 'list_agents'])

// The text of a tool result or message: its text blocks, or the string itself.
function contentText(event: SessionEvent): string {
  const content = event['content']
  if (typeof content === 'string') return content
  return textOf(event)
}

function errorOf(event: SessionEvent): string | undefined {
  const error = event['error']
  if (typeof error === 'string' && error !== '') return error
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' && message !== '' ? message : 'The thread ended with an error.'
  }
  return reasonOf(event) === 'error' ? 'The thread ended with an error.' : undefined
}

// Maps one cloud session's events onto the run's activity tracker. Everything here is best effort: nothing
// throws, and a thread that cannot be read only leaves its delegate without nested calls.
function captureActivity(deps: CloudDeps, graph: Graph, node: AgentNode, sessionId: string) {
  let tracker: Tracker | undefined
  try {
    tracker = deps.tracker?.()
  } catch {
    tracker = undefined
  }
  const topKey = `cloud:${sessionId}`
  const threadKey = (threadId: string) => `${topKey}:${threadId}`
  const calls = new Map<string, string>() // event id of a tool call -> its tracker call id
  const open = new Map<string, string>() // thread id -> the tracker call id of its open delegate item
  const applied = new Map<string, Set<string>>() // thread id -> event ids already applied

  const quietly = <T>(run: () => T): T | undefined => {
    try {
      return run()
    } catch {
      return undefined
    }
  }
  quietly(() => tracker?.watch(topKey, node.id))

  // The graph agent a message was sent to: by its name, or by its cloud name ("<graph> / <name>").
  const helperOf = (name: string): AgentNode | undefined =>
    graph.nodes.find(n => n.id !== node.id && (n.name === name || `${graph.name} / ${n.name}` === name))

  function toolEvent(key: string, event: SessionEvent): void {
    if (tracker === undefined) return
    const type = event.type
    if (type === 'agent.tool_use' || type === 'agent.custom_tool_use' || type === 'agent.mcp_tool_use') {
      if (key === topKey && type === 'agent.tool_use' && DELEGATION_TOOLS.has(String(event['name']))) return
      const name = type === 'agent.tool_use' ? (BUILT_IN[String(event['name'])] ?? String(event['name'] ?? '')) : String(event['name'] ?? '')
      const server = event['mcp_server_name']
      const tool = type === 'agent.mcp_tool_use' && typeof server === 'string' && server !== '' && !name.startsWith('mcp__') ? `mcp__${server}__${name}` : name
      const callId = tracker.callStart(key, tool, event['input'])
      if (callId !== undefined) calls.set(event.id, callId)
    } else if (type === 'agent.tool_result' || type === 'agent.mcp_tool_result') {
      const of = event['tool_use_id'] ?? event['mcp_tool_use_id']
      const callId = typeof of === 'string' ? calls.get(of) : undefined
      if (callId === undefined) return
      calls.delete(of as string)
      const text = contentText(event)
      tracker.callEnd(callId, event['is_error'] === true ? { ok: false, error: text !== '' ? text : 'The call failed.' } : { ok: true, result: text })
    }
  }

  // Reads one delegate thread and applies the calls not applied before. A failed read changes nothing; the
  // next poll tries again.
  async function drain(threadId: string): Promise<void> {
    if (tracker === undefined) return
    try {
      const events = await deps.api.listThreadEvents(sessionId, threadId)
      let ids = applied.get(threadId)
      if (ids === undefined) applied.set(threadId, (ids = new Set()))
      for (const event of events) {
        if (ids.has(event.id)) continue
        ids.add(event.id)
        quietly(() => toolEvent(threadKey(threadId), event))
      }
    } catch {
      // The delegate stays without (more) nested calls.
    }
  }

  async function close(threadId: string, end: { ok: boolean; result?: string; error?: string }): Promise<void> {
    const callId = open.get(threadId)
    if (callId === undefined) return
    await drain(threadId)
    open.delete(threadId)
    quietly(() => tracker?.callEnd(callId, end))
    quietly(() => tracker?.unwatch(threadKey(threadId)))
  }

  return {
    // Applied to every new session event, before the poll acts on it.
    async event(event: SessionEvent): Promise<void> {
      if (tracker === undefined) return
      try {
        if (event.type === 'agent.thread_message_sent') {
          const threadId = event['to_session_thread_id']
          if (typeof threadId !== 'string' || open.has(threadId)) return
          const name = String(event['to_agent_name'] ?? threadId)
          const helper = helperOf(name)
          const callId = tracker.childOf(topKey, threadKey(threadId), helper?.name ?? name, helper?.id)
          if (callId !== undefined) open.set(threadId, callId)
        } else if (event.type === 'agent.thread_message_received') {
          const threadId = event['from_session_thread_id']
          if (typeof threadId === 'string') await close(threadId, { ok: true, result: contentText(event) })
        } else if (event.type === 'session.thread_status_terminated') {
          const threadId = event['session_thread_id']
          if (typeof threadId !== 'string') return
          const error = errorOf(event)
          await close(threadId, error === undefined ? { ok: true } : { ok: false, error })
        } else {
          toolEvent(topKey, event)
        }
      } catch {
        // Activity is only for display.
      }
    },

    // After a poll: the nested calls of the delegates still open.
    async threads(): Promise<void> {
      for (const threadId of [...open.keys()]) await drain(threadId)
    },

    // The session is over: nothing it started stays running. Its open calls (and open delegates, with the calls
    // under them) end as the runner ends a node's: "Stopped." after a stop, else not finished.
    finish(isStopped: boolean): void {
      quietly(() => tracker?.endOpen(isStopped ? STOPPED_TEXT : UNFINISHED_TEXT, node.id))
      calls.clear()
      for (const threadId of open.keys()) quietly(() => tracker?.unwatch(threadKey(threadId)))
      open.clear()
      quietly(() => tracker?.unwatch(topKey))
    },
  }
}
