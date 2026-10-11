import type { AgentNode, Edge, EdgeKind, Graph } from '../types'

export type ProblemTarget = { kind: 'graph' } | { kind: 'node'; id: string } | { kind: 'edge'; id: string }
export type Problem = { target: ProblemTarget; message: string }

export const DEFAULT_BUDGET_USD = 2
// The most an imported graph keeps: a card's budget and the run cap. An import without a valid cap gets the default.
export const MAX_BUDGET_USD = 100
export const MAX_RUN_CAP_USD = 500
export const DEFAULT_RUN_CAP_USD = 20
export const DEFAULT_RETRIES = 3
export const MAX_RETRIES = 10
export const DEFAULT_CHECK_TIMEOUT_MIN = 10
export const MAX_CHECK_TIMEOUT_MIN = 60
export const MAX_XY = 1000
// The colour of retry arrows.
export const RETRY_COLOR = '#d97757'
export const MAX_CLOUD_DELEGATES = 20
export const NODE_W = 26
export const NODE_H = 5
// Graph.layout of graphs whose positions are for the 26×5 cards.
export const LAYOUT = 2 as const

// Claude Code tool names with a Managed Agents toolset equivalent.
export const CLOUD_TOOLS: Readonly<Record<string, string>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Bash: 'bash',
  Glob: 'glob',
  Grep: 'grep',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
}
export const TOOL_CHOICES = ['Read', 'Write', 'Edit', 'Bash', 'PowerShell', 'Glob', 'Grep', 'WebFetch', 'WebSearch']
export const MODEL_CHOICES = ['opus', 'sonnet', 'haiku', 'fable']

// The starter text of a new agent's instructions file.
export const NO_AGENTS = 'Add at least one agent.'
export const ALL_DISABLED = 'Every agent is disabled.'

const TEMPLATE_HEAD = 'You are '
const TEMPLATE_TAIL = ". Describe this agent's role, goals and style here."
export const INSTRUCTIONS_TEMPLATE = (name: string) => `${TEMPLATE_HEAD}${name}${TEMPLATE_TAIL}\n`
// Whether instructions are still the starter text: the file keeps the name the agent had when it was created, so any name counts.
const isStarterTemplate = (text: string) => {
  const t = text.trim()
  return t.length >= TEMPLATE_HEAD.length + TEMPLATE_TAIL.length && t.startsWith(TEMPLATE_HEAD) && t.endsWith(TEMPLATE_TAIL)
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
}

export function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return s === '' ? 'agent' : s
}

// Where a node's handoff files are mounted on Cloud: unique by node id, since
// different names can share a slug ("A/B" and "A B").
export const handoffDir = (name: string, id: string) => `${slug(name)}-${id.slice(-6)}`

export function emptyGraph(name: string): Graph {
  return { id: newId('g'), name, description: '', backend: 'local', nodes: [], edges: [], layout: LAYOUT }
}

// A new check card with no command yet.
export const checkNode = (name: string, x: number, y: number): AgentNode => ({
  id: newId('n'), name, x, y, instructionsFile: '', check: { command: '', timeoutMin: DEFAULT_CHECK_TIMEOUT_MIN },
  skills: [], contextFiles: [], tools: [], model: null, budgetUsd: DEFAULT_BUDGET_USD,
})

export const nodeById =(g: Graph, id: string): AgentNode | undefined => g.nodes.find(n => n.id === id)

// A check card runs a shell command instead of an agent.
export const isCheck = (node: AgentNode | undefined): boolean => node?.check !== undefined

export const outgoing = (g: Graph, id: string, kind?: EdgeKind): Edge[] =>
  g.edges.filter(e => e.from === id && (kind === undefined || e.kind === kind))

export const incoming = (g: Graph, id: string, kind?: EdgeKind): Edge[] =>
  g.edges.filter(e => e.to === id && (kind === undefined || e.kind === kind))

// Reached only through delegation: only its delegator ever runs it.
export function isDelegateOnly(g: Graph, id: string): boolean {
  return (
    incoming(g, id, 'delegate').length > 0 &&
    incoming(g, id, 'handoff').length === 0 &&
    outgoing(g, id, 'handoff').length === 0
  )
}

export const runnableNodes = (g: Graph): AgentNode[] => g.nodes.filter(n => !isDelegateOnly(g, n.id))
export const startNodes = (g: Graph): AgentNode[] =>
  runnableNodes(g).filter(n => incoming(g, n.id, 'handoff').length === 0)
export const endNodes = (g: Graph): AgentNode[] =>
  runnableNodes(g).filter(n => outgoing(g, n.id, 'handoff').length === 0)

// The retry arrow that leaves a card (the first, when a graph wrongly has several).
export const retryOut = (g: Graph, id: string): Edge | undefined => outgoing(g, id, 'retry')[0]

// The cards a retry arrow sends back: its target, its judge (where it starts) and every card on a handoff path from the target to the judge.
// An arrow whose target does not hand work on to its judge makes no loop: it has no cards.
export function loopOf(g: Graph, edge: Edge): Set<string> {
  if (edge.to === edge.from || !reachesByHandoff(g, edge.to, edge.from)) return new Set()
  const walk = (start: string, next: (id: string) => string[]): Set<string> => {
    const seen = new Set<string>()
    const queue = [start]
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...next(id))
    }
    return seen
  }
  const forward = walk(edge.to, id => outgoing(g, id, 'handoff').map(e => e.to))
  const backward = walk(edge.from, id => incoming(g, id, 'handoff').map(e => e.from))
  const loop = new Set([edge.to, edge.from])
  for (const id of forward) if (backward.has(id) && nodeById(g, id) !== undefined) loop.add(id)
  return loop
}

// The retry arrow whose loop a card belongs to, if any.
export const loopContaining = (g: Graph, id: string): Edge | undefined =>
  g.edges.find(e => e.kind === 'retry' && nodeById(g, e.from) !== undefined && nodeById(g, e.to) !== undefined && loopOf(g, e).has(id))

// Where a run from this card starts: a card of a retry loop other than its target starts the loop over, from the target.
export function runStart(g: Graph, id: string): string {
  const loop = loopContaining(g, id)
  return loop === undefined || loop.to === id ? id : loop.to
}

export function connect(g: Graph, from: string, to: string, kind: EdgeKind): Graph {
  if (g.edges.some(e => e.from === from && e.to === to && e.kind === kind)) return g
  return { ...g, edges: [...g.edges, { id: newId('e'), from, to, kind, ...(kind === 'retry' ? { retries: DEFAULT_RETRIES } : {}) }] }
}

export const disconnect = (g: Graph, edgeId: string): Graph => ({ ...g, edges: g.edges.filter(e => e.id !== edgeId) })

// The kind a retype goes to next: handoff, delegate, retry, handoff ...
export const nextKind = (kind: EdgeKind): EdgeKind => (kind === 'handoff' ? 'delegate' : kind === 'delegate' ? 'retry' : 'handoff')

// Changes an arrow's kind; when an arrow of that kind already joins the two agents, this one is dropped instead.
// A retry arrow starts with the default number of retries, and an arrow of another kind has none.
export function retype(g: Graph, edgeId: string, kind: EdgeKind): Graph {
  const edge = g.edges.find(e => e.id === edgeId)
  if (edge === undefined || edge.kind === kind) return g
  const isDuplicate = g.edges.some(e => e.id !== edgeId && e.from === edge.from && e.to === edge.to && e.kind === kind)
  const retyped = (e: Edge): Edge => {
    const { retries: _retries, ...rest } = e
    return { ...rest, kind, ...(kind === 'retry' ? { retries: DEFAULT_RETRIES } : {}) }
  }
  return { ...g, edges: isDuplicate ? g.edges.filter(e => e.id !== edgeId) : g.edges.map(e => (e.id === edgeId ? retyped(e) : e)) }
}

// Flips an arrow; when the flipped arrow already exists, this one is dropped instead.
export function reverse(g: Graph, edgeId: string): Graph {
  const edge = g.edges.find(e => e.id === edgeId)
  if (edge === undefined) return g
  const flipped = { ...edge, from: edge.to, to: edge.from }
  const isDuplicate = g.edges.some(e => e.id !== edgeId && e.from === flipped.from && e.to === flipped.to && e.kind === flipped.kind)
  return { ...g, edges: isDuplicate ? g.edges.filter(e => e.id !== edgeId) : g.edges.map(e => (e.id === edgeId ? flipped : e)) }
}

export const updateNode = (g: Graph, id: string, patch: Partial<Omit<AgentNode, 'id'>>): Graph => ({
  ...g,
  nodes: g.nodes.map(n => (n.id === id ? { ...n, ...patch } : n)),
})

export const withoutNode = (g: Graph, id: string): Graph => ({
  ...g,
  nodes: g.nodes.filter(n => n.id !== id),
  edges: g.edges.filter(e => e.from !== id && e.to !== id),
})

// Graphs saved with the 18×3 boxes are spread once, so the cards do not overlap.
export function upgradeLayout(g: Graph): Graph {
  if (g.layout === LAYOUT) return g
  return { ...g, layout: LAYOUT, nodes: g.nodes.map(n => ({ ...n, x: Math.round(n.x * 1.5), y: n.y * 2 })) }
}

// The node and everything reachable from it by any edge, with the edges among them.
export function subgraphFrom(g: Graph, id: string): Graph {
  const keep = new Set<string>()
  const visit = (at: string) => {
    if (keep.has(at) || nodeById(g, at) === undefined) return
    keep.add(at)
    for (const e of outgoing(g, at)) visit(e.to)
  }
  visit(id)
  return { ...g, nodes: g.nodes.filter(n => keep.has(n.id)), edges: g.edges.filter(e => keep.has(e.from) && keep.has(e.to)) }
}

// The first cell of a loose two-column grid (a new card's right edge stays within 80 columns) where a new box overlaps no other box.
export function freeSpot(g: Graph): { x: number; y: number } {
  for (let row = 0; ; row++) {
    for (let col = 0; col < 2; col++) {
      const x = 2 + col * (NODE_W + 6)
      const y = 1 + row * (NODE_H + 2)
      const overlaps = g.nodes.some(
        n => x < n.x + NODE_W + 2 && n.x < x + NODE_W + 2 && y < n.y + NODE_H + 1 && n.y < y + NODE_H + 1,
      )
      if (!overlaps) return { x, y }
    }
  }
}

function handoffCycleNodes(g: Graph): Set<string> {
  const state = new Map<string, 'open' | 'closed'>()
  const stack: string[] = []
  const inCycle = new Set<string>()
  const visit = (id: string) => {
    state.set(id, 'open')
    stack.push(id)
    for (const e of outgoing(g, id, 'handoff')) {
      const seen = state.get(e.to)
      if (seen === 'open') {
        for (let i = stack.indexOf(e.to); i < stack.length; i++) inCycle.add(stack[i]!)
      } else if (seen === undefined && nodeById(g, e.to) !== undefined) {
        visit(e.to)
      }
    }
    stack.pop()
    state.set(id, 'closed')
  }
  for (const n of g.nodes) if (!state.has(n.id)) visit(n.id)
  return inCycle
}

// Whether a chain of handoff arrows leads from one card to another.
function reachesByHandoff(g: Graph, from: string, to: string): boolean {
  const seen = new Set<string>()
  const queue = [from]
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of outgoing(g, id, 'handoff')) {
      if (e.to === to) return true
      queue.push(e.to)
    }
  }
  return false
}

// The rules of retry arrows (their problems sit on the arrow, or on the judge: the card an arrow leaves).
function retryProblems(g: Graph, onNode: (id: string, message: string) => void, onEdge: (id: string, message: string) => void): void {
  const retries = g.edges.filter(e => e.kind === 'retry')
  if (retries.length === 0) return
  const count = new Map<string, number>()
  for (const e of retries) count.set(e.from, (count.get(e.from) ?? 0) + 1)
  for (const [id, n] of count) {
    if (n > 1 && nodeById(g, id) !== undefined) onNode(id, 'Only one retry arrow can leave a card.')
  }
  // The arrows whose loop means something: both ends exist and the target hands work on to the judge.
  const loops: { edge: Edge; loop: Set<string> }[] = []
  for (const e of retries) {
    if (nodeById(g, e.from) === undefined || nodeById(g, e.to) === undefined) continue
    if (isCheck(nodeById(g, e.to))) {
      onEdge(e.id, 'A retry arrow must point to an agent, not a check.')
    } else if (e.to === e.from || !reachesByHandoff(g, e.to, e.from)) {
      onEdge(e.id, 'A retry arrow must point back to an agent that hands work on to this card.')
    } else {
      loops.push({ edge: e, loop: loopOf(g, e) })
    }
  }
  const overlapping = new Set<string>()
  for (const [i, a] of loops.entries()) {
    for (const b of loops.slice(i + 1)) {
      if (a.edge.from === b.edge.from || ![...a.loop].some(id => b.loop.has(id))) continue
      overlapping.add(a.edge.from).add(b.edge.from)
    }
  }
  for (const id of overlapping) onNode(id, "Retry loops can't overlap.")
  const reported = new Set<string>()
  for (const { edge, loop } of loops) {
    for (const id of loop) {
      const card = nodeById(g, id)
      if (id === edge.from || card === undefined) continue
      for (const h of outgoing(g, id, 'handoff')) {
        const next = nodeById(g, h.to)
        if (next === undefined || loop.has(h.to)) continue
        const message = `Work leaves this retry loop before its check: ${card.name} hands off to ${next.name}.`
        if (reported.has(`${id}>${message}`)) continue
        reported.add(`${id}>${message}`)
        onNode(id, message)
      }
    }
  }
}

export function validate(g: Graph): Problem[] {
  const problems: Problem[] = []
  const onGraph = (message: string) => problems.push({ target: { kind: 'graph' }, message })
  const onNode = (id: string, message: string) => problems.push({ target: { kind: 'node', id }, message })
  const onEdge = (id: string, message: string) => problems.push({ target: { kind: 'edge', id }, message })

  if (g.name.trim() === '') onGraph('The graph needs a name.')
  if (g.nodes.length === 0) onGraph(NO_AGENTS)

  const counts = new Map<string, number>()
  for (const n of g.nodes) {
    const key = n.name.trim().toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const n of g.nodes) {
    if (n.name.trim() === '') onNode(n.id, 'Give this agent a name.')
    else if ((counts.get(n.name.trim().toLowerCase()) ?? 0) > 1) onNode(n.id, `Another agent is also called "${n.name}".`)
  }

  const seen = new Set<string>()
  for (const e of g.edges) {
    if (nodeById(g, e.from) === undefined || nodeById(g, e.to) === undefined) {
      onEdge(e.id, 'This arrow points to an agent that no longer exists.')
    } else if (e.from === e.to) {
      onEdge(e.id, 'An agent cannot connect to itself.')
    }
    const key = `${e.from}>${e.to}>${e.kind}`
    if (seen.has(key)) onEdge(e.id, 'This arrow is a duplicate.')
    seen.add(key)
  }

  const looping = handoffCycleNodes(g)
  for (const id of looping) {
    onNode(id, 'Handoff arrows form a loop through this agent, so the run would never finish.')
  }
  // A handoff loop already explains a graph with no first agent.
  if (g.nodes.length > 0 && looping.size === 0 && startNodes(g).length === 0) {
    onGraph('No agent can start the run: every agent is only reached by delegation.')
  }

  for (const n of g.nodes) {
    if (n.check === undefined) continue
    if (g.backend === 'cloud') onNode(n.id, 'Check cards need a Local graph.')
    if (g.edges.some(e => e.kind === 'delegate' && (e.from === n.id || e.to === n.id))) {
      onNode(n.id, "A check card can't delegate or be delegated to.")
    }
    if (n.check.command.trim() === '') onNode(n.id, 'Give this check a command.')
  }

  retryProblems(g, onNode, onEdge)

  if (g.backend === 'cloud') {
    for (const n of g.nodes) {
      const delegatesTo = outgoing(g, n.id, 'delegate')
      if (incoming(g, n.id, 'delegate').length > 0 && delegatesTo.length > 0) {
        onNode(n.id, 'On Cloud, an agent that is delegated to cannot delegate further (one level only).')
      }
      if (delegatesTo.length > MAX_CLOUD_DELEGATES) {
        onNode(n.id, `On Cloud, an agent can delegate to at most ${MAX_CLOUD_DELEGATES} agents.`)
      }
      const missing = n.tools.filter(t => !Object.hasOwn(CLOUD_TOOLS, t))
      if (missing.length > 0) onNode(n.id, `On Cloud, these tools are not available: ${missing.join(', ')}.`)
    }
  }

  return problems
}

export const problemsFor = (problems: Problem[], nodeId: string): Problem[] =>
  problems.filter(p => p.target.kind === 'node' && p.target.id === nodeId)

// The graph a run uses: disabled agents are removed, every handoff predecessor
// of one is joined to every handoff successor (through chains of them too), and
// delegate arrows touching one are dropped, as are helpers left with no delegator, and so are retry arrows whose
// judge or target is disabled. Ids are kept; a graph with nothing disabled comes back as it was.
export function withoutDisabled(g: Graph): Graph {
  const disabled = new Set(g.nodes.filter(n => n.disabled === true).map(n => n.id))
  if (disabled.size === 0) return g
  const handoffs = g.edges.filter(e => e.kind === 'handoff')
  // The enabled agents a handoff from `id` reaches, passing through disabled ones.
  const reach = (id: string, seen = new Set<string>()): string[] =>
    handoffs.filter(e => e.from === id).flatMap(e => {
      if (!disabled.has(e.to)) return [e.to]
      if (seen.has(e.to)) return []
      seen.add(e.to)
      return reach(e.to, seen)
    })
  const enabled = g.nodes.filter(n => !disabled.has(n.id))
  let out: Graph = {
    ...g,
    nodes: enabled,
    edges: g.edges.filter(e => !disabled.has(e.from) && !disabled.has(e.to)),
  }
  for (const n of enabled) {
    for (const to of reach(n.id)) if (to !== n.id && nodeById(out, to) !== undefined) out = connect(out, n.id, to, 'handoff')
  }
  // A helper that was reached only by delegation and has lost every delegator
  // would otherwise run on its own; its own helpers may lose theirs in turn.
  for (let changed = true; changed; ) {
    changed = false
    for (const n of out.nodes) {
      if (isDelegateOnly(g, n.id) && incoming(out, n.id, 'delegate').length === 0) {
        out = withoutNode(out, n.id)
        changed = true
      }
    }
  }
  return out
}

// Non-blocking advice about a graph; a run stays enabled with these.
export function warningsOf(g: Graph, instructions: (n: AgentNode) => string | undefined): Problem[] {
  const warnings: Problem[] = []
  const delegated = new Set(g.edges.filter(e => e.kind === 'delegate').map(e => e.to))
  for (const n of g.nodes) {
    if (isCheck(n)) continue
    if (delegated.has(n.id) && (n.whenToUse ?? '').trim() === '') {
      warnings.push({ target: { kind: 'node', id: n.id }, message: 'Add a "when to use" description so the agents that delegate to it know when to call it.' })
    }
    const text = instructions(n)
    if (text !== undefined && isStarterTemplate(text)) {
      warnings.push({ target: { kind: 'node', id: n.id }, message: 'The instructions are still the starter template.' })
    }
  }
  return warnings
}
