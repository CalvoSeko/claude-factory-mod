import type { AgentNode, Graph } from '../types'
import { isCap, usdText } from './cost'
import { nodeById, outgoing } from './model'

// An imported graph is untrusted until the person approves it in the pane; graphs made there (no flag) are trusted.
export const isTrusted = (g: Graph): boolean => g.trusted !== false

// What a tool call or a Step/From here/test run of an untrusted graph is told.
export const notTrustedText = (g: Graph): string =>
  `Agent graph ${JSON.stringify(g.name)} was imported and is not trusted yet: open it in the agent graph pane and press ▶ Run to review it.`

const BACKEND_LINES: Record<Graph['backend'], string> = {
  local: 'Runs on Local',
  headless: 'Runs on Headless: each agent card is its own claude -p in auto mode',
  cloud: 'Runs on Cloud: context files are uploaded',
}

const q = (text: string) => JSON.stringify(text)

// The lines of one card in the approval view (and in read_graph), author text as unclipped JSON literals.
export function cardLines(g: Graph, n: AgentNode): string[] {
  if (n.check !== undefined) return [`Check ${q(n.name)} runs ${q(n.check.command)} (timeout ${n.check.timeoutMin} min)`]
  const tools = n.tools.length === 0 ? 'all' : n.tools.map(q).join(', ')
  const whenToUse = n.whenToUse !== undefined && n.whenToUse.trim() !== '' ? ` · when to use ${q(n.whenToUse)}` : ''
  const helpers = outgoing(g, n.id, 'delegate').flatMap(e => nodeById(g, e.to)?.name ?? []).map(q)
  return [
    `Agent ${q(n.name)}: tools ${tools} · model ${n.model === null ? 'default' : q(n.model)} · budget $${n.budgetUsd}${whenToUse}`,
    `  context: ${n.contextFiles.map(q).join(', ') || 'none'}`,
    `  helpers: ${helpers.join(', ') || 'none'}`,
  ]
}

// The approval view's lines, in order: backend, description, run cap, then every card. Every string the graph's
// author wrote is a JSON literal (a newline shows as \n) and is never clipped.
export function trustLines(g: Graph): string[] {
  return [
    BACKEND_LINES[g.backend],
    g.description === '' ? 'Description: none' : `Description (shown to Claude as the tool's text): ${q(g.description)}`,
    `Run cap: ${isCap(g.runCapUsd) ? usdText(g.runCapUsd) : 'none'}`,
    ...g.nodes.flatMap(n => cardLines(g, n)),
  ]
}
