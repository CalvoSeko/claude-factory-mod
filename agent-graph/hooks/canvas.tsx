import type { ClientModule } from 'claude-code'

import type { CanvasEvent, CanvasPost, CanvasProps, CardView, EdgeView, Seg } from './grid'

type Wire = { from: string; x0: number; y0: number; x: number; y: number; moved: boolean }
// `armed` is the card or arrow whose ✕ was pressed once (it reads "Delete?" for ARM_TICKS timer ticks).
// `hoverEdge` is the arrow under the pointer; `picked` the arrow clicked last (its popup has buttons).
type View = {
  hover: string | null
  hoverEdge: string | null
  picked: string | null
  wire: Wire | null
  base: number
  ticks: number
  armed: string | null
  armedAge: number
}
// `latest` is mutated on each draw on purpose: the pointer and timer handlers,
// set up once, read the props of the last draw through it. `queue` is this canvas's
// own event queue: pointer and key handlers and the Buttons' presses push to it and the 16 ms timer posts it.
type State = { view: View; latest: { props: CanvasProps; queue: CanvasEvent[] } }

const ORANGE = '#d97757'
const GREEN = '#5aa469'
const RED = '#d4453b'
const GOLD = '#c9a227'
const BLUE = '#7c8db5'
// The brighter tints of the two arrow colours, for a hovered or picked arrow (the same as in grid.ts).
const HOT_GOLD = '#f0c040'
const HOT_BLUE = '#a9b8e0'
const HOT: Record<string, string> = { h: HOT_GOLD, d: HOT_BLUE, r: ORANGE }
const SPIN = ['◐', '◓', '◑', '◒']
// Cells the flow dots never replace: arrowheads and a delegate's tail circle.
const HEADS = new Set(['►', '◄', '▼', '▲', '○'])
const TONE: Record<CardView['tone'], string | undefined> = {
  idle: undefined, selected: ORANGE, problem: RED, running: ORANGE, paused: ORANGE, done: GREEN, failed: RED, cancelled: RED, skipped: undefined, stale: ORANGE,
}

// Keys that would delete, move, toggle, open or step past the selected card.
const SWALLOWED = new Set(['delete', 'backspace', 'up', 'down', 'left', 'right', 'd', 'return', 'tab'])
const ARM_TICKS = 12
const ARMED_LABEL = 'Delete?'
// The arrow button row: "⇄ delegate", "↻ reverse", "Delete?" and their gaps.
const BAR_W = 30
// Clips by characters (code points), so a name with an emoji or other astral letter is never cut inside one.
const clip = (text: string, max: number) => {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}
// A status line with ` · round 2/3` after it: the status is cut so the whole line fits.
const roundedLine = (text: string, round: string | undefined, room: number) =>
  round === undefined ? text : `${clip(text, Math.max(1, room - round.length - 3))} · ${round}`
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
// The time left, as grid.ts writes it (this module imports only types): m:ss, or h:mm:ss from an hour.
const countdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const mm = `${Math.floor(s / 60) % 60}:${String(s % 60).padStart(2, '0')}`
  return s < 3600 ? mm : `${Math.floor(s / 3600)}:${mm.padStart(5, '0')}`
}

type Rect = { x: number; y: number; w: number; h: number }
const inside = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

// The ✕ cells on a card's name row: its last four, or the whole armed label. A card that cannot
// be deleted (a run is going) has no ✕, so its armed label no longer widens the region.
const delCells = (p: CanvasProps, card: CardView, armed: string | null) => p.cardW - (card.id === armed && card.canDelete ? ARMED_LABEL.length + 2 : 4)

// Whether the card or arrow can be deleted now: neither can while a run is going or once it is gone.
const canDelete = (p: CanvasProps, id: string) => {
  const card = p.cards.find(c => c.id === id)
  return card !== undefined ? card.canDelete : !p.isRunning && p.edges.some(e => e.id === id)
}

// What a cell of the canvas falls on: a card's port, one of its buttons, or its body.
function spotAt(p: CanvasProps, x: number, y: number, armed: string | null = null): { card: CardView; part: 'port' | 'button' | 'body' } | undefined {
  for (let i = p.cards.length - 1; i >= 0; i--) {
    const card = p.cards[i]!
    const cx = x - card.x
    const cy = y - card.y
    if (cx < 0 || cy < 0 || cx >= p.cardW || cy >= p.cardH) continue
    if (cx === p.cardW - 1 && cy === 2) return { card, part: 'port' }
    if (cy === 3 || (cy === 1 && cx >= delCells(p, card, armed))) return { card, part: 'button' }
    return { card, part: 'body' }
  }
  return undefined
}

// How far (in cells) from a curve a pointer still counts as on the arrow.
const HIT_CELLS = 1.2

// How a wire dropped at its current cell would fare: the colour it takes and, when invalid, why.
const NO_SELF = "Can't connect an agent to itself."
const NO_MORE = 'Already connected both ways.'
function wireCheck(p: CanvasProps, w: Wire, armed: string | null): { color: string; reason?: string } {
  const target = spotAt(p, w.x, w.y, armed)?.card
  if (target === undefined) return { color: ORANGE }
  if (target.id === w.from) return { color: RED, reason: NO_SELF }
  const has = (kind: EdgeView['kind']) => p.edges.some(e => e.from === w.from && e.to === target.id && e.kind === kind)
  return has('handoff') && has('delegate') ? { color: RED, reason: NO_MORE } : { color: GREEN }
}

// The distance from a point to a segment, with rows scaled (by `ratio`: the props' rowRatio) so cells are square.
function segDist(ratio: number, px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = (by - ay) * ratio
  const ex = px - ax
  const ey = (py - ay) * ratio
  const len = dx * dx + dy * dy
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, (ex * dx + ey * dy) / len))
  return Math.hypot(ex - t * dx, ey - t * dy)
}

// The arrows a cell belongs to, nearest first: in vector mode every curve within HIT_CELLS of the
// cell's centre (of equal distances the later arrow first, as it is drawn on top), else the one
// layer segment drawn in that cell (the character layer holds one arrow per cell).
function edgesAt(p: CanvasProps, x: number, y: number): EdgeView[] {
  if (p.vector) {
    const hits: Array<{ e: EdgeView; d: number }> = []
    for (let k = p.edges.length - 1; k >= 0; k--) {
      const e = p.edges[k]!
      const pts = e.path ?? []
      let d = Infinity
      for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(p.rowRatio, x + 0.5, y + 0.5, pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y))
      if (d <= HIT_CELLS) hits.push({ e, d })
    }
    return hits.sort((a, b) => a.d - b.d).map(h => h.e)
  }
  let at = 0
  for (const seg of p.layer[y] ?? []) {
    if (x >= at && x < at + seg.t.length) {
      const found = seg.e === undefined ? undefined : p.edges.find(e => e.id === seg.e)
      return found === undefined ? [] : [found]
    }
    at += seg.t.length
  }
  return []
}
const edgeAt = (p: CanvasProps, x: number, y: number): EdgeView | undefined => edgesAt(p, x, y)[0]

// Where an arrow's popup goes: under its midpoint, else above it, clear of the cards when it can be.
function popupRect(p: CanvasProps, edge: EdgeView, withButtons: boolean, width: number): Rect {
  const w = Math.min(48, Math.max(edge.label.length, withButtons ? BAR_W : 0) + 4)
  const h = withButtons ? 4 : 3
  const x = Math.max(0, Math.min(edge.mid.x - Math.floor(w / 2), width - w))
  const clampY = (y: number) => Math.max(0, Math.min(y, p.layer.length - h))
  const cards = p.cards.map(c => ({ x: c.x, y: c.y, w: p.cardW, h: p.cardH }))
  const covered = (r: Rect) => cards.reduce((sum, c) => sum + overlapArea(r, c), 0)
  // Just below the midpoint, just above it, then lower and lower down to below a card's height.
  const ys = [edge.mid.y + 1, edge.mid.y - h]
  for (let y = edge.mid.y + 2; y <= edge.mid.y + 1 + p.cardH; y++) ys.push(y)
  const candidates = ys.map(y => ({ x, y: clampY(y), w, h }))
  // The first that covers no card; else the one that covers least (the earliest on a tie).
  return candidates.reduce((best, r) => (covered(best) === 0 || covered(r) >= covered(best) ? best : r))
}

// Draws the arrows layer with the cards on top. Hover, selection, the connect
// wire and the animations are local; finished actions are posted once per frame.
const Canvas: ClientModule<CanvasProps, State> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  const post = (data: CanvasPost) => surface.post(data)
  const cols = () => (surface.columns > 0 ? surface.columns : 200)
  let state = surface.state
  if (state === undefined) {
    const pending: CanvasEvent[] = []
    const first: State = {
      view: { hover: null, hoverEdge: null, picked: null, wire: null, base: props.drawnAt, ticks: 0, armed: null, armedAge: 0 },
      latest: { props, queue: pending },
    }
    state = first
    surface.setState(first)
    const now = () => surface.state ?? first
    const set = (change: Partial<View>) => surface.setState({ ...now(), view: { ...now().view, ...change } })
    surface.onPointer(e => {
      const p = now().latest.props
      const v = now().view
      if (v.wire !== null) {
        const wire = v.wire
        if (e.type === 'move' && (e.x !== wire.x || e.y !== wire.y)) set({ wire: { ...wire, x: e.x, y: e.y, moved: true } })
        else if (e.type === 'up') {
          const target = spotAt(p, e.x, e.y, v.armed)?.card
          const check = wireCheck(p, { ...wire, x: e.x, y: e.y }, v.armed)
          // Letting go outside the canvas (the Client keeps the pointer) cancels the wire.
          const outside = e.x < 0 || e.y < 0 || e.x >= cols() || e.y >= (surface.rows > 0 ? surface.rows : p.layer.length)
          if (!wire.moved) pending.push({ kind: 'port', from: wire.from })
          else if (!outside && target === undefined) pending.push({ kind: 'spawn', from: wire.from, x: e.x, y: e.y })
          else if (target !== undefined && check.reason === undefined) pending.push({ kind: 'wire', from: wire.from, to: target.id })
          set({ wire: null })
        }
        return
      }
      if (e.type === 'down') {
        // The picked arrow's popup belongs to its buttons.
        const picked = v.picked === null ? undefined : p.edges.find(x => x.id === v.picked)
        // Only its button row: the other popup cells are plain canvas under it.
        if (picked !== undefined && !p.isRunning) {
          const r = popupRect(p, picked, true, cols())
          if (inside(r, e.x, e.y) && e.y === r.y + 2) return
        }
        const spot = spotAt(p, e.x, e.y, v.armed)
        // Where arrows overlap, pressing the picked arrow's spot again picks the next one under it.
        const hits = spot === undefined ? edgesAt(p, e.x, e.y) : []
        const at = picked === undefined ? -1 : hits.indexOf(picked)
        const edge = hits.length === 0 ? undefined : hits[at >= 0 ? (at + 1) % hits.length : 0]
        // Any press that is not on the armed card's ✕ cancels the arming.
        const keepsArm = v.armed !== null && spot?.part === 'button' && spot.card.id === v.armed && e.y === spot.card.y + 1
        // While connecting, a press on an arrow only cancels the connect: it does not pick the arrow.
        const change: Partial<View> = { picked: p.connecting ? null : edge?.id ?? null }
        if (v.armed !== null && !keepsArm) Object.assign(change, { armed: null, armedAge: 0 })
        if (spot?.part === 'port') change.wire = { from: spot.card.id, x0: e.x, y0: e.y, x: e.x, y: e.y, moved: false }
        // While connecting, a press on an arrow is a press on empty canvas: the mod cancels the connect.
        else if ((edge === undefined || p.connecting) && spot?.part !== 'button') pending.push({ kind: 'down', x: e.x, y: e.y })
        set(change)
        return
      }
      if (e.type === 'move' && e.button !== undefined) pending.push({ kind: 'drag', x: e.x, y: e.y })
      else if (e.type === 'up') pending.push({ kind: 'up', x: e.x, y: e.y })
      if (e.type === 'move' || e.type === 'enter') {
        const spot = spotAt(p, e.x, e.y, v.armed)
        const hover = spot?.card.id ?? null
        const hoverEdge = spot === undefined ? edgeAt(p, e.x, e.y)?.id ?? null : null
        if (hover !== v.hover || hoverEdge !== v.hoverEdge) set({ hover, hoverEdge })
      } else if (e.type === 'leave' && (v.hover !== null || v.hoverEdge !== null)) set({ hover: null, hoverEdge: null })
    })
    surface.onKey(e => {
      const key = e.key.toLowerCase()
      const picked = now().view.picked
      // While an arrow is selected, these keys are not for the selected card (the canvas has no key for an arrow).
      if (picked !== null && now().latest.props.edges.some(x => x.id === picked) && SWALLOWED.has(key)) return
      // Some terminals send Ctrl+Shift+Z as a capital Z, so single letters keep their case with ctrl.
      pending.push({ kind: 'key', key: e.ctrl === true && e.key.length === 1 ? e.key : key, ...(e.ctrl === true ? { ctrl: true } : {}), ...(e.shift === true ? { shift: true } : {}) })
    })
    // The arrow and card the SVG should glow: the picked (else hovered) arrow, and the hovered card.
    // It starts at a pair no real focus equals, so the first tick posts the current one
    // (and clears a glow that the stored focus kept from before this instance).
    let sent: { edge: string | null; card: string | null } = { edge: '\u0000', card: '\u0000' }
    surface.every(16, () => {
      const v = now().view
      const edges = now().latest.props.edges
      // Only the vector layer draws the focus, so only it is told.
      if (!now().latest.props.vector) {
        if (pending.length > 0) post({ events: pending.splice(0) })
        return
      }
      const known = (id: string | null) => (id !== null && edges.some(e => e.id === id) ? id : null)
      const focus = { edge: v.wire === null ? known(v.picked) ?? known(v.hoverEdge) : null, card: v.hover }
      if (focus.edge !== sent.edge || focus.card !== sent.card) {
        sent = focus
        pending.push({ kind: 'focus', ...focus })
      }
      if (pending.length > 0) post({ events: pending.splice(0) })
    })
    surface.every(250, () => {
      const p = now().latest.props
      const v = now().view
      const moving = p.isRunning && (p.cards.some(c => c.tone === 'running') || p.edges.some(e => e.flow === 'flowing'))
      if (!moving && v.armed === null) return
      const change: Partial<View> = moving ? (v.base === p.drawnAt ? { ticks: v.ticks + 1 } : { base: p.drawnAt, ticks: 1 }) : {}
      // An armed ✕ also disarms the moment its card or arrow can no longer be deleted (a run started).
      if (v.armed !== null) Object.assign(change, v.armedAge + 1 >= ARM_TICKS || !canDelete(p, v.armed) ? { armed: null, armedAge: 0 } : { armedAge: v.armedAge + 1 })
      set(change)
    })
  }
  state.latest.props = props
  const { hover, hoverEdge, picked, wire, base, ticks, armed } = state.view
  const p = props
  const width = cols()
  const { queue } = state.latest
  const press = (node: string, action: 'edit' | 'run') => queue.push({ kind: 'press', node, action })
  // Handlers (not this render) may set state: the first press arms a ✕, the second confirms.
  const arm = (id: string, confirmed: CanvasEvent, after: Partial<View> = {}) => {
    const current = surface.state ?? state
    if (current.view.armed === id) {
      queue.push(confirmed)
      surface.setState({ ...current, view: { ...current.view, armed: null, armedAge: 0, ...after } })
    } else surface.setState({ ...current, view: { ...current.view, armed: id, armedAge: 0 } })
  }

  const edgeById = (id: string | null) => (id === null ? undefined : p.edges.find(e => e.id === id))
  const pickedEdge = wire === null ? edgeById(picked) : undefined
  const shownEdge = pickedEdge ?? (wire === null ? edgeById(hoverEdge) : undefined)
  const hot = new Set(hover === null ? [] : p.edges.filter(e => e.from === hover || e.to === hover).map(e => e.id))
  if (shownEdge !== undefined) hot.add(shownEdge.id)
  const flows = new Map(p.edges.map(e => [e.id, e.flow]))
  const faded = new Set(p.edges.filter(e => e.flow === 'delivered' && e.recent === false).map(e => e.id))

  const row = (segs: Seg[]) =>
    segs.map((seg, i) => {
      if (seg.s === '' || seg.e === undefined) return <Text key={`seg-${i}`}>{seg.t}</Text>
      const flow = flows.get(seg.e) ?? 'idle'
      const isHot = hot.has(seg.e)
      const color = flow === 'delivered' ? GREEN : isHot ? HOT[seg.s] : seg.s === 'h' ? GOLD : seg.s === 'r' ? ORANGE : BLUE
      // Flowing arrows: a dot every third cell of the path, moving one cell per tick toward the head
      // (an arrow's own text, which has no place on the path, keeps its characters).
      const text = flow !== 'flowing' || seg.i === undefined ? seg.t
        : [...seg.t].map((ch, k) => (!HEADS.has(ch) && (((seg.i ?? 0) + (seg.d ?? 1) * k - ticks) % 3 + 3) % 3 === 0 ? '•' : ch)).join('')
      return <Text key={`seg-${i}`} color={color} bold={isHot} dimColor={flow === 'dead' || faded.has(seg.e)}>{text}</Text>
    })

  const inner = p.cardW - 4
  const card = (c: CardView) => {
    const since = p.drawnAt + (base === p.drawnAt ? ticks * 250 : 0)
    // An agent waiting to be started again counts down to it, and its ◷ stands still.
    const left = c.restartAt === undefined ? undefined : countdown(c.restartAt - since)
    const glyph = c.tone === 'running' && left === undefined ? SPIN[ticks % SPIN.length]! : c.glyph
    const elapsed = c.tone === 'running' && left === undefined && c.startedAt !== undefined ? clock(since - c.startedAt) : undefined
    // A running agent's current call keeps its time counting; the call's text gives way to it, and to the round of a loop card.
    const tail = elapsed === undefined ? '' : ` · ${elapsed}`
    const more = c.round === undefined ? '' : ` · ${c.round}`
    const line = left !== undefined ? `${c.restartLabel ?? 'retry'} · in ${left}`
      : elapsed === undefined ? c.line
      : c.live !== undefined ? clip(c.live, Math.max(1, inner - tail.length - more.length)) + tail + more
      : roundedLine(`${elapsed}${c.round === undefined ? ' elapsed' : ''}${c.costUsd !== undefined ? ` · ${c.costEstimated === true ? '≈' : ''}$${c.costUsd.toFixed(2)}` : ''}`, c.round, inner)
    // A warning's △ is orange on its own; the name keeps its colour.
    const title = clip(`${glyph} ${c.name}`, inner - (c.pauses ? 4 : 2))
    const warns = c.glyph === '△'
    return (
      <Box
        key={`card-${c.id}`}
        position="absolute"
        left={c.x}
        top={c.y}
        width={p.cardW}
        height={p.cardH}
        flexDirection="column"
        paddingX={1}
        borderStyle={c.isMarked ? 'bold' : 'round'}
        borderColor={c.id === hover ? GOLD : TONE[c.tone]}
        borderDimColor={c.tone === 'skipped' || c.dimmed || c.reused !== undefined}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end" bold={c.isMarked} dimColor={c.dimmed} color={c.reused !== undefined ? undefined : c.tone === 'running' || c.tone === 'paused' || c.tone === 'stale' ? ORANGE : c.tone === 'done' ? GREEN : c.tone === 'failed' || c.tone === 'cancelled' || c.tone === 'problem' ? RED : undefined}>
            {warns ? <Text key="warn" color={ORANGE}>{title.slice(0, 1)}</Text> : null}
            {warns ? title.slice(1) : title}
          </Text>
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            {c.pauses ? <Text color={ORANGE}>‖</Text> : null}
            {c.canDelete ? <Button key={`card-del-${c.id}`} plain label={armed === c.id ? ARMED_LABEL : '✕'} onPress={() => arm(c.id, { kind: 'press', node: c.id, action: 'delete' })} /> : null}
          </Box>
        </Box>
        <Text wrap="truncate-end" dimColor={c.lineTone === 'dim' || c.dimmed} color={c.lineTone === 'error' ? RED : c.lineTone === 'active' ? ORANGE : undefined}>{clip(line, inner) || ' '}</Text>
        <Box flexDirection="row" columnGap={2}>
          {c.isCheck === true ? null : <Button key={`card-edit-${c.id}`} plain label="✎ Edit" onPress={() => press(c.id, 'edit')} />}
          {c.canRunFrom ? <Button key={`card-run-${c.id}`} plain label="▶ From here" onPress={() => press(c.id, 'run')} /> : null}
        </Box>
      </Box>
    )
  }
  const port = (c: CardView) => (
    <Box key={`port-${c.id}`} position="absolute" left={c.x + p.cardW - 1} top={c.y + 2}>
      <Text bold color={wire?.from === c.id ? ORANGE : GOLD}>►</Text>
    </Box>
  )

  const wireParts = (w: Wire) => {
    const { color, reason } = wireCheck(p, w, armed)
    const x = Math.min(Math.max(w.x, 0), width - 1)
    const y = Math.min(Math.max(w.y, 0), p.layer.length - 1)
    const xa = Math.min(w.x0 + 1, x)
    const xb = Math.max(w.x0 + 1, x)
    const ya = Math.min(w.y0, y)
    const yb = Math.max(w.y0, y)
    return [
      // A Box of exactly the leg's cells, so on proportional text the run still ends at the vertical leg.
      <Box key="wire-h" position="absolute" left={xa} top={w.y0} width={xb - xa + 1} height={1} overflow="hidden"><Text key="wire-h-line" color={color}>{'┄'.repeat(2 * (xb - xa + 1))}</Text></Box>,
      yb > ya ? (
        <Box key="wire-v" position="absolute" left={x} top={ya} flexDirection="column">
          {Array.from({ length: yb - ya + 1 }, (_, i) => <Text key={`wire-v-${i}`} color={color}>┆</Text>)}
        </Box>
      ) : null,
      reason === undefined ? null : (
        <Box key="wire-reason" position="absolute" left={Math.max(0, Math.min(x + 2, width - reason.length))} top={Math.min(y + 1, p.layer.length - 1)}>
          <Text key="wire-reason-text" color={color}>{reason}</Text>
        </Box>
      ),
    ]
  }

  // A retry arrow's `↺ <retries>` at its start cell, over the vector layer (the character layer carries its own).
  const retryTag = (e: EdgeView) =>
    e.tag === undefined ? null : (
      <Box key={`retry-tag-${e.id}`} position="absolute" left={e.tag.x} top={e.tag.y}>
        <Text color={ORANGE} bold={hot.has(e.id)}>{e.tag.t}</Text>
      </Box>
    )

  const popup = (edge: EdgeView, withButtons: boolean) => {
    const r = popupRect(p, edge, withButtons, width)
    return (
      <Box key="edge-popup" position="absolute" left={r.x} top={r.y} width={r.w} height={r.h} flexDirection="column" paddingX={1} borderStyle="round" borderColor={edge.kind === 'handoff' ? GOLD : edge.kind === 'retry' ? ORANGE : BLUE}>
        <Text wrap="truncate-end" dimColor>{clip(edge.label, r.w - 4)}</Text>
        {withButtons ? (
          <Box flexDirection="row" columnGap={2}>
            <Button key={`edge-kind-${edge.id}`} plain label={`⇄ ${edge.kind === 'handoff' ? 'delegate' : edge.kind === 'delegate' ? 'retry' : 'handoff'}`} onPress={() => queue.push({ kind: 'edge', edge: edge.id, action: 'retype' })} />
            <Button key={`edge-rev-${edge.id}`} plain label="↻ reverse" onPress={() => queue.push({ kind: 'edge', edge: edge.id, action: 'reverse' })} />
            <Button key={`edge-del-${edge.id}`} plain label={armed === edge.id ? ARMED_LABEL : '✕'} onPress={() => arm(edge.id, { kind: 'edge', edge: edge.id, action: 'delete' }, { picked: null })} />
          </Box>
        ) : null}
      </Box>
    )
  }

  const tipped = hover === null || wire !== null ? undefined : p.cards.find(c => c.id === hover)

  return (
    <Box flexDirection="column">
      {p.layer.map((segs, y) => <Text key={`layer-${y}`}>{p.vector || segs.length === 0 ? ' ' : row(segs)}</Text>)}
      {p.vector ? p.edges.map(retryTag) : null}
      {p.cards.map(card)}
      {p.cards.map(port)}
      {wire !== null ? wireParts(wire) : null}
      {tipped !== undefined && tipped.tip !== '' ? (
        <Box key="tip" position="absolute" left={tipped.x} top={tipped.y + p.cardH}>
          <Text wrap="truncate-end" dimColor>{clip(tipped.tip, 48)}</Text>
        </Box>
      ) : null}
      {shownEdge !== undefined ? popup(shownEdge, shownEdge === pickedEdge && !p.isRunning) : null}
    </Box>
  )
}

export default Canvas
