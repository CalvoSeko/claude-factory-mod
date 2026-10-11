import type { ToolSpec } from 'claude-code'
import type { AgentNode, Edge, EdgeKind, Graph } from '../types'
import { isCap, usdText } from './cost'
import { agentNode, EDGE_KINDS, inGraphFolder, INSTRUCTIONS_TEMPLATE, isBudget, isRecord, isRetries, isRunCap, isTextList, isTimeout } from './library'
import {
  checkNode, connect, disconnect, freeSpot, MAX_BUDGET_USD, MAX_CHECK_TIMEOUT_MIN, MAX_RETRIES, MAX_RUN_CAP_USD, MAX_XY, newId, nodeById, retype,
  updateNode, withoutNode,
} from './model'

export const EDIT_TOOL = 'edit_graph'

export type Effect = { kind: 'write'; path: string; text: string } | { kind: 'remove'; path: string }
export type Plan = {
  graph: Graph          // the graph after every change (trusted flag untouched)
  base: Graph           // the graph it was planned from (compared again inside the lock)
  effects: Effect[]     // instructions files, in batch order; every path passed inGraphFolder(root, base.id, path)
  lines: string[]       // one per change, every value in full
  alwaysAsk: boolean    // adds a check card, or changes a check card's command
}
export type PlanContext = { root: string; otherNames: ReadonlySet<string> }  // other graphs' names, lower-cased

const OPS = ['add_card', 'update_card', 'set_instructions', 'remove_card', 'add_arrow', 'update_arrow', 'remove_arrow', 'set_graph'] as const
type Op = (typeof OPS)[number]
const isOp = (v: unknown): v is Op => OPS.some(op => op === v)

const AGENT_FIELDS = ['model', 'tools', 'skills', 'contextFiles', 'budgetUsd', 'whenToUse'] as const
const CHECK_FIELDS = ['command', 'timeoutMin'] as const
const CARD_FIELDS = ['name', 'pauseBefore', 'disabled', 'x', 'y', ...AGENT_FIELDS, ...CHECK_FIELDS] as const
type CardField = (typeof CARD_FIELDS)[number]
const AGENT_ONLY: ReadonlySet<CardField> = new Set(AGENT_FIELDS)
const CHECK_ONLY: ReadonlySet<CardField> = new Set(CHECK_FIELDS)
// What an add_card line already says before its other fields.
const IN_ADD_HEAD: ReadonlySet<CardField> = new Set(['name', 'x', 'y', ...CHECK_FIELDS])

// The keys each op takes. Any other key refuses the batch: this keeps an agent from becoming a check (or its
// instructions file from moving) without the dialog.
const KEYS: Record<Op, readonly string[]> = {
  add_card: ['op', 'kind', ...CARD_FIELDS],
  update_card: ['op', 'card', ...CARD_FIELDS],
  set_instructions: ['op', 'card', 'text'],
  remove_card: ['op', 'card'],
  add_arrow: ['op', 'from', 'to', 'kind', 'retries'],
  update_arrow: ['op', 'arrow', 'kind', 'retries'],
  remove_arrow: ['op', 'arrow'],
  set_graph: ['op', 'name', 'description', 'backend', 'runCapUsd'],
}

// Author text is always a JSON literal, never clipped (as trustLines prints it).
const q = (x: unknown) => JSON.stringify(x)
const isEdgeKind = (v: unknown): v is EdgeKind => typeof v === 'string' && EDGE_KINDS.has(v)
const cardText = (n: AgentNode) => `${n.check !== undefined ? 'check' : 'agent'} ${q(n.name)} (${n.id})`
const ends = (g: Graph, e: Edge) => `${q(nodeById(g, e.from)?.name ?? e.from)} → ${q(nodeById(g, e.to)?.name ?? e.to)}`
const retriesText = (e: Edge) => (e.retries === undefined ? '' : `, ${e.retries} retries`)
const withEdge = (g: Graph, edge: Edge): Graph => ({ ...g, edges: g.edges.map(e => (e.id === edge.id ? edge : e)) })

const LABELS: Partial<Record<CardField, string>> = { pauseBefore: 'pause before', budgetUsd: 'budget', timeoutMin: 'timeout' }
const label = (key: CardField) => LABELS[key] ?? key

// How a card's field reads in a change line.
function show(key: CardField, n: AgentNode): string {
  switch (key) {
    case 'name': return q(n.name)
    case 'whenToUse': return q(n.whenToUse ?? '')
    case 'pauseBefore': case 'disabled': return n[key] === true ? 'yes' : 'no'
    case 'x': case 'y': return String(n[key])
    case 'model': return n.model === null ? 'default' : q(n.model)
    case 'tools': return n.tools.length === 0 ? 'all' : n.tools.map(q).join(', ')
    case 'skills': case 'contextFiles': return n[key].map(q).join(', ') || 'none'
    case 'budgetUsd': return `$${n.budgetUsd}`
    case 'command': return q(n.check?.command)
    case 'timeoutMin': return `${n.check?.timeoutMin} min`
  }
}

// The card with one field set from a change's value; a string says what the field allows.
function withField(n: AgentNode, key: CardField, v: unknown): AgentNode | string {
  switch (key) {
    case 'name': return typeof v === 'string' && v.trim() !== '' ? { ...n, name: v.trim() } : 'text that is not empty'
    case 'whenToUse': return typeof v === 'string' ? { ...n, whenToUse: v.trim() } : 'text'
    case 'pauseBefore': case 'disabled': return typeof v === 'boolean' ? { ...n, [key]: v } : 'true or false'
    case 'x': case 'y': return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_XY ? { ...n, [key]: Math.round(v) } : `a number from 0 to ${MAX_XY}`
    case 'model': return v === null || typeof v === 'string' ? { ...n, model: v?.trim() || null } : 'text, or null for the default model'
    case 'tools': case 'skills': case 'contextFiles': return isTextList(v) ? { ...n, [key]: v } : 'a list of text'
    case 'budgetUsd': return isBudget(v) ? { ...n, budgetUsd: v } : `a number of dollars above 0 and at most ${MAX_BUDGET_USD}`
    case 'command': return typeof v === 'string' && n.check !== undefined ? { ...n, check: { ...n.check, command: v.trim() } } : 'text'
    case 'timeoutMin':
      return isTimeout(v) && n.check !== undefined ? { ...n, check: { ...n.check, timeoutMin: v } } : `a whole number of minutes from 1 to ${MAX_CHECK_TIMEOUT_MIN}`
  }
}

type Refuse = (field: string, why: string) => string

// The card with every field the change sets, and those fields in order.
function fieldsOf(g: Graph, n: AgentNode, c: Record<string, unknown>, refuse: Refuse): { node: AgentNode; set: CardField[] } | string {
  let node = n
  const set: CardField[] = []
  for (const key of CARD_FIELDS) {
    if (!(key in c)) continue
    if (n.check !== undefined && AGENT_ONLY.has(key)) return refuse(key, 'only agent cards have it')
    if (n.check === undefined && CHECK_ONLY.has(key)) return refuse(key, 'only check cards have it')
    const next = withField(node, key, c[key])
    if (typeof next === 'string') return refuse(key, next)
    const other = key === 'name' ? g.nodes.find(o => o.id !== n.id && o.name.trim().toLowerCase() === next.name.toLowerCase()) : undefined
    if (other !== undefined) return refuse('name', `another card is called ${q(other.name)}`)
    node = next
    set.push(key)
  }
  return { node, set }
}

// A card by id, else by its exact name; a string says why none is found.
function cardOf(g: Graph, ref: unknown): AgentNode | string {
  const byId = g.nodes.find(n => n.id === ref)
  if (byId !== undefined) return byId
  const named = g.nodes.filter(n => n.name === ref)
  if (named.length === 1) return named[0]!
  return named.length === 0 ? `no card has the id or name ${q(ref)}` : `${named.length} cards are called ${q(ref)}: name it by its id`
}

// The arrow with the change's retries, when it has any.
function withRetries(e: Edge, c: Record<string, unknown>, refuse: Refuse): Edge | string {
  if (!('retries' in c)) return e
  if (e.kind !== 'retry') return refuse('retries', 'only retry arrows have retries')
  const retries = c['retries']
  return isRetries(retries) ? { ...e, retries } : refuse('retries', `a whole number from 0 to ${MAX_RETRIES}`)
}

type Step = { graph: Graph; line: string; effect?: Effect; ask?: boolean }
type StepContext = { root: string; graphId: string; otherNames: ReadonlySet<string>; written: (path: string) => boolean; refuse: Refuse }

// One change applied to the graph as it stands; a string says why the batch is refused.
function step(g: Graph, op: Op, c: Record<string, unknown>, at: StepContext): Step | string {
  const { refuse } = at
  switch (op) {
    case 'add_card': {
      const kind = c['kind']
      if (kind !== 'agent' && kind !== 'check') return refuse('kind', '"agent" or "check"')
      if (kind === 'check' && g.backend === 'cloud') return refuse('kind', 'a Cloud graph cannot have check cards')
      if (!('name' in c)) return refuse('name', 'text that is not empty')
      const spot = freeSpot(g)
      const blank = kind === 'check' ? checkNode('', spot.x, spot.y) : agentNode(at.root, at.graphId, '', spot.x, spot.y)
      const fields = fieldsOf(g, blank, c, refuse)
      if (typeof fields === 'string') return fields
      const n = fields.node
      const rest = fields.set.filter(k => !IN_ADD_HEAD.has(k)).map(k => `; ${label(k)}: ${show(k, n)}`).join('')
      const head = `add ${cardText(n)} at x ${n.x}, y ${n.y}`
      const graph = { ...g, nodes: [...g.nodes, n] }
      return n.check !== undefined
        ? { graph, line: `${head} running ${q(n.check.command)} (timeout ${n.check.timeoutMin} min)${rest}`, ask: true }
        : { graph, line: head + rest, effect: { kind: 'write', path: n.instructionsFile, text: INSTRUCTIONS_TEMPLATE(n.name) } }
    }
    case 'update_card': {
      const n = cardOf(g, c['card'])
      if (typeof n === 'string') return refuse('card', n)
      const fields = fieldsOf(g, n, c, refuse)
      if (typeof fields === 'string') return fields
      const after = fields.node
      return {
        graph: updateNode(g, n.id, after),
        line: `update ${cardText(n)}: ${fields.set.map(k => `${label(k)}: ${show(k, n)} → ${show(k, after)}`).join('; ')}`,
        ask: n.check !== undefined && after.check?.command !== n.check.command,
      }
    }
    case 'set_instructions': {
      const n = cardOf(g, c['card'])
      if (typeof n === 'string') return refuse('card', n)
      if (n.check !== undefined) return refuse('card', 'a check card has no instructions')
      const text = c['text']
      if (typeof text !== 'string') return refuse('text', 'text')
      // A file written earlier in this batch is written again; otherwise a new version, so an undo brings the old text back.
      // ponytail: superseded instructions versions stay until the graph is deleted; prune on save if folders grow
      const path = at.written(n.instructionsFile) ? n.instructionsFile : `${at.root}/${at.graphId}/${newId(n.id)}.md`
      return {
        graph: updateNode(g, n.id, { instructionsFile: path }),
        line: `set the instructions of ${cardText(n)} to ${q(text)}`,
        effect: { kind: 'write', path, text },
      }
    }
    case 'remove_card': {
      const n = cardOf(g, c['card'])
      if (typeof n === 'string') return refuse('card', n)
      const arrows = g.edges.filter(e => e.from === n.id || e.to === n.id)
      const list = arrows.map(e => `${e.id} ${ends(g, e)} ${e.kind}${e.retries === undefined ? '' : ` (${e.retries} retries)`}`).join(', ')
      return {
        graph: withoutNode(g, n.id),
        line: `remove ${cardText(n)} ${list === '' ? 'and no arrows' : `and its arrows: ${list}`}`,
        ...(n.check === undefined ? { effect: { kind: 'remove', path: n.instructionsFile } } : {}),
      }
    }
    case 'add_arrow': {
      const from = cardOf(g, c['from'])
      if (typeof from === 'string') return refuse('from', from)
      const to = cardOf(g, c['to'])
      if (typeof to === 'string') return refuse('to', to)
      const kind = c['kind']
      if (!isEdgeKind(kind)) return refuse('kind', '"handoff", "delegate" or "retry"')
      if (from.id === to.id) return refuse('to', 'an arrow cannot join a card to itself')
      if (g.edges.some(e => e.from === from.id && e.to === to.id && e.kind === kind)) return refuse('to', `a ${kind} arrow already joins these cards`)
      const joined = connect(g, from.id, to.id, kind)
      const edge = withRetries(joined.edges[joined.edges.length - 1]!, c, refuse)
      if (typeof edge === 'string') return edge
      return {
        graph: withEdge(joined, edge),
        line: `add arrow (${edge.id}) ${q(from.name)} (${from.id}) → ${q(to.name)} (${to.id}): ${edge.kind}${retriesText(edge)}`,
      }
    }
    case 'update_arrow': {
      const edge = g.edges.find(e => e.id === c['arrow'])
      if (edge === undefined) return refuse('arrow', `no arrow has the id ${q(c['arrow'])}`)
      let next = g
      if ('kind' in c) {
        const kind = c['kind']
        if (!isEdgeKind(kind)) return refuse('kind', '"handoff", "delegate" or "retry"')
        // retype would drop this arrow onto the other one.
        if (g.edges.some(e => e.id !== edge.id && e.from === edge.from && e.to === edge.to && e.kind === kind)) {
          return refuse('kind', `a ${kind} arrow already joins these cards`)
        }
        next = retype(g, edge.id, kind)
      }
      const after = withRetries(next.edges.find(e => e.id === edge.id)!, c, refuse)
      if (typeof after === 'string') return after
      const parts = [
        ...('kind' in c ? [`kind ${edge.kind} → ${after.kind}`] : []),
        ...('retries' in c || after.retries !== edge.retries ? [`retries ${edge.retries ?? 'none'} → ${after.retries ?? 'none'}`] : []),
      ]
      return { graph: withEdge(next, after), line: `update arrow ${edge.id} ${ends(g, edge)}: ${parts.join('; ')}` }
    }
    case 'remove_arrow': {
      const edge = g.edges.find(e => e.id === c['arrow'])
      if (edge === undefined) return refuse('arrow', `no arrow has the id ${q(c['arrow'])}`)
      return { graph: disconnect(g, edge.id), line: `remove arrow ${edge.id} ${ends(g, edge)} (${edge.kind}${retriesText(edge)})` }
    }
    case 'set_graph': {
      let next = g
      const parts: string[] = []
      if ('name' in c) {
        const name = typeof c['name'] === 'string' ? c['name'].trim() : ''
        if (name === '') return refuse('name', 'text that is not empty')
        if (at.otherNames.has(name.toLowerCase())) return refuse('name', `another graph is called ${q(name)}`)
        parts.push(`name ${q(g.name)} → ${q(name)}`)
        next = { ...next, name }
      }
      if ('description' in c) {
        const description = c['description']
        if (typeof description !== 'string') return refuse('description', 'text')
        parts.push(`description ${q(g.description)} → ${q(description.trim())}`)
        next = { ...next, description: description.trim() }
      }
      if ('backend' in c) {
        const backend = c['backend']
        if (backend !== 'local' && backend !== 'headless' && backend !== 'cloud') return refuse('backend', '"local", "headless" or "cloud"')
        parts.push(`backend ${q(g.backend)} → ${q(backend)}`)
        next = { ...next, backend }
      }
      if ('runCapUsd' in c) {
        const cap = c['runCapUsd']
        if (!isRunCap(cap)) return refuse('runCapUsd', `a number of dollars above 0 and at most ${MAX_RUN_CAP_USD}`)
        parts.push(`run cap ${isCap(g.runCapUsd) ? usdText(g.runCapUsd) : 'none'} → ${usdText(cap)}`)
        next = { ...next, runCapUsd: cap }
      }
      return { graph: next, line: `set graph: ${parts.join('; ')}` }
    }
  }
}

// Checks a batch of edit_graph changes and applies them, in order, to `base` in memory. A string says why the
// whole batch is refused: `Change <n> (<op>) <field>: <what is allowed>.`
export function planEdit(base: Graph, changes: unknown, ctx: PlanContext): Plan | string {
  if (!Array.isArray(changes) || changes.length === 0) return 'changes: a list of at least one change.'
  let g = base
  const effects: Effect[] = []
  const lines: string[] = []
  let alwaysAsk = false
  const written = (path: string) => effects.some(e => e.kind === 'write' && e.path === path)
  for (const [i, c] of changes.entries()) {
    const op = isRecord(c) ? c['op'] : undefined
    if (!isRecord(c) || !isOp(op)) return `Change ${i + 1} op: one of ${OPS.map(q).join(', ')}.`
    const refuse: Refuse = (field, why) => `Change ${i + 1} (${op}) ${field}: ${why}.`
    const extra = Object.keys(c).find(k => !KEYS[op].includes(k))
    if (extra !== undefined) return refuse(extra, `not a field ${op} takes`)
    const s = step(g, op, c, { root: ctx.root, graphId: base.id, otherNames: ctx.otherNames, written, refuse })
    if (typeof s === 'string') return s
    const effect = s.effect
    if (effect !== undefined) {
      // filesOf refuses a path outside the folder with only a toast: the card would point at a file never written.
      if (!inGraphFolder(ctx.root, base.id, effect.path)) return `Change ${i + 1} (${op}): its file ${q(effect.path)} is outside the graph's folder.`
      // A later effect on a file of this batch replaces the earlier one.
      const same = effects.findIndex(e => e.path === effect.path)
      if (same === -1) effects.push(effect)
      else effects[same] = effect
    }
    g = s.graph
    lines.push(s.line)
    alwaysAsk ||= s.ask === true
  }
  return { graph: g, base, effects, lines, alwaysAsk }
}

export const approvalQuestion = (g: Graph, lines: string[]): string =>
  [
    `Claude wants to change agent graph ${q(g.name)} (${g.id}):`,
    ...lines.map(line => `- ${line}`),
    `Apply ${lines.length === 1 ? 'this change' : `these ${lines.length} changes`}?`,
  ].join('\n')

// The tool's input, so register.tsx can match the literal tool name. It must mirror the inputSchema below exactly: after a save of the mod, the generated .claude-plugin/types/claude-code-mcp/index.d.ts declares the same entry, and TypeScript merges the two only when they are identical (else `npm run typecheck` fails with TS2717).
declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__agent-graph__edit_graph': { graph: string; changes: { op: Op }[] }
  }
}

export const EDIT_SPEC: ToolSpec = {
  name: EDIT_TOOL,
  description: [
    'Changes one agent graph of the agent graph pane as one undo step. The changes apply in order, all or none; an untrusted or running graph is refused, and the person may be asked to approve.',
    'Name a card by its id, or else its exact name as the graph is at that point in the batch; name an arrow by its id (read_graph shows them).',
    'Ops and their fields:',
    '- add_card: kind ("agent" or "check"), name, and any card fields',
    '- update_card: card, and any card fields',
    '- set_instructions: card (an agent), text (the whole new instructions)',
    '- remove_card: card (its arrows go too)',
    '- add_arrow: from, to, kind ("handoff", "delegate" or "retry"), retries (retry arrows only, 0 to 10)',
    '- update_arrow: arrow, kind, retries',
    '- remove_arrow: arrow',
    '- set_graph: name, description, backend ("local", "headless" or "cloud"), runCapUsd (above 0, at most 500)',
    'Card fields: name, pauseBefore, disabled, x, y (0 to 1000). Agents only: model (null for the default), tools (a list; [] means every tool), skills, contextFiles, budgetUsd (above 0, at most 100), whenToUse. Checks only: command (a shell command), timeoutMin (1 to 60).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      graph: { type: 'string', description: 'The graph id, or its exact name' },
      changes: {
        type: 'array',
        minItems: 1,
        items: { type: 'object', properties: { op: { type: 'string', enum: [...OPS] } }, required: ['op'] },
      },
    },
    required: ['graph', 'changes'],
  },
}
