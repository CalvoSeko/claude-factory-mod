import type { ActivityItem } from '../types'

// What each agent of a run called, as it happens. Pure: the backends feed it (Local from tool-call
// hooks, Cloud from the session's events), the runner copies it into the view. Nothing here may
// throw into a caller: a tracker problem never fails a tool call or a run.

export const MAX_ITEMS = 200
// Characters of `input` + `result` + `error` text kept per agent; past it new items keep only their summary
// (and a short error line, so a red row still says why).
export const BUDGET_CHARS = 100_000
export const TEXT_MAX = 2048
export const SUMMARY_MAX = 80
export const ERROR_SHORT = 200
// How a call still open ends: the person stopped the run, or its agent (or session) ended without it.
export const STOPPED_TEXT = 'Stopped.'
export const UNFINISHED_TEXT = 'Not finished when the run ended.'

export type CallEnd = { ok: boolean; result?: string; error?: string; denied?: boolean }

// One delegate helper as the graph shows it, over all the calls made to it.
export type HelperCall = {
  nodeId: string
  name: string
  // The agent that called it (the delegating helper's id when the call is nested).
  calledBy: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  endedAt?: number
  error?: string
  items: ActivityItem[]
  current?: string
}

export type Tracker = {
  // The calls of agent `agentKey` (a backend's own id for it) belong to graph node `nodeId`.
  watch(agentKey: string, nodeId: string): void
  unwatch(agentKey: string): void
  // Whether the key is watched (a plain lookup: hooks ask it before doing any work for a call).
  isWatched(agentKey: string): boolean
  // The call's id, or undefined when the key is not watched.
  callStart(agentKey: string, tool: string, input: unknown): string | undefined
  callEnd(callId: string, end: CallEnd): void
  // The child's future calls nest under the parent's open `Agent` call `callId` when given, else the oldest open
  // one, or under a new delegate item. Returns that call's id, so a backend that opened the item can close it with callEnd.
  childOf(parentKey: string, childKey: string, delegateName: string, nodeId?: string, callId?: string): string | undefined
  // Ends every call still running, nested ones too, as failed with `reason` (STOPPED_TEXT or UNFINISHED_TEXT):
  // of agent `nodeId`, or of every agent. A later callEnd for one of them changes nothing.
  endOpen(reason: string, nodeId?: string): void
  // The agent's calls, oldest first (live: do not change it).
  itemsOf(nodeId: string): ActivityItem[]
  // Summary of the innermost running call (its tool name when it has no summary).
  currentOf(nodeId: string): string | undefined
  // The delegate helpers (delegate items with a node id) under the agent's calls, however deep.
  helpersOf(nodeId: string): HelperCall[]
  // `listener(nodeId)` is told which agent's list changed (nested calls change their top agent's list).
  subscribe(listener: (nodeId: string) => void): () => void
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max - 1
  // Never cut a surrogate pair in two.
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--
  return `${text.slice(0, end)}…`
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// One line for a call, by tool (≤ 80 characters).
export function summarize(tool: string, input: unknown): string {
  try {
    const fields = isRecord(input) ? input : {}
    const str = (key: string) => {
      const v = fields[key]
      return typeof v === 'string' && v.trim() !== '' ? v : undefined
    }
    const firstString = () => (typeof input === 'string' ? input : Object.values(fields).find((v): v is string => typeof v === 'string'))
    let line: string | undefined
    if (tool === 'Bash' || tool === 'Check') {
      line = str('command')?.split(/\r?\n/).find(l => l.trim() !== '')
    } else if (tool === 'Read' || tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
      line = str('file_path')
    } else if (tool === 'Grep') {
      const pattern = str('pattern')
      const path = str('path')
      line = pattern === undefined ? undefined : path === undefined ? pattern : `${pattern} in ${path}`
    } else if (tool === 'Glob') {
      line = str('pattern')
    } else if (tool === 'WebFetch') {
      line = str('url')
    } else if (tool === 'WebSearch') {
      line = str('query')
    } else if (tool === 'Agent') {
      line = str('description') ?? str('subagent_type')
    } else {
      const parts = tool.split('__')
      if (parts[0] === 'mcp' && parts.length >= 3) {
        const arg = firstString()
        return clip(oneLine(`${parts[1]}/${parts.slice(2).join('__')} ${typeof input === 'string' ? '' : (arg ?? '')}`), SUMMARY_MAX)
      }
    }
    return clip(oneLine(line ?? firstString() ?? ''), SUMMARY_MAX)
  } catch {
    return ''
  }
}

// The call's input as text: strings as they are, anything else as JSON.
function inputText(input: unknown): string | undefined {
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input)
    return typeof text === 'string' && text !== '' ? clip(text, TEXT_MAX) : undefined
  } catch {
    return undefined
  }
}

// `full`: the text budget has run out once, so nothing more is kept (a small text must not slip in after a large one was refused).
type Owner = { nodeId: string; used: number; full: boolean; items: ActivityItem[] }
type Watched = { owner: Owner; list: ActivityItem[] }

const sizeOf = (item: ActivityItem): number => 1 + (item.delegate?.items.reduce((sum, i) => sum + sizeOf(i), 0) ?? 0)

// Finished, with nothing under it still running: only such a call may be folded away.
const isClosed = (item: ActivityItem): boolean => item.status !== 'running' && (item.delegate?.items.every(isClosed) ?? true)

function innermost(items: ActivityItem[]): ActivityItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.status === 'running') return (item.delegate === undefined ? undefined : innermost(item.delegate.items)) ?? item
  }
  return undefined
}

export function createTracker(onChange: (nodeId: string) => void, now: () => number): Tracker {
  const owners = new Map<string, Owner>()
  const watched = new Map<string, Watched>()
  const calls = new Map<string, { item: ActivityItem; owner: Owner }>()
  // How many calls a collapsed item stands for.
  const collapsed = new WeakMap<ActivityItem, number>()
  // How much of its agent's budget an item's own text holds.
  const charged = new WeakMap<ActivityItem, number>()
  const chargedOf = (item: ActivityItem): number => (charged.get(item) ?? 0) + (item.delegate?.items.reduce((sum, i) => sum + chargedOf(i), 0) ?? 0)
  const listeners = new Set<(nodeId: string) => void>([onChange])
  let serial = 0

  const clock = () => {
    try {
      return now()
    } catch {
      return 0
    }
  }
  const emit = (nodeId: string) => {
    for (const listener of [...listeners]) {
      try {
        listener(nodeId)
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  // Folds the first two finished calls of the list into one item; their text goes back to the budget.
  const foldIn = (owner: Owner, list: ActivityItem[]): boolean => {
    const at: number[] = []
    for (let i = 0; i < list.length && at.length < 2; i++) if (isClosed(list[i]!)) at.push(i)
    if (at.length === 2) {
      const [a, b] = [list[at[0]!]!, list[at[1]!]!]
      const n = (collapsed.get(a) ?? sizeOf(a)) + (collapsed.get(b) ?? sizeOf(b))
      const merged: ActivityItem = {
        id: `c${++serial}`,
        tool: '…',
        summary: `… ${n} earlier calls`,
        status: 'ok',
        startedAt: a.startedAt,
        endedAt: Math.max(a.endedAt ?? a.startedAt, b.endedAt ?? b.startedAt),
      }
      collapsed.set(merged, n)
      owner.used = Math.max(0, owner.used - chargedOf(a) - chargedOf(b))
      if (owner.used < BUDGET_CHARS) owner.full = false
      list.splice(at[1]!, 1)
      list.splice(at[0]!, 1, merged)
      return true
    }
    return list.some(item => item.delegate !== undefined && foldIn(owner, item.delegate.items))
  }
  // Past 200 calls (nested ones count too) the oldest finished ones fold into one item, in the agent's own
  // list first and then inside the calls under it. A running call, or one with a running call under it, stays.
  const collapseOldest = (owner: Owner) => {
    while (owner.items.reduce((sum, i) => sum + sizeOf(i), 0) > MAX_ITEMS && foldIn(owner, owner.items)) {
      // One fold at a time until it fits.
    }
  }
  // Keeps the item's text in the agent's budget; false when it does not fit.
  const spend = (owner: Owner, item: ActivityItem, text: string) => {
    if (owner.full || owner.used + text.length > BUDGET_CHARS) {
      owner.full = true
      return false
    }
    owner.used += text.length
    charged.set(item, (charged.get(item) ?? 0) + text.length)
    return true
  }
  const add = (w: Watched, item: ActivityItem) => {
    w.list.push(item)
    calls.set(item.id, { item, owner: w.owner })
    collapseOldest(w.owner)
  }

  return {
    watch(agentKey, nodeId) {
      let owner = owners.get(nodeId)
      if (owner === undefined) {
        owner = { nodeId, used: 0, full: false, items: [] }
        owners.set(nodeId, owner)
      }
      watched.set(agentKey, { owner, list: owner.items })
    },
    unwatch(agentKey) {
      watched.delete(agentKey)
    },
    isWatched: agentKey => watched.has(agentKey),
    callStart(agentKey, tool, input) {
      try {
        const w = watched.get(agentKey)
        if (w === undefined) return undefined
        const item: ActivityItem = { id: `c${++serial}`, tool, summary: summarize(tool, input), status: 'running', startedAt: clock() }
        // Added first: what the oldest calls give back when they fold is there for this one.
        add(w, item)
        const text = inputText(input)
        if (text !== undefined && spend(w.owner, item, text)) item.input = text
        emit(w.owner.nodeId)
        return item.id
      } catch {
        return undefined
      }
    },
    callEnd(callId, end) {
      try {
        const call = calls.get(callId)
        if (call === undefined || call.item.status !== 'running') return
        calls.delete(callId)
        const { item, owner } = call
        item.status = end.denied === true ? 'denied' : end.ok ? 'ok' : 'failed'
        item.endedAt = clock()
        if (typeof end.result === 'string' && end.result !== '') {
          const text = clip(end.result, TEXT_MAX)
          if (spend(owner, item, text)) item.result = text
        }
        if (typeof end.error === 'string' && end.error !== '') {
          const text = clip(end.error, TEXT_MAX)
          item.error = spend(owner, item, text) ? text : clip(end.error, ERROR_SHORT)
        }
        emit(owner.nodeId)
      } catch {
        // Recording is best effort.
      }
    },
    childOf(parentKey, childKey, delegateName, nodeId, callId) {
      try {
        const parent = watched.get(parentKey)
        if (parent === undefined) return undefined
        const delegate: NonNullable<ActivityItem['delegate']> = { name: delegateName, items: [], ...(nodeId !== undefined ? { nodeId } : {}) }
        const adoptable = (i: ActivityItem) => i.status === 'running' && i.tool === 'Agent' && i.delegate === undefined
        // The call the spawn belongs to; without it (or when it is not open here) the oldest open one.
        let item = (callId === undefined ? undefined : parent.list.find(i => i.id === callId && adoptable(i))) ?? parent.list.find(adoptable)
        if (item !== undefined) {
          item.delegate = delegate
        } else {
          item = { id: `c${++serial}`, tool: delegateName, summary: clip(oneLine(delegateName), SUMMARY_MAX), status: 'running', startedAt: clock(), delegate }
          add(parent, item)
        }
        watched.set(childKey, { owner: parent.owner, list: delegate.items })
        emit(parent.owner.nodeId)
        return item.id
      } catch {
        return undefined
      }
    },
    endOpen(reason, nodeId) {
      try {
        const at = clock()
        const end = (items: ActivityItem[]) => {
          for (const item of items) {
            if (item.status === 'running') {
              item.status = 'failed'
              item.endedAt = at
              item.error = reason
              calls.delete(item.id)
            }
            if (item.delegate !== undefined) end(item.delegate.items)
          }
        }
        const ending = nodeId === undefined ? [...owners.values()] : [owners.get(nodeId)].filter((o): o is Owner => o !== undefined)
        for (const owner of ending) {
          end(owner.items)
          // A delegate that is over records nothing more under it.
          for (const [key, w] of watched) if (w.owner === owner && w.list !== owner.items) watched.delete(key)
          emit(owner.nodeId)
        }
      } catch {
        // Recording is best effort.
      }
    },
    itemsOf: nodeId => owners.get(nodeId)?.items ?? [],
    currentOf(nodeId) {
      const item = innermost(owners.get(nodeId)?.items ?? [])
      return item === undefined ? undefined : item.summary !== '' ? item.summary : item.tool
    },
    helpersOf(nodeId) {
      const found = new Map<string, { name: string; calledBy: string; calls: ActivityItem[] }>()
      const walk = (items: ActivityItem[], caller: string) => {
        for (const item of items) {
          const d = item.delegate
          if (d === undefined) continue
          if (d.nodeId !== undefined) {
            const entry = found.get(d.nodeId) ?? { name: d.name, calledBy: caller, calls: [] }
            entry.calls.push(item)
            found.set(d.nodeId, entry)
          }
          walk(d.items, d.nodeId ?? caller)
        }
      }
      walk(owners.get(nodeId)?.items ?? [], nodeId)
      return [...found].map(([id, entry]): HelperCall => {
        const running = entry.calls.some(c => c.status === 'running')
        const last = entry.calls.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a))
        const items = entry.calls.flatMap(c => c.delegate?.items ?? [])
        const inner = innermost(items)
        const ends = entry.calls.map(c => c.endedAt)
        return {
          nodeId: id,
          name: entry.name,
          calledBy: entry.calledBy,
          // A call ended by a stop leaves its helper cancelled, as the agents the stop ended.
          status: running ? 'running' : last.status === 'ok' ? 'done' : last.error === STOPPED_TEXT ? 'cancelled' : 'failed',
          startedAt: Math.min(...entry.calls.map(c => c.startedAt)),
          ...(!running && ends.every(e => e !== undefined) ? { endedAt: Math.max(...(ends as number[])) } : {}),
          ...(!running && last.status !== 'ok' && last.error !== undefined ? { error: last.error } : {}),
          items,
          ...(inner !== undefined ? { current: inner.summary !== '' ? inner.summary : inner.tool } : {}),
        }
      })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
