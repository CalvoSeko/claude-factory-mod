import type { ActivityItem, AgentNode, Connecting, Edge, EdgeKind, Graph, NodeRunView, NodeStatus, RestartWait, RunView } from '../types'
import { DEFAULT_RETRIES, isCheck, loopContaining, NODE_H, NODE_W, nodeById, problemsFor, RETRY_COLOR, runStart, subgraphFrom, validate, withoutDisabled, type Problem } from './model'
import type { StaleCause } from './records'

// The arrows layer: '' plain, h handoff, d delegate, r retry; `e` is the id of the edge a segment belongs to.
// A segment of an arrow's own text (a retry arrow's `↺ 3`) has `e` and no `i`.
export type Style = '' | 'h' | 'd' | 'r'
// `i` numbers an arrow cell along its path (0 at the tail), so flow dots can move toward the head.
// `i` is the path index of the segment's first cell (0 at the tail); the next cells
// count up (`d` 1, the default) or down (`d` -1) along the row.
export type Seg = { t: string; s: Style; e?: string; i?: number; d?: -1 }

export type CanvasEvent =
  | { kind: 'down' | 'drag' | 'up'; x: number; y: number }
  | { kind: 'key'; key: string; ctrl?: boolean; shift?: boolean }
  | { kind: 'press'; node: string; action: 'edit' | 'run' | 'delete' }
  | { kind: 'wire'; from: string; to: string }
  | { kind: 'port'; from: string }
  | { kind: 'edge'; edge: string; action: 'retype' | 'reverse' | 'delete' }
  | { kind: 'focus'; edge: string | null; card: string | null }
  // A wire dropped on empty canvas: a new agent appears there, joined by a handoff from `from`.
  | { kind: 'spawn'; from: string; x: number; y: number }
export type CanvasPost = { events: CanvasEvent[] }

export type Tone = 'idle' | 'selected' | 'problem' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled' | 'skipped' | 'stale'

// One card as the canvas draws it: plain data, computed here.
export type CardView = {
  id: string
  name: string
  x: number
  y: number
  glyph: string
  tone: Tone
  isMarked: boolean
  line: string
  // 'active' is the orange of a delegate helper that is being called.
  lineTone: 'dim' | 'plain' | 'error' | 'active'
  // A running agent's live line without its time (`<tool> · <summary>`, clipped to leave room for it): the
  // canvas adds the running time itself, so it keeps counting between two publishes.
  live?: string
  tip: string
  startedAt?: number
  costUsd?: number
  // The cost is an estimate (drawn with ≈).
  costEstimated?: boolean
  canRunFrom: boolean
  canDelete: boolean
  // Left out of runs (its input passes straight through).
  disabled: boolean
  // Drawn dimmed: disabled and with no run status of its own (a disabled card that has one looks like any other).
  dimmed: boolean
  // Has a non-blocking warning.
  warn: boolean
  // A run pauses before this agent (drawn as ‖ at the right end of the top row).
  pauses: boolean
  // Why its saved output is out of date (shown as ↻).
  stale?: StaleCause
  // Its output was reused from an earlier run: the local time that run ended, as HH:MM.
  reused?: string
  // A card of a retry loop in round 2 or later: `round <r>/<retries + 1>`, already part of `line` (the canvas keeps its room
  // when it draws the running line itself).
  round?: string
  // An agent waiting to be started again after a temporary failure: when it starts, and `retry <n>/<of>`; the canvas
  // counts down to it itself (`retry 1/3 · in 1:30`).
  restartAt?: number
  restartLabel?: string
  // A check card: a command, not an agent (it has no instructions to edit).
  isCheck?: true
  // On a card of a retry loop other than its target, From here runs from the target: the target's name.
  runFrom?: string
}

export type EdgeFlow = 'idle' | 'flowing' | 'delivered' | 'dead'

export type Pt = { x: number; y: number }

// One arrow as the canvas needs it: `mid` is a cell on its drawn line. In vector
// mode `path` samples the curve (cells, 2 decimals) and `mid` is its middle.
export type EdgeView = {
  id: string
  from: string
  to: string
  kind: EdgeKind
  label: string
  mid: { x: number; y: number }
  flow: EdgeFlow
  // A retry arrow's `↺ <retries>` where the vector layer has no characters to carry it: the cell it starts at, and its text.
  tag?: { x: number; y: number; t: string }
  path?: Pt[]
  // Among delivered handoff arrows: true for the one whose target started last, false for older ones (drawn faded). Unset for other arrows.
  recent?: boolean
}

export type CanvasProps = {
  cardW: number
  cardH: number
  layer: Seg[][]
  edges: EdgeView[]
  cards: CardView[]
  drawnAt: number
  isRunning: boolean
  // True where the arrows are SVG vectors under the canvas (the desktop); false draws them as characters.
  vector: boolean
  // SVG y per cell of x in vector mode (ROW_RATIO), so the canvas can scale a pointer's row like the Svg does.
  rowRatio: number
  // A connection is being made (any stage): pressing an arrow then cancels it.
  connecting: boolean
}

export const GLYPH: Record<NodeStatus, string> = { waiting: '○', paused: '‖', running: '◐', done: '●', failed: '✕', skipped: '–', cancelled: '⊘' }

// The card row arrows leave and enter by; the port sits on it.
const ANCHOR = 2

const LINES: Record<EdgeKind, { h: string; v: string; right: string; left: string; down: string; up: string }> = {
  handoff: { h: '━', v: '┃', right: '►', left: '◄', down: '▼', up: '▲' },
  delegate: { h: '┄', v: '┆', right: '►', left: '◄', down: '▼', up: '▲' },
  retry: { h: '┅', v: '┇', right: '►', left: '◄', down: '▼', up: '▲' },
}

type Cell = { ch: string; s: Style; e?: string; i?: number }
type Put = (x: number, y: number, ch: string) => void

export function drawEdges(g: Graph, size: { cols: number; rows: number }): Seg[][] {
  const grid: Cell[][] = Array.from({ length: size.rows }, () =>
    Array.from({ length: size.cols }, (): Cell => ({ ch: ' ', s: '' })),
  )
  for (const edge of g.edges) {
    const from = nodeById(g, edge.from)
    const to = nodeById(g, edge.to)
    if (from === undefined || to === undefined || from === to) continue
    const s: Style = edge.kind === 'handoff' ? 'h' : edge.kind === 'delegate' ? 'd' : 'r'
    // drawEdge paints in path order; a corner is painted twice in a row and keeps one index.
    let index = -1
    let last = ''
    drawEdge((x, y, ch) => {
      if (`${x},${y}` !== last) index++
      last = `${x},${y}`
      // Two cards that sit too close send an up arrow through them: those cells stay with the cards.
      if (isInside(from, x, y) || isInside(to, x, y)) return
      const row = grid[y]
      // A delegate's tail cell is a hollow circle: it calls and gets an answer back.
      if (row !== undefined && x >= 0 && x < row.length) row[x] = { ch: edge.kind === 'delegate' && index === 0 ? '○' : ch, s, e: edge.id, i: index }
    }, from, to, edge.kind)
  }
  // A retry arrow says how often it sends work back, at its start; text that would run into a card or another arrow is left out.
  for (const edge of g.edges) {
    const from = nodeById(g, edge.from)
    const to = nodeById(g, edge.to)
    if (edge.kind !== 'retry' || from === undefined || to === undefined || from === to) continue
    const tag = tagOf(from, to, edge.retries ?? DEFAULT_RETRIES)
    const row = tag === undefined ? undefined : grid[tag.y]
    if (tag === undefined || row === undefined) continue
    const cells = [...tag.t].map((ch, k) => ({ ch, x: tag.x + k }))
    const isFree = (x: number) => row[x] !== undefined && (row[x]!.e === undefined || row[x]!.e === edge.id) && !g.nodes.some(n => isInside(n, x, tag.y))
    if (!cells.every(c => isFree(c.x))) continue
    for (const c of cells) row[c.x] = { ch: c.ch, s: 'r', e: edge.id }
  }
  return grid.map(row => {
    const segs: Seg[] = []
    for (const cell of row) {
      const prev = segs[segs.length - 1]
      if (cell.e === undefined) {
        if (prev !== undefined && prev.e === undefined && prev.s === cell.s) prev.t += cell.ch
        else segs.push({ t: cell.ch, s: cell.s })
        continue
      }
      // An arrow's own text (no index) joins only the text beside it.
      if (cell.i === undefined) {
        if (prev !== undefined && prev.e === cell.e && prev.i === undefined) prev.t += cell.ch
        else segs.push({ t: cell.ch, s: cell.s, e: cell.e })
        continue
      }
      // Arrow cells merge while they run along the path in one direction, which keeps
      // the canvas props small; a corner or another arrow starts a new segment.
      if (prev !== undefined && prev.e === cell.e && prev.i !== undefined) {
        const step = cell.i! - (prev.i + (prev.d ?? 1) * (prev.t.length - 1))
        const canJoin = prev.t.length === 1 ? step === 1 || step === -1 : step === (prev.d ?? 1)
        if (canJoin) {
          if (prev.t.length === 1 && step === -1) prev.d = -1
          prev.t += cell.ch
          continue
        }
      }
      segs.push({ t: cell.ch, s: cell.s, e: cell.e, i: cell.i! })
    }
    const tail = segs[segs.length - 1]
    if (tail !== undefined && tail.s === '') tail.t = tail.t.trimEnd()
    return segs.filter(seg => seg.t !== '')
  })
}

export const rowText = (row: Seg[]): string => row.map(seg => seg.t).join('')

const isInside = (n: AgentNode, x: number, y: number): boolean => x >= n.x && x < n.x + NODE_W && y >= n.y && y < n.y + NODE_H

export function hitTest(g: Graph, x: number, y: number): AgentNode | undefined {
  return [...g.nodes].reverse().find(n => isInside(n, x, y))
}

// How an arrow runs between two cards. Retry arrows have their own lane beside the handoff between the same two
// cards: sideways they use the card row below the port row and turn one column on, up and down they sit three
// columns to the right (and turn one row on), so both arrows are seen and can be picked.
type Route =
  | { side: true; way: 'right' | 'left'; sx: number; tx: number; sy: number; ty: number; mid: number }
  | { side: false; way: 'down' | 'up'; ax: number; bx: number; sy: number; ty: number; mid: number }

function routeOf(from: AgentNode, to: AgentNode, kind: EdgeKind): Route {
  const lane = kind === 'retry'
  const midX = (n: AgentNode) => n.x + Math.floor(NODE_W / 2) + (lane ? 3 : 0)
  if (to.x >= from.x + NODE_W + 2) {
    const sx = from.x + NODE_W
    const tx = to.x - 1
    const mid = Math.floor((sx + tx) / 2)
    return { side: true, way: 'right', sx, tx, sy: from.y + ANCHOR + (lane ? 1 : 0), ty: to.y + ANCHOR + (lane ? 1 : 0), mid: lane ? Math.max(sx, Math.min(mid + 1, tx - 1)) : mid }
  }
  if (to.x + NODE_W + 2 <= from.x) {
    const sx = from.x - 1
    const tx = to.x + NODE_W
    const mid = Math.floor((sx + tx) / 2)
    return { side: true, way: 'left', sx, tx, sy: from.y + ANCHOR + (lane ? 1 : 0), ty: to.y + ANCHOR + (lane ? 1 : 0), mid: lane ? Math.min(sx, Math.max(mid + 1, tx + 1)) : mid }
  }
  const isDown = to.y >= from.y + NODE_H + 1
  const sy = isDown ? from.y + NODE_H : from.y - 1
  const ty = isDown ? to.y - 1 : to.y + NODE_H
  const mid = Math.floor((sy + ty) / 2)
  const turn = lane && mid + 1 < Math.max(sy, ty) && mid + 1 > Math.min(sy, ty) ? mid + 1 : mid
  return { side: false, way: isDown ? 'down' : 'up', ax: midX(from), bx: midX(to), sy, ty, mid: turn }
}

function drawEdge(put: Put, from: AgentNode, to: AgentNode, kind: EdgeKind) {
  const L = LINES[kind]
  // Both run from a to b, in that direction, so the cells are painted tail to head.
  const hline = (a: number, b: number, y: number) => {
    const step = a <= b ? 1 : -1
    for (let x = a; x !== b + step; x += step) put(x, y, L.h)
  }
  const vline = (x: number, a: number, b: number) => {
    const step = a <= b ? 1 : -1
    for (let y = a; y !== b + step; y += step) put(x, y, L.v)
  }
  const r = routeOf(from, to, kind)
  if (r.side) {
    hline(r.sx, r.mid, r.sy)
    vline(r.mid, r.sy, r.ty)
    hline(r.mid, r.tx, r.ty)
    put(r.tx, r.ty, r.way === 'right' ? L.right : L.left)
  } else {
    vline(r.ax, r.sy, r.mid)
    hline(r.ax, r.bx, r.mid)
    vline(r.bx, r.mid, r.ty)
    put(r.bx, r.ty, r.way === 'down' ? L.down : L.up)
  }
}

// A retry arrow's `↺ <retries>`: where it is written (its first cell) and what fits there. It sits at the arrow's
// start, on the first leg, which keeps the corner and the head clear; an arrow that leaves up or down has it beside its first cell.
export function tagOf(from: AgentNode, to: AgentNode, retries: number): { x: number; y: number; t: string } | undefined {
  const text = `↺ ${retries}`
  const r = routeOf(from, to, 'retry')
  if (r.side && r.way === 'right') {
    const room = (r.sy === r.ty ? r.tx : r.mid) - r.sx
    const t = text.slice(0, Math.max(0, room)).trimEnd()
    return t === '' ? undefined : { x: r.sx, y: r.sy, t }
  }
  if (r.side) {
    const room = r.sx - (r.sy === r.ty ? r.tx : r.mid)
    const t = text.slice(0, Math.max(0, room)).trimEnd()
    return t === '' ? undefined : { x: r.sx - t.length + 1, y: r.sy, t }
  }
  return { x: r.ax + 1, y: r.sy, t: text }
}

// The middle of an arrow's connecting segment, routed as drawEdge routes it.
export function midOf(from: AgentNode, to: AgentNode, kind: EdgeKind = 'handoff'): { x: number; y: number } {
  const r = routeOf(from, to, kind)
  if (r.side) return { x: r.mid, y: Math.floor((from.y + to.y) / 2) + ANCHOR + (kind === 'retry' ? 1 : 0) }
  return { x: Math.floor((r.ax + r.bx) / 2), y: r.mid }
}

// What an arrow's flow is from the statuses of its two ends.
function plainFlow(kind: EdgeKind, fromId: string, toId: string, run: RunView | null): EdgeFlow {
  const from = run?.nodes[fromId]?.status
  // Work flows back while the target runs again in a later round.
  if (kind === 'retry') {
    const target = run?.nodes[toId]
    return target !== undefined && (target.round ?? 1) >= 2 && (target.status === 'running' || target.status === 'paused') ? 'flowing' : 'idle'
  }
  if (kind === 'delegate') {
    // The caller's own delegate calls to this agent say what flows: one open call flows, otherwise the last one's end.
    // (A helper is one entry for all its callers, so its own status cannot tell whose call it is.)
    const calls = (run?.nodes[fromId]?.activity ?? []).filter(i => i.delegate?.nodeId === toId)
    if (calls.length > 0) {
      if (calls.some(c => c.status === 'running')) return run?.isRunning === true ? 'flowing' : 'idle'
      return calls[calls.length - 1]!.status === 'ok' ? 'delivered' : 'dead'
    }
    const helper = run?.nodes[toId]
    if (helper?.calledBy !== undefined) {
      // Called, but not (as far as its calls say) by this agent: nothing flows here.
      if (helper.calledBy !== fromId) return 'idle'
      return helper.status === 'running' ? 'flowing' : helper.status === 'done' ? 'delivered' : helper.status === 'failed' || helper.status === 'cancelled' || helper.status === 'skipped' ? 'dead' : 'idle'
    }
    return from === 'running' ? 'flowing' : from === 'done' ? 'delivered' : from === 'failed' || from === 'cancelled' || from === 'skipped' ? 'dead' : 'idle'
  }
  const to = run?.nodes[toId]?.status
  if (from === undefined || to === undefined) return 'idle'
  if (from === 'failed' || from === 'cancelled' || from === 'skipped' || to === 'skipped') return 'dead'
  if (from !== 'done') return 'idle'
  return to === 'done' || to === 'failed' || to === 'cancelled' ? 'delivered' : 'flowing'
}

// A run passes over a disabled agent that has no entry of its own: its input goes straight on.
const isPassedOver = (g: Graph, run: RunView | null, id: string): boolean => nodeById(g, id)?.disabled === true && run?.nodes[id] === undefined

// The agents a run really joins to `id` along handoffs: `id` itself, or past a passed-over agent (and any in a row) those beyond it.
function reachThrough(g: Graph, run: RunView | null, id: string, dir: 'up' | 'down', seen = new Set<string>()): string[] {
  if (!isPassedOver(g, run, id)) return [id]
  if (seen.has(id)) return []
  seen.add(id)
  return g.edges
    .filter(e => e.kind === 'handoff' && (dir === 'up' ? e.to === id : e.from === id))
    .flatMap(e => reachThrough(g, run, dir === 'up' ? e.from : e.to, dir, seen))
}

const FLOW_RANK: Record<EdgeFlow, number> = { flowing: 3, delivered: 2, idle: 1, dead: 0 }

// With the graph, an arrow touching a passed-over agent shows what flows through that agent: the best of the
// flows between the agents on either side (the one carrying something wins). A delegate arrow there carries nothing.
export function flowOf(edge: Edge, run: RunView | null, g?: Graph): EdgeFlow {
  if (g === undefined || !(isPassedOver(g, run, edge.from) || isPassedOver(g, run, edge.to))) return plainFlow(edge.kind, edge.from, edge.to, run)
  if (edge.kind !== 'handoff') return 'idle'
  const flows = reachThrough(g, run, edge.from, 'up').flatMap(from => reachThrough(g, run, edge.to, 'down').map(to => plainFlow('handoff', from, to, run)))
  return flows.reduce<EdgeFlow>((best, f) => (FLOW_RANK[f] > FLOW_RANK[best] ? f : best), flows[0] ?? 'idle')
}

export function edgesOf(g: Graph, run: RunView | null, vector = false): EdgeView[] {
  // The delivered handoff whose target started last is the recent one; past a passed-over agent, the agent beyond it is the target.
  const startedAt = (id: string) => run?.nodes[id]?.startedAt ?? -1
  const targetStart = (e: Edge) => Math.max(-1, ...reachThrough(g, run, e.to, 'down').map(startedAt))
  const newest = Math.max(...g.edges.filter(e => e.kind === 'handoff' && flowOf(e, run, g) === 'delivered').map(targetStart))
  return g.edges.flatMap(e => {
    const from = nodeById(g, e.from)
    const to = nodeById(g, e.to)
    if (from === undefined || to === undefined || from === to) return []
    const view: EdgeView = { id: e.id, from: e.from, to: e.to, kind: e.kind, label: `${e.kind} · ${from.name} → ${to.name}`, mid: midOf(from, to, e.kind), flow: flowOf(e, run, g) }
    if (e.kind === 'handoff' && view.flow === 'delivered') view.recent = targetStart(e) === newest
    if (vector) {
      const curve = curveOf(from, to, e.kind)
      const m = bezierAt(curve, 0.5)
      view.mid = { x: Math.round(m.x), y: Math.round(m.y) }
      view.path = sample(curve)
      if (e.kind === 'retry') {
        const tag = tagOf(from, to, e.retries ?? DEFAULT_RETRIES)
        if (tag !== undefined) view.tag = tag
      }
    }
    return [view]
  })
}

// Vector arrows. SVG x is cells * VEC_UNIT; SVG y is rows * VEC_UNIT * ROW_RATIO.
// Both are measured on the desktop app (one row is about 2.37 columns tall). The
// Svg shrinks to its slot's width, so only the ratio has to be right, not the unit.
export const VEC_UNIT = 24
export const ROW_RATIO = 2.37

const round1 = (n: number): number => Math.round(n * 10) / 10
const round2 = (n: number): number => Math.round(n * 100) / 100

// The cubic Bézier of an arrow, in fractional cells: between the cards' facing
// sides at their middle (the port row's centre for left and right), tangent to them.
// The cases follow drawEdge: right, left, down, otherwise up.
// A retry arrow runs in its own lane beside the handoff between the same cards (a row lower, or three cells to the right).
export function curveOf(from: AgentNode, to: AgentNode, kind: EdgeKind = 'handoff'): [Pt, Pt, Pt, Pt] {
  const lane = kind === 'retry'
  const centre = (n: AgentNode) => n.x + NODE_W / 2 + (lane ? 3 : 0)
  const row = (n: AgentNode) => n.y + NODE_H / 2 + (lane ? 1 : 0)
  if (to.x >= from.x + NODE_W + 2 || to.x + NODE_W + 2 <= from.x) {
    const goesRight = to.x >= from.x
    const a: Pt = { x: goesRight ? from.x + NODE_W : from.x, y: row(from) }
    const b: Pt = { x: goesRight ? to.x : to.x + NODE_W, y: row(to) }
    const h = Math.max(3, Math.abs(b.x - a.x) / 2) * (goesRight ? 1 : -1)
    return [a, { x: a.x + h, y: a.y }, { x: b.x - h, y: b.y }, b]
  }
  const isDown = to.y >= from.y + NODE_H + 1
  const a: Pt = { x: centre(from), y: isDown ? from.y + NODE_H : from.y }
  const b: Pt = { x: centre(to), y: isDown ? to.y : to.y + NODE_H }
  const h = Math.max(1.5, Math.abs(b.y - a.y) / 2) * (isDown ? 1 : -1)
  return [a, { x: a.x, y: a.y + h }, { x: b.x, y: b.y - h }, b]
}

export function bezierAt(c: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
  return {
    x: w[0]! * c[0].x + w[1]! * c[1].x + w[2]! * c[2].x + w[3]! * c[3].x,
    y: w[0]! * c[0].y + w[1]! * c[1].y + w[2]! * c[2].y + w[3]! * c[3].y,
  }
}

// 25 points along the curve, for the canvas to hit-test against.
const sample = (c: [Pt, Pt, Pt, Pt]): Pt[] =>
  Array.from({ length: 25 }, (_, i) => {
    const p = bezierAt(c, i / 24)
    return { x: round2(p.x), y: round2(p.y) }
  })

const GOLD = '#c9a227'
const BLUE = '#7c8db5'
const GREEN = '#5aa469'
// The brighter tints of GOLD and BLUE for a focused arrow (the canvas draws a hovered or picked one in the same tints).
const HOT_GOLD = '#f0c040'
const HOT_BLUE = '#a9b8e0'
const BRIGHT: Record<EdgeKind, string> = { handoff: HOT_GOLD, delegate: HOT_BLUE, retry: RETRY_COLOR }
const BASE: Record<EdgeKind, string> = { handoff: GOLD, delegate: BLUE, retry: RETRY_COLOR }

// The SVG source is kept well under the 131072 characters the engine accepts. A base over this
// even without its dots has too many arrows for the vector layer: the pane draws characters then.
export const SVG_LIMIT = 120000

const svgOf = (size: { cols: number; rows: number }, defs: Map<string, string>, body: string[]): string => {
  const width = size.cols * VEC_UNIT
  const height = Math.round(size.rows * VEC_UNIT * ROW_RATIO)
  const head = defs.size > 0 ? `<defs>${[...defs.values()].join('')}</defs>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${head}${body.join('')}</svg>`
}

// A hollow circle at a delegate arrow's tail.
const tailOf = (color: string): [string, string] => {
  const id = `o-${color.slice(1)}`
  return [id, `<marker id="${id}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse"><circle cx="5" cy="5" r="4" fill="none" stroke="${color}" stroke-width="1.5"/></marker>`]
}

const markerOf = (color: string): [string, string] => {
  const id = `m-${color.slice(1)}`
  return [id, `<marker id="${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto"><polygon points="0,0 10,5 0,10" fill="${color}"/></marker>`]
}

// The SVG under the canvas: every arrow as a curve with an arrowhead, and the
// moving dots on the flowing ones. It never depends on the focus, so hovering
// does not change it. Past the size limit the dots are dropped, never the arrows; the result is
// over SVG_LIMIT only when the arrows alone do not fit.
export function vectorBaseSvg(g: Graph, edges: EdgeView[], size: { cols: number; rows: number }): string {
  const px = (p: Pt): string => `${round1(p.x * VEC_UNIT)} ${round1(p.y * VEC_UNIT * ROW_RATIO)}`
  const markers = new Map<string, string>()
  const arrows: string[] = []
  const flows: string[] = []
  for (const e of edges) {
    const from = nodeById(g, e.from)
    const to = nodeById(g, e.to)
    if (from === undefined || to === undefined) continue
    const [a, b, c, d] = curveOf(from, to, e.kind)
    const path = `M${px(a)} C${px(b)} ${px(c)} ${px(d)}`
    const color = e.flow === 'delivered' ? GREEN : BASE[e.kind]
    const [id, marker] = markerOf(color)
    markers.set(id, marker)
    const dash = e.kind === 'delegate' ? ' stroke-dasharray="7 6"' : e.kind === 'retry' ? ' stroke-dasharray="2 4"' : ''
    // Delivered handoffs older than the newest one fade; dead arrows fade more.
    const faint = e.flow === 'dead' ? ' opacity="0.3"' : e.flow === 'delivered' && e.recent === false ? ' opacity="0.45"' : ''
    let tail = ''
    if (e.kind === 'delegate') {
      const [tailId, circle] = tailOf(color)
      markers.set(tailId, circle)
      tail = ` marker-start="url(#${tailId})"`
    }
    arrows.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5"${dash}${faint}${tail} marker-end="url(#${id})"/>`)
    if (e.flow === 'flowing') {
      flows.push(`<path d="${path}" fill="none" stroke="#fff4c2" stroke-width="5" stroke-linecap="round" stroke-dasharray="0.1 16"><animate attributeName="stroke-dashoffset" from="16.1" to="0" dur="0.9s" repeatCount="indefinite"/></path>`)
    }
  }
  // Each flow overlay follows its own arrow, so they go last: they sit above every arrow.
  const full = svgOf(size, markers, [...arrows, ...flows])
  return full.length > SVG_LIMIT ? svgOf(size, markers, arrows) : full
}

// The glow over the base: only the focused arrows (the focused one, and those at
// the focused card), each as a wide faint underlay and a bright stroke along the
// sampled path. null when nothing is focused, or when it would be too large; over the
// limit the wide underlays go first and the bright strokes stay.
export function vectorGlowSvg(
  edges: EdgeView[],
  focus: { edge: string | null; card: string | null } | undefined,
  size: { cols: number; rows: number },
): string | null {
  if (focus === undefined) return null
  const px = (p: Pt): string => `${round1(p.x * VEC_UNIT)} ${round1(p.y * VEC_UNIT * ROW_RATIO)}`
  const markers = new Map<string, string>()
  const underlays: string[] = []
  const strokes: string[] = []
  for (const e of edges) {
    if (e.path === undefined || e.path.length < 2) continue
    if (!(focus.edge === e.id || focus.card === e.from || focus.card === e.to)) continue
    const color = BRIGHT[e.kind]
    const [id, marker] = markerOf(color)
    markers.set(id, marker)
    const path = `M${e.path.map(px).join(' L')}`
    const dash = e.kind === 'delegate' ? ' stroke-dasharray="7 6"' : e.kind === 'retry' ? ' stroke-dasharray="2 4"' : ''
    // A delegate arrow keeps its hollow circle at the tail, as in the base.
    let tail = ''
    if (e.kind === 'delegate') {
      const [tailId, circle] = tailOf(color)
      markers.set(tailId, circle)
      tail = ` marker-start="url(#${tailId})"`
    }
    underlays.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="10" stroke-opacity="0.22" stroke-linecap="round" stroke-linejoin="round"/>`)
    strokes.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="3.5"${dash}${tail} marker-end="url(#${id})"/>`)
  }
  if (strokes.length === 0) return null
  const full = svgOf(size, markers, [...underlays, ...strokes])
  if (full.length <= SVG_LIMIT) return full
  const bright = svgOf(size, markers, strokes)
  return bright.length <= SVG_LIMIT ? bright : null
}

export type CardOptions = {
  selected: string | null
  connecting: Connecting | null
  run: RunView | null
  problems: Problem[]
  warnings?: Problem[]
  instructions: (node: AgentNode) => string
  // Agents whose saved output is out of date; only drawn while no run is going and the run on show is not a past one.
  stale?: Record<string, StaleCause>
  // The time of the drawing (host clock): a running agent's live line counts its elapsed time up to it.
  now?: number
}

// Local time as HH:MM.
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const STALE_WORDS: Record<StaleCause, string> = {
  task: 'task changed', changed: 'setup changed', upstream: 'input changed', never: 'no output yet',
}

const firstLine = (text: string): string => text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''

export function summary(n: AgentNode, g: Graph): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
  const parts = [n.model ?? (g.backend === 'cloud' ? 'default' : 'inherit'), plural(n.skills.length, 'skill')]
  if (n.tools.length > 0) parts.push(plural(n.tools.length, 'tool'))
  return parts.join(' · ')
}

// A card's inner width: the room of its line.
const LINE_W = NODE_W - 4
const TIME_W = ' · 0:00'.length

// Cuts at `max` code points and marks the cut.
const clipChars = (text: string, max: number): string => {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// The time left: m:ss, or h:mm:ss from an hour (rounded up, so it reads 0:00 only once the time has come).
export const countdown = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const mm = `${Math.floor(s / 60) % 60}:${String(s % 60).padStart(2, '0')}`
  return s < 3600 ? mm : `${Math.floor(s / 3600)}:${mm.padStart(5, '0')}`
}

const restartLabel = (w: RestartWait): string => `retry ${w.attempt}/${w.of}`

// The newest call that is running now, going down into the delegate it is waiting for.
function innermostRunning(items: ActivityItem[]): ActivityItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.status !== 'running') continue
    return (item.delegate === undefined ? undefined : innermostRunning(item.delegate.items)) ?? item
  }
  return undefined
}

// A status line with ` · round 2/3` after it: the status gives way (is cut) so the whole line fits the card.
const withRound = (text: string, round: string | undefined): string =>
  round === undefined ? text : text === '' ? round : `${clipChars(text, Math.max(1, LINE_W - round.length - 3))} · ${round}`

function lineOf(n: AgentNode, g: Graph, v: NodeRunView | undefined, now: number | undefined, round?: string): Pick<CardView, 'line' | 'lineTone' | 'live'> {
  if (v?.calledBy !== undefined) {
    // A delegate helper: who called it, then how long the call took.
    // The orange tone says it is running; the name is cut so the line fits the card.
    if (v.status === 'running') return { line: `called by ${clipChars(nodeById(g, v.calledBy)?.name ?? v.calledBy, LINE_W - 'called by '.length)}`, lineTone: 'active' }
    if (v.status === 'done') return { line: v.startedAt !== undefined && v.endedAt !== undefined ? `done · ${mmss(v.endedAt - v.startedAt)}` : 'done', lineTone: 'dim' }
    if ((v.status === 'failed' || v.status === 'cancelled') && firstLine(v.error ?? '') === '') {
      return { line: v.startedAt !== undefined && v.endedAt !== undefined ? `${v.status} · ${mmss(v.endedAt - v.startedAt)}` : v.status, lineTone: 'error' }
    }
  }
  switch (v?.status) {
    case 'running': {
      // Waiting to be started again: the countdown, without the round (it would not fit).
      if (v.restartWait !== undefined) {
        return { line: `${restartLabel(v.restartWait)} · in ${countdown(v.restartWait.until - (now ?? v.restartWait.until))}`, lineTone: 'plain' }
      }
      if (v.current === undefined || v.current === '') return { line: withRound('', round), lineTone: 'plain' }
      // `<tool> · <summary> · m:ss` (and ` · round 2/3`); the time and the round keep their room and the rest is clipped.
      const tool = innermostRunning(v.activity ?? [])?.tool
      const head = tool === undefined || tool === v.current ? v.current : `${tool} · ${v.current}`
      const time = ` · ${mmss((now ?? v.startedAt ?? 0) - (v.startedAt ?? now ?? 0))}`
      const more = round === undefined ? '' : ` · ${round}`
      return { line: clipChars(head, LINE_W - time.length - more.length) + time + more, lineTone: 'plain', live: clipChars(head, LINE_W - TIME_W - more.length) }
    }
    case 'done':
      return { line: withRound(isCheck(n) ? 'passed' : firstLine(v.output ?? ''), round), lineTone: 'dim' }
    case 'failed':
    case 'cancelled':
      return { line: withRound(firstLine(v.error ?? ''), round), lineTone: 'error' }
    case 'paused':
      return { line: withRound('paused · your turn', round), lineTone: 'dim' }
    case 'waiting':
    case 'skipped':
      return { line: withRound(v.status, round), lineTone: 'dim' }
    default:
      // A check card shows its command (dim when it has none yet).
      if (n.check !== undefined) return n.check.command.trim() === '' ? { line: '$ (no command)', lineTone: 'dim' } : { line: `$ ${clipChars(firstLine(n.check.command), LINE_W - 2)}`, lineTone: 'plain' }
      return { line: summary(n, g), lineTone: 'dim' }
  }
}

export function cardsOf(g: Graph, o: CardOptions): CardView[] {
  const source = o.connecting !== null && o.connecting.stage !== 'source' ? o.connecting.from : null
  const isRunning = o.run?.isRunning === true
  const rg = withoutDisabled(g)
  return g.nodes.map(n => {
    const v = o.run?.nodes[n.id]
    // A loop card sent back at least once says which round it is in, out of the most the loop allows.
    const loop = v?.round !== undefined && v.round >= 2 ? loopContaining(rg, n.id) : undefined
    const round = loop === undefined ? undefined : `round ${v!.round}/${(loop.retries ?? DEFAULT_RETRIES) + 1}`
    // From here on a loop card other than the target runs the loop from the target.
    const start = runStart(rg, n.id)
    const isDisabled = n.disabled === true
    const hasProblem = problemsFor(o.problems, n.id).length > 0
    const hasWarning = problemsFor(o.warnings ?? [], n.id).length > 0
    const isMarked = n.id === o.selected || n.id === source
    const tone: Tone =
      v !== undefined && v.status !== 'waiting' ? v.status : hasProblem ? 'problem' : isMarked ? 'selected' : 'idle'
    // Out of date outranks a finished look; a live run, a past run, a disabled card and a failure keep theirs.
    const keepsLook = isRunning || o.run?.isHistoric === true || isDisabled || v?.status === 'failed' || v?.status === 'cancelled'
    const cause = keepsLook ? undefined : o.stale?.[n.id]
    const reused = v?.reusedFrom === undefined || cause !== undefined ? undefined : clockTime(v.reusedFrom.at)
    const card: CardView = {
      id: n.id,
      name: n.name,
      x: n.x,
      y: n.y,
      glyph: v !== undefined ? GLYPH[v.status] : isDisabled ? '◌' : hasProblem ? '!' : hasWarning ? '△' : ' ',
      tone: cause !== undefined ? 'stale' : reused !== undefined ? 'done' : tone,
      isMarked,
      ...(isDisabled && v === undefined ? { line: 'disabled · passes input through', lineTone: 'dim' as const } : lineOf(n, g, v, o.now, round)),
      tip: firstLine(o.instructions(n)),
      canRunFrom: !isRunning && !isDisabled && validate(withoutDisabled(subgraphFrom(g, start))).length === 0,
      canDelete: !isRunning,
      disabled: isDisabled,
      dimmed: isDisabled && v === undefined,
      warn: hasWarning,
      pauses: n.pauseBefore === true,
    }
    if (isCheck(n)) card.isCheck = true
    if (start !== n.id) card.runFrom = nodeById(g, start)?.name ?? start
    if (round !== undefined && reused === undefined && cause === undefined) card.round = round
    if (reused !== undefined) {
      card.glyph = '✓'
      card.line = `reused · ${reused}`
      card.lineTone = 'dim'
      card.reused = reused
    }
    if (cause !== undefined) {
      card.glyph = '↻'
      card.line = `stale · ${STALE_WORDS[cause]}`
      card.lineTone = 'dim'
      card.tip = `Out of date: ${STALE_WORDS[cause]}. Run it or use From here.`
      card.stale = cause
    }
    // A helper's line is its own (the canvas counts elapsed time up on a card that has a start).
    if (v?.startedAt !== undefined && v.calledBy === undefined) card.startedAt = v.startedAt
    if (v?.restartWait !== undefined) {
      card.glyph = '◷'
      card.restartAt = v.restartWait.until
      card.restartLabel = restartLabel(v.restartWait)
    }
    if (v?.costUsd !== undefined) card.costUsd = v.costUsd
    if (v?.costUsd !== undefined && v.costEstimated === true) card.costEstimated = true
    return card
  })
}

// The run timeline: one bar of `━` cells per agent, coloured by what the agent was doing at the cell's time.
export type TimelineCell = { ch: string; color?: string | undefined; dim: boolean }
export type TimelineRow = { id: string; name: string; cells: TimelineCell[] }

const TL_RUNNING = '#d97757'
const TL_FAILED = '#d4453b'
const TL_BAR = '━'

// What the bars are scaled over, and the last time anything in the run changed. The run's first start to its
// last end (to `now` while it runs). A reused entry carries the times of an older run, so it is left out.
function timelineScale(run: RunView, now: number): { from: number; to: number; last: number } | undefined {
  let from = Infinity
  let last = -Infinity
  for (const v of Object.values(run.nodes)) {
    if (v.reusedFrom !== undefined) continue
    if (v.startedAt !== undefined) {
      from = Math.min(from, v.startedAt)
      last = Math.max(last, v.startedAt)
    }
    if (v.endedAt !== undefined) last = Math.max(last, v.endedAt)
  }
  if (from === Infinity) return undefined
  return { from, to: run.isRunning ? Math.max(now, last) : last, last }
}

export function timelineSpan(run: RunView, now: number): { from: number; to: number } | undefined {
  const scale = timelineScale(run, now)
  return scale === undefined ? undefined : { from: scale.from, to: scale.to }
}

const TERMINAL: Partial<Record<NodeStatus, string>> = { done: GREEN, failed: TL_FAILED, cancelled: TL_FAILED }

// Run view -> a row per agent that has an entry, `width` cells wide. A cell is the state at the start of its
// time slice, except that the slice holding an agent's start (or the moment it began to wait) shows that
// state, so a short agent still leaves a mark (and the last cell shows the end of whoever ended by then). Nothing before the start. An agent waiting at its gate has no
// start: it is dim from the last change in the run (the view keeps no pause history).
export function timelineOf(run: RunView, agents: { id: string; name: string }[], width: number, now: number): TimelineRow[] {
  const scale = timelineScale(run, now)
  const count = Math.max(0, Math.floor(width))
  return agents.flatMap(agent => {
    const v = run.nodes[agent.id]
    if (v === undefined) return []
    const cells: TimelineCell[] = []
    const isPaused = v.status === 'paused'
    const anchor = scale === undefined || v.reusedFrom !== undefined ? undefined : isPaused ? scale.last : v.startedAt
    const terminal = TERMINAL[v.status]
    // A finished agent without an end time is finished from its start.
    const ended = scale === undefined || terminal === undefined ? undefined : v.endedAt ?? v.startedAt
    for (let i = 0; i < count; i++) {
      const empty: TimelineCell = { ch: ' ', dim: false }
      if (scale === undefined || anchor === undefined) {
        cells.push(empty)
        continue
      }
      const span = scale.to - scale.from
      const slice = (i * span) / count
      const next = ((i + 1) * span) / count
      const here = anchor - scale.from
      const t = scale.from + (here >= slice && (here < next || i === count - 1) ? here : slice)
      if (t < anchor) {
        cells.push(empty)
      } else if (isPaused) {
        cells.push({ ch: TL_BAR, dim: true })
      } else if (ended !== undefined && (t >= ended || (i === count - 1 && ended <= scale.to))) {
        // The last cell also shows how an agent that ended by the end of the scale ended.
        cells.push({ ch: TL_BAR, color: terminal, dim: false })
      } else {
        const calling = v.activity?.some(item => item.delegate !== undefined && item.startedAt <= t && t < (item.endedAt ?? ended ?? scale.to)) === true
        cells.push({ ch: TL_BAR, color: calling ? BLUE : TL_RUNNING, dim: false })
      }
    }
    return [{ id: agent.id, name: agent.name, cells }]
  })
}
