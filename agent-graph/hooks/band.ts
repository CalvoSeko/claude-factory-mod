import type { AgentInfo } from 'claude-code'

import type { BandAgent, Graph, RunPlan, RunView } from '../types'
import { outgoing } from './model'

// What the band above the prompt shows after its button: who works, who waits for the person, who is next,
// and the session's own subagents. Pure, so the hooks module draws it and the tests read it.

export type Capped<T> = { shown: T[]; more: number }
export type BandLine = {
  working: Capped<{ name: string; isHelper: boolean; current?: string }>
  paused: Capped<string>
  next: Capped<string>
  agents: Capped<BandAgent>
}

const NAMES_SHOWN = 3
const AGENTS_SHOWN = 4
const CURRENT_MAX = 30

const capped = <T>(items: T[], max: number): Capped<T> => ({ shown: items.slice(0, max), more: Math.max(0, items.length - max) })
// At most `max` characters, the last one an ellipsis when cut.
const cut = (text: string, max: number) => {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

export function runPlan(g: Graph): RunPlan {
  const targets = (kind: 'handoff' | 'retry') => Object.fromEntries(g.nodes.map(n => [n.id, outgoing(g, n.id, kind).map(e => e.to)]))
  return { names: Object.fromEntries(g.nodes.map(n => [n.id, n.name])), next: targets('handoff'), retry: targets('retry') }
}

export function bandLine(run: RunView | null, agents: BandAgent[]): BandLine {
  const live = run?.isRunning === true ? Object.entries(run.nodes) : []
  const name = (id: string) => run?.plan?.names[id] ?? id
  const working = live.filter(([, v]) => v.status === 'running')
  const paused = live.filter(([, v]) => v.status === 'paused').map(([id]) => id)
  const active = [...working.map(([id]) => id), ...paused]
  const targets = (of: Record<string, string[]> | undefined, keep: (id: string) => boolean) =>
    [...new Set(active.flatMap(id => of?.[id] ?? []))].filter(keep)
  const handoffs = targets(run?.plan?.next, id => run?.nodes[id]?.status === 'waiting')
  const next = handoffs.length > 0 ? handoffs : targets(run?.plan?.retry, () => true)
  return {
    working: capped(working.map(([id, v]) => ({
      name: name(id),
      isHelper: v.calledBy !== undefined,
      ...(v.current !== undefined && v.current !== '' ? { current: cut(v.current, CURRENT_MAX) } : {}),
    })), NAMES_SHOWN),
    paused: capped(paused.map(name), NAMES_SHOWN),
    next: capped(next.map(name), NAMES_SHOWN),
    agents: capped(agents, AGENTS_SHOWN),
  }
}

// The subagents at work in this session, less the graph's own cards (the band shows those already).
export const workingAgents = (list: AgentInfo[]): BandAgent[] =>
  list
    .filter(a => (a.status === 'running' || a.status === 'pending') && a.spawnedBy !== 'agent-graph')
    .map(a => ({ id: a.id, description: a.description, type: a.type }))
