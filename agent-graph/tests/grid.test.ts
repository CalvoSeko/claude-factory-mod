import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Edge, Graph, NodeRunView, NodeStatus, RunView } from '../types'
import { bezierAt, cardsOf, clockTime, curveOf, drawEdges, edgesOf, flowOf, hitTest, midOf, rowText, SVG_LIMIT, tagOf, timelineOf, timelineSpan, vectorBaseSvg, vectorGlowSvg } from '../hooks/grid'
import { connect } from '../hooks/model'

const node = (id: string, name: string, x: number, y: number): AgentNode => ({
  id, name, x, y, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
const g0: Graph = {
  id: 'g', name: 'G', description: '', backend: 'local', layout: 2,
  nodes: [node('a', 'Researcher', 1, 1), node('b', 'Writer', 40, 1), node('c', 'Checker', 40, 10)], edges: [],
}
const size = { cols: 70, rows: 16 }
const options = { selected: null, connecting: null, run: null, problems: [], instructions: () => '' }

test('arrows leave and enter cards at row 2, each kind with its own line', async () => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'delegate')
  const lines = drawEdges(g, size).map(rowText)
  expect(lines[3]).toContain('━')
  expect(lines[3]?.indexOf('━')).toBe(27)
  expect(lines[3]).toContain('►')
  expect(lines.some(l => l.includes('┆'))).toBe(true)
  expect(lines.some(l => l.includes('▼'))).toBe(true)
  expect(lines.join('\n')).not.toContain('Researcher')
})

test('arrow segments carry their edge id', async () => {
  const g = connect(g0, 'a', 'b', 'handoff')
  const id = g.edges[0]!.id
  const segs = drawEdges(g, size).flat()
  expect(segs.filter(s => s.s === 'h').every(s => s.e === id)).toBe(true)
  expect(segs.filter(s => s.s === '').every(s => s.e === undefined)).toBe(true)
})

test('cards describe each agent when idle', async () => {
  const g: Graph = { ...g0, nodes: [{ ...g0.nodes[0]!, model: 'opus', skills: ['pdf', 'xlsx'], tools: ['Read'] }, g0.nodes[1]!] }
  const [a, b] = cardsOf(g, { ...options, selected: 'b', instructions: n => (n.id === 'a' ? '\n  Find sources.\nMore' : '') })
  expect(a).toMatchObject({ id: 'a', name: 'Researcher', x: 1, y: 1, glyph: ' ', tone: 'idle', isMarked: false, line: 'opus · 2 skills · 1 tool', lineTone: 'dim', tip: 'Find sources.', canRunFrom: true, canDelete: true })
  expect(b).toMatchObject({ tone: 'selected', isMarked: true, line: 'inherit · 0 skills' })
})

test('a card carries that its cost is an estimate', async () => {
  const run: RunView = {
    graphId: 'g', graphName: 'G', isRunning: true,
    nodes: { a: { status: 'running', startedAt: 500, costUsd: 0.25, costEstimated: true }, b: { status: 'running', startedAt: 500, costUsd: 0.5 } },
  }
  const [a, b] = cardsOf(g0, { ...options, run })
  expect(a).toMatchObject({ costUsd: 0.25, costEstimated: true })
  expect(b!.costEstimated).toBeUndefined()
})

test('cards show problems and run progress', async () => {
  const run: RunView = {
    graphId: 'g', graphName: 'G', isRunning: true,
    nodes: { a: { status: 'running', startedAt: 500, costUsd: 0.25 }, b: { status: 'failed', error: 'Boom\nstack' }, c: { status: 'waiting' } },
  }
  const [a, b, c] = cardsOf(g0, { ...options, run })
  expect(a).toMatchObject({ glyph: '◐', tone: 'running', line: '', startedAt: 500, costUsd: 0.25, canRunFrom: false, canDelete: false })
  expect(b).toMatchObject({ glyph: '✕', tone: 'failed', line: 'Boom', lineTone: 'error' })
  expect(c).toMatchObject({ glyph: '○', tone: 'idle', line: 'waiting' })
  const done = cardsOf(g0, { ...options, run: { ...run, isRunning: false, nodes: { a: { status: 'done', output: 'Found 3.\nDetails' } } } })[0]
  expect(done).toMatchObject({ glyph: '●', tone: 'done', line: 'Found 3.', canRunFrom: true, canDelete: true })
  const problem = cardsOf(g0, { ...options, problems: [{ target: { kind: 'node', id: 'b' }, message: 'x' }] })[1]
  expect(problem).toMatchObject({ glyph: '!', tone: 'problem' })
})

test('run from here is offered only when the downstream part is valid', async () => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'a', 'handoff')
  expect(cardsOf(g, options).map(c => c.canRunFrom)).toEqual([false, false, true])
})

test('hitTest finds the card under a cell', async () => {
  expect(hitTest(g0, 3, 2)?.id).toBe('a')
  expect(hitTest(g0, 26, 5)?.id).toBe('a')
  expect(hitTest(g0, 28, 2)).toBeUndefined()
})

const cellEdge = (layer: ReturnType<typeof drawEdges>, x: number, y: number) => {
  let at = 0
  for (const seg of layer[y] ?? []) {
    if (x >= at && x < at + seg.t.length) return seg.e
    at += seg.t.length
  }
  return undefined
}

test('each arrow has a label and a midpoint on its own line', async () => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'delegate')
  const layer = drawEdges(g, size)
  const views = edgesOf(g, null)
  expect(views.map(v => v.label)).toEqual(['handoff · Researcher → Writer', 'delegate · Writer → Checker'])
  for (const v of views) expect(cellEdge(layer, v.mid.x, v.mid.y), v.label).toBe(v.id)
  expect(views.every(v => v.flow === 'idle')).toBe(true)
})

test('arrow flow follows the run', async () => {
  const h: Edge = { id: 'e', from: 'a', to: 'b', kind: 'handoff' }
  const d: Edge = { ...h, kind: 'delegate' }
  const run = (a?: NodeStatus, b?: NodeStatus): RunView => ({
    graphId: 'g', graphName: 'G', isRunning: true,
    nodes: { ...(a ? { a: { status: a } } : {}), ...(b ? { b: { status: b } } : {}) },
  })
  expect(flowOf(h, null)).toBe('idle')
  expect(flowOf(h, run('running', 'waiting'))).toBe('idle')
  expect(flowOf(h, run('done', 'waiting'))).toBe('flowing')
  expect(flowOf(h, run('done', 'running'))).toBe('flowing')
  expect(flowOf(h, run('done', 'done'))).toBe('delivered')
  expect(flowOf(h, run('done', 'failed'))).toBe('delivered')
  expect(flowOf(h, run('failed', 'skipped'))).toBe('dead')
  expect(flowOf(h, run('done', 'skipped'))).toBe('dead')
  expect(flowOf(h, run(undefined, 'running'))).toBe('idle')
  expect(flowOf(d, run('running'))).toBe('flowing')
  expect(flowOf(d, run('done'))).toBe('delivered')
  expect(flowOf(d, run('failed'))).toBe('dead')
  expect(flowOf(d, run('waiting'))).toBe('idle')
})

// The cells of one arrow in layer order, with the column each is at.
const cellsOf = (layer: ReturnType<typeof drawEdges>, id: string) => {
  const cells: { x: number; y: number; ch: string; i: number | undefined }[] = []
  layer.forEach((segs, y) => {
    let at = 0
    for (const seg of segs) {
      if (seg.e === id) {
        ;[...seg.t].forEach((ch, k) => cells.push({ x: at + k, y, ch, i: seg.i === undefined ? undefined : seg.i + (seg.d ?? 1) * k }))
      }
      at += seg.t.length
    }
  })
  return cells
}

test('arrow cells are numbered along the path, tail to head', async () => {
  const right = connect(g0, 'a', 'b', 'handoff')
  const swapped: Graph = { ...g0, nodes: [{ ...g0.nodes[0]!, x: 40 }, { ...g0.nodes[1]!, x: 1 }, g0.nodes[2]!] }
  const left = connect(swapped, 'a', 'b', 'handoff')
  const down = connect(g0, 'b', 'c', 'delegate')
  const up = connect(g0, 'c', 'b', 'delegate')
  for (const g of [right, left, down, up]) {
    const id = g.edges[0]!.id
    const layer = drawEdges(g, size)
    const cells = cellsOf(layer, id)
    expect(cells.every(c => c.i !== undefined)).toBe(true)
    const byIndex = [...cells].sort((p, q) => p.i! - q.i!)
    byIndex.forEach((c, k) => {
      expect(c.i).toBe(k)
      const prev = byIndex[k - 1]
      if (prev !== undefined) expect(Math.abs(prev.x - c.x) + Math.abs(prev.y - c.y), 'adjacent cells').toBe(1)
    })
    const head = byIndex[byIndex.length - 1]!
    expect('►◄▼▲').toContain(head.ch)
    expect(cells.filter(c => '►◄▼▲'.includes(c.ch))).toHaveLength(1)
    const mid = edgesOf(g, null)[0]!.mid
    expect(cellEdge(layer, mid.x, mid.y)).toBe(id)
  }
  // Straight runs travel as one segment each, so the props stay small.
  expect(drawEdges(right, size).flat().filter(seg => seg.e === right.edges[0]!.id).length).toBeLessThanOrEqual(5)
  const leftCells = cellsOf(drawEdges(left, size), left.edges[0]!.id).sort((p, q) => p.i! - q.i!)
  expect(leftCells[0]!.x).toBeGreaterThan(leftCells[leftCells.length - 1]!.x)
})

const gc = (id: string) => g0.nodes.find(n => n.id === id)!
const nodeAt = (id: string, x: number, y: number): AgentNode => ({ ...gc(id), x, y })

test('a curve runs between the facing sides, tangent to them', async () => {
  const right = curveOf(gc('a'), gc('b'))
  expect(right[0]).toEqual({ x: 27, y: 3.5 })
  expect(right[3]).toEqual({ x: 40, y: 3.5 })
  expect(right[1].y).toBe(3.5)
  expect(right[2].y).toBe(3.5)
  expect(right[1].x).toBeGreaterThan(27)
  expect(right[2].x).toBeLessThan(40)

  const left = curveOf(nodeAt('a', 40, 1), nodeAt('b', 1, 1))
  expect(left[0]).toEqual({ x: 40, y: 3.5 })
  expect(left[3]).toEqual({ x: 27, y: 3.5 })
  expect(left[1].y).toBe(3.5)
  expect(left[2].y).toBe(3.5)
  expect(left[1].x).toBeLessThan(40)
  expect(left[2].x).toBeGreaterThan(27)

  const down = curveOf(gc('b'), gc('c'))
  expect(down[0]).toEqual({ x: 53, y: 6 })
  expect(down[3]).toEqual({ x: 53, y: 10 })
  expect(down[1].x).toBe(53)
  expect(down[2].x).toBe(53)
  expect(down[1].y).toBeGreaterThan(6)
  expect(down[2].y).toBeLessThan(10)

  const up = curveOf(gc('c'), gc('b'))
  expect(up[0]).toEqual({ x: 53, y: 10 })
  expect(up[3]).toEqual({ x: 53, y: 6 })
  expect(up[1].x).toBe(53)
  expect(up[2].x).toBe(53)
  expect(up[1].y).toBeLessThan(10)
  expect(up[2].y).toBeGreaterThan(6)
})

test('handles are half the gap, at least 3 cells across and 1.5 rows down', async () => {
  const wide = curveOf(gc('a'), nodeAt('b', 67, 1))
  expect(wide[1].x - wide[0].x).toBe(20)
  const near = curveOf(gc('a'), nodeAt('b', 29, 1))
  expect(near[1].x - near[0].x).toBe(3)
  const close = curveOf(nodeAt('a', 40, 1), nodeAt('b', 40, 7))
  expect(close[1].y - close[0].y).toBe(1.5)
})

test('bezierAt is the cubic: the ends at 0 and 1, the middle between', async () => {
  const c = curveOf(gc('a'), gc('b'))
  expect(bezierAt(c, 0)).toEqual(c[0])
  expect(bezierAt(c, 1)).toEqual(c[3])
  const mid = bezierAt(c, 0.5)
  expect(Math.abs(mid.x - 33.5)).toBeLessThan(1e-9)
  expect(Math.abs(mid.y - 3.5)).toBeLessThan(1e-9)
})

test('vector edges carry a sampled path and the curve midpoint; plain edges do not', async () => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'delegate')
  for (const e of edgesOf(g, null)) expect(e.path).toBeUndefined()
  const views = edgesOf(g, null, true)
  for (const e of views) {
    const c = curveOf(gc(e.from), gc(e.to))
    expect(e.path).toHaveLength(25)
    expect(e.path![0]).toEqual(c[0])
    expect(e.path![24]).toEqual(c[3])
    const m = bezierAt(c, 0.5)
    expect(e.mid).toEqual({ x: Math.round(m.x), y: Math.round(m.y) })
  }
  expect(views.every(e => e.path!.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)))).toBe(true)
})

const pathsIn = (svg: string) => svg.match(/<path\b[^>]*>/g) ?? []

test('the vector layer draws one path per arrow, with the curve as its d', async () => {
  const g = connect(g0, 'a', 'b', 'handoff')
  const svg = vectorBaseSvg(g, edgesOf(g, null, true), size)
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg).toContain(`width="${70 * 24}"`)
  expect(svg).toContain(`height="${Math.round(16 * 24 * 2.37)}"`)
  const paths = pathsIn(svg)
  expect(paths).toHaveLength(1)
  // a -> b: M (27, 3.5) C (33.5, 3.5) (33.5, 3.5) (40, 3.5) in units of 24 x 56.88.
  expect(paths[0]).toContain('d="M648 199.1 C804 199.1 804 199.1 960 199.1"')
  expect(paths[0]).toContain('stroke="#c9a227"')
  expect(paths[0]).toContain('stroke-width="2.5"')
  expect(paths[0]).toContain('marker-end="url(#m-c9a227)"')
  expect(svg).toContain('id="m-c9a227"')
  expect(svg).not.toContain('<animate')
  expect(svg).not.toContain('stroke-dasharray')
})

test('a delegate is dashed blue; delivered is green; dead is faint', async () => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'delegate')
  const [h, d] = edgesOf(g, null, true)
  const delegate = vectorBaseSvg(g, [d!], size)
  expect(delegate).toContain('stroke="#7c8db5"')
  expect(delegate).toContain('stroke-dasharray="7 6"')
  const delivered = pathsIn(vectorBaseSvg(g, [{ ...h!, flow: 'delivered' }], size))[0]!
  expect(delivered).toContain('stroke="#5aa469"')
  expect(delivered).not.toContain('opacity')
  const dead = pathsIn(vectorBaseSvg(g, [{ ...h!, flow: 'dead' }], size))[0]!
  expect(dead).toContain('stroke="#c9a227"')
  expect(dead).toContain('opacity="0.3"')
})

test('flowing arrows get an animated dot overlay; idle ones do not', async () => {
  const g = connect(g0, 'a', 'b', 'handoff')
  const [e] = edgesOf(g, null, true)
  expect(vectorBaseSvg(g, [e!], size)).not.toContain('<animate')
  const svg = vectorBaseSvg(g, [{ ...e!, flow: 'flowing' }], size)
  expect(svg.match(/<animate\b/g)).toHaveLength(1)
  expect(svg).toContain('attributeName="stroke-dashoffset"')
  expect(svg).toContain('repeatCount="indefinite"')
  expect(svg).toContain('stroke-dasharray="0.1 16"')
  expect(svg).toContain('#fff4c2')
  expect(pathsIn(svg)).toHaveLength(2)
})

test('the glow is null without focus, and draws only the focused arrows in bright, wide and with a glow', async () => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'delegate')
  const views = edgesOf(g, null, true)
  expect(vectorGlowSvg(views, undefined, size)).toBeNull()
  expect(vectorGlowSvg(views, { edge: null, card: null }, size)).toBeNull()
  expect(vectorGlowSvg(views, { edge: 'nope', card: 'zzz' }, size)).toBeNull()

  const byEdge = vectorGlowSvg(views, { edge: views[0]!.id, card: null }, size)!
  const paths = pathsIn(byEdge)
  // glow + bright stroke for the focused handoff only.
  expect(paths).toHaveLength(2)
  expect(byEdge).toContain('stroke="#f0c040"')
  expect(paths.some(p => p.includes('stroke-width="3.5"'))).toBe(true)
  expect(paths.some(p => p.includes('stroke-width="10"') && p.includes('stroke-opacity="0.22"'))).toBe(true)
  expect(byEdge).not.toContain('#a9b8e0')
  expect(byEdge).toContain('width="1680"')
  expect(byEdge).toContain(`height="${Math.round(16 * 24 * 2.37)}"`)

  const byCard = vectorGlowSvg(views, { edge: null, card: 'b' }, size)!
  expect(byCard).toContain('stroke="#f0c040"')
  expect(byCard).toContain('stroke="#a9b8e0"')
  expect(pathsIn(byCard)).toHaveLength(4)

  const byOther = vectorGlowSvg(views, { edge: null, card: 'a' }, size)!
  expect(byOther).toContain('stroke="#f0c040"')
  expect(byOther).not.toContain('#a9b8e0')
})

test('the base source never depends on the focus, and has the same size as the glow', async () => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'delegate')
  const views = edgesOf(g, null, true)
  const base = vectorBaseSvg(g, views, size)
  expect(base).not.toContain('#f0c040')
  expect(base).not.toContain('#a9b8e0')
  const head = (svg: string) => svg.slice(0, svg.indexOf('>'))
  expect(head(vectorGlowSvg(views, { edge: views[0]!.id, card: null }, size)!)).toBe(head(base))
})

test('only the base draws the moving dots, and only for flowing arrows', async () => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'delegate')
  const views = edgesOf(g, null, true)
  expect(vectorBaseSvg(g, views, size)).not.toContain('<animate')
  const flowing = views.map(e => ({ ...e, flow: 'flowing' as const }))
  expect(vectorBaseSvg(g, flowing, size).match(/<animate\b/g)).toHaveLength(2)
  expect(vectorGlowSvg(flowing, { edge: flowing[0]!.id, card: 'b' }, size)).not.toContain('<animate')
})

test('the vector markup has no script and no event attributes', async () => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'delegate')
  const views = edgesOf(g, null, true).map(e => ({ ...e, flow: 'flowing' as const }))
  for (const svg of [vectorBaseSvg(g, views, size), vectorGlowSvg(views, { edge: views[0]!.id, card: 'b' }, size)!]) {
    expect(svg).not.toContain('<script')
    expect(svg).not.toMatch(/\son\w+=/)
    expect(svg.length).toBeLessThan(131072)
  }
})

test('with hundreds of arrows the dots go first, then the glow; the arrows stay', async () => {
  const many: Graph = { ...g0, edges: Array.from({ length: 400 }, (_, i) => ({ id: `x${i}`, from: i % 2 === 0 ? 'a' : 'b', to: i % 2 === 0 ? 'b' : 'a', kind: 'handoff' as const })) }
  const views = edgesOf(many, null, true).map(e => ({ ...e, flow: 'flowing' as const }))
  expect(views).toHaveLength(400)
  const base = vectorBaseSvg(many, views, size)
  expect(base.length).toBeLessThanOrEqual(131072)
  expect(base).not.toContain('<animate')
  expect(pathsIn(base)).toHaveLength(400)
  const glow = vectorGlowSvg(views, { edge: null, card: 'a' }, size)
  expect(glow === null || glow.length <= 131072).toBe(true)
  expect(glow).toBeNull()
})

test('a disabled card shows ◌ and passes input through; a warning marks its card', async () => {
  const g: Graph = { ...g0, nodes: [{ ...g0.nodes[0]!, disabled: true }, g0.nodes[1]!, g0.nodes[2]!] }
  const run: RunView = { graphId: 'g', graphName: 'G', isRunning: false, nodes: { c: { status: 'done', output: 'x' } } }
  const [a, b, c] = cardsOf(g, { ...options, run, warnings: [{ target: { kind: 'node', id: 'b' }, message: 'w' }] })
  expect(a).toMatchObject({ glyph: '◌', tone: 'idle', line: 'disabled · passes input through', lineTone: 'dim', disabled: true, warn: false, canRunFrom: false })
  expect(b).toMatchObject({ disabled: false, warn: true })
  expect(c).toMatchObject({ disabled: false, warn: false })
})

test('a disabled card that has a run entry shows that status like any other card', async () => {
  const g: Graph = { ...g0, nodes: [{ ...g0.nodes[0]!, disabled: true }, g0.nodes[1]!, g0.nodes[2]!] }
  const run: RunView = { graphId: 'g', graphName: 'G', isRunning: true, nodes: { a: { status: 'running', startedAt: 1000, costUsd: 0.25 } } }
  const [a] = cardsOf(g, { ...options, run })
  expect(a).toMatchObject({ glyph: '◐', tone: 'running', line: '', disabled: true, startedAt: 1000, costUsd: 0.25 })
  const done: RunView = { ...run, isRunning: false, nodes: { a: { status: 'done', output: 'x' } } }
  expect(cardsOf(g, { ...options, run: done })[0]).toMatchObject({ glyph: '●', tone: 'done', line: 'x', disabled: true })
})

test('a warning shows △ as the glyph of a card with no run status; a problem still shows !', async () => {
  const warnings = [{ target: { kind: 'node' as const, id: 'a' }, message: 'w' }]
  const problems = [{ target: { kind: 'node' as const, id: 'a' }, message: 'p' }]
  expect(cardsOf(g0, { ...options, warnings })[0]).toMatchObject({ glyph: '△', warn: true })
  expect(cardsOf(g0, { ...options, warnings, problems })[0]).toMatchObject({ glyph: '!' })
  const run: RunView = { graphId: 'g', graphName: 'G', isRunning: true, nodes: { a: { status: 'running' } } }
  expect(cardsOf(g0, { ...options, warnings, run })[0]).toMatchObject({ glyph: '◐' })
})

test('a delegate arrow draws a hollow circle at its tail in the terminal layer, and nowhere else', async () => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'delegate')
  const [h, d] = g.edges
  const layer = drawEdges(g, size)
  const tail = cellsOf(layer, d!.id).find(c => c.i === 0)!
  expect(tail.ch).toBe('○')
  expect(cellsOf(layer, d!.id).filter(c => c.ch === '○')).toHaveLength(1)
  expect(cellsOf(layer, h!.id).some(c => c.ch === '○')).toBe(false)
})

test('the delegate arrow in the vector base has a hollow circle marker at its start', async () => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'delegate')
  const [h, d] = edgesOf(g, null, true)
  const delegate = vectorBaseSvg(g, [d!], size)
  const path = pathsIn(delegate)[0]!
  const id = path.match(/marker-start="url\(#([^)]+)\)"/)?.[1]
  expect(id).toBeDefined()
  const marker = delegate.match(new RegExp(`<marker id="${id}"[^>]*>.*?</marker>`))?.[0] ?? ''
  expect(marker).toContain('<circle')
  expect(marker).toContain('fill="none"')
  expect(marker).toContain('stroke="#7c8db5"')
  expect(marker).toContain('r="4"')
  expect(pathsIn(vectorBaseSvg(g, [h!], size))[0]).not.toContain('marker-start')
  // A delivered delegate's circle takes the arrow's colour.
  expect(vectorBaseSvg(g, [{ ...d!, flow: 'delivered' }], size)).toMatch(/<circle[^>]*stroke="#5aa469"/)
})

test('the newest delivered handoff is recent; older ones fade; others carry no flag', async () => {
  const g = connect(connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'handoff'), 'a', 'c', 'delegate')
  const [ab, bc, ac] = g.edges
  const run: RunView = {
    graphId: 'g', graphName: 'G', isRunning: true,
    nodes: { a: { status: 'done', startedAt: 1 }, b: { status: 'done', startedAt: 10 }, c: { status: 'done', startedAt: 20 } },
  }
  const views = edgesOf(g, run, true)
  expect(views.find(e => e.id === ab!.id)!.recent).toBe(false)
  expect(views.find(e => e.id === bc!.id)!.recent).toBe(true)
  expect(views.find(e => e.id === ac!.id)!.recent).toBeUndefined()
  expect(edgesOf(g, null)[0]!.recent).toBeUndefined()
  // Fade: only a delivered arrow flagged not recent is drawn at 0.45.
  const svg = (e: (typeof views)[number]) => pathsIn(vectorBaseSvg(g, [e], size))[0]!
  expect(svg(views.find(e => e.id === ab!.id)!)).toContain('opacity="0.45"')
  expect(svg(views.find(e => e.id === bc!.id)!)).not.toContain('opacity')
  expect(svg({ ...views[0]!, recent: undefined })).not.toContain('opacity')
})

const finished: RunView = {
  graphId: 'g', graphName: 'G', isRunning: false,
  nodes: { a: { status: 'done', output: 'Found 3.' }, b: { status: 'done', output: 'Wrote it.' } },
}

test('stale cards show the cause, the glyph and a tip', async () => {
  const stale = { a: 'task', b: 'changed', c: 'upstream' } as const
  const [a, b, c] = cardsOf(g0, { ...options, stale })
  expect(a).toMatchObject({ glyph: '↻', tone: 'stale', line: 'stale · task changed', lineTone: 'dim', stale: 'task', tip: 'Out of date: task changed. Run it or use From here.' })
  expect(b).toMatchObject({ glyph: '↻', tone: 'stale', line: 'stale · setup changed', stale: 'changed' })
  expect(c).toMatchObject({ glyph: '↻', line: 'stale · input changed', stale: 'upstream' })
  const never = cardsOf(g0, { ...options, stale: { a: 'never' } })[0]
  expect(never).toMatchObject({ glyph: '↻', line: 'stale · no output yet', tip: 'Out of date: no output yet. Run it or use From here.' })
  // Every wording fits a card's 22-cell line.
  for (const line of ['stale · task changed', 'stale · setup changed', 'stale · input changed', 'stale · no output yet']) expect(line.length).toBeLessThanOrEqual(22)
  // Stale outranks the finished status of the run on show.
  const shown = cardsOf(g0, { ...options, run: finished, stale: { a: 'changed' } })
  expect(shown[0]).toMatchObject({ glyph: '↻', tone: 'stale', line: 'stale · setup changed' })
  expect(shown[1]).toMatchObject({ glyph: '●', tone: 'done', line: 'Wrote it.' })
})

test('no stale look while a run is going or a past run is shown, and disabled stays disabled', async () => {
  const stale = { a: 'task', b: 'task' } as const
  const live: RunView = { ...finished, isRunning: true, nodes: { a: { status: 'running' }, b: { status: 'waiting' } } }
  expect(cardsOf(g0, { ...options, run: live, stale }).map(c => c.glyph)).toEqual(['◐', '○', ' '])
  const past = cardsOf(g0, { ...options, run: { ...finished, isHistoric: true }, stale })
  expect(past.map(c => c.glyph)).toEqual(['●', '●', ' '])
  expect(past.every(c => c.stale === undefined)).toBe(true)
  const off: Graph = { ...g0, nodes: [{ ...g0.nodes[0]!, disabled: true }, g0.nodes[1]!, g0.nodes[2]!] }
  expect(cardsOf(off, { ...options, stale })[0]).toMatchObject({ glyph: '◌', disabled: true, line: 'disabled · passes input through' })
  expect(cardsOf(off, { ...options, stale })[1]).toMatchObject({ glyph: '↻' })
})

test('a failed or cancelled card keeps its look when out of date', async () => {
  const run: RunView = { ...finished, nodes: { a: { status: 'failed', error: 'Boom' }, b: { status: 'cancelled', error: 'Stopped' }, c: { status: 'skipped' } } }
  const [a, b, c] = cardsOf(g0, { ...options, run, stale: { a: 'never', b: 'never', c: 'never' } })
  expect(a).toMatchObject({ glyph: '✕', tone: 'failed', line: 'Boom' })
  expect(b).toMatchObject({ glyph: '⊘', tone: 'cancelled', line: 'Stopped' })
  expect(c).toMatchObject({ glyph: '↻', tone: 'stale' })
})

test('a reused agent shows the time its saved output was made', async () => {
  const at = new Date(2026, 9, 8, 7, 5).getTime()
  const run: RunView = { ...finished, nodes: { a: { status: 'done', output: 'Found 3.', reusedFrom: { runId: 'r1', at } }, b: { status: 'done', output: 'Wrote it.' } } }
  const [a, b] = cardsOf(g0, { ...options, run })
  expect(a).toMatchObject({ glyph: '✓', tone: 'done', line: 'reused · 07:05', lineTone: 'dim', reused: '07:05' })
  expect(b!.reused).toBeUndefined()
  expect(clockTime(at)).toBe('07:05')
  // Out of date wins over reused, and then it is not a reused card.
  const stale = cardsOf(g0, { ...options, run, stale: { a: 'task' } })[0]!
  expect(stale).toMatchObject({ glyph: '↻', tone: 'stale', line: 'stale · task changed' })
  expect(stale.reused).toBeUndefined()
})

test('a card with pauseBefore carries the mark; a paused agent shows ‖ and waits for you', async () => {
  const g: Graph = { ...g0, nodes: [{ ...g0.nodes[0]!, pauseBefore: true }, g0.nodes[1]!, g0.nodes[2]!] }
  expect(cardsOf(g, options).map(c => c.pauses)).toEqual([true, false, false])
  const run: RunView = { graphId: 'g', graphName: 'G', isRunning: true, nodes: { a: { status: 'done', output: 'x' }, b: { status: 'paused' }, c: { status: 'waiting' } } }
  const [, b] = cardsOf(g, { ...options, run })
  expect(b).toMatchObject({ glyph: '‖', tone: 'paused', line: 'paused · your turn', lineTone: 'dim' })
})

test('midOf for the left and up routes is the middle of the connecting segment', async () => {
  // Left: from the left edge of the right card (x 40) to the right edge of the left one (x 1 + 26 = 27).
  expect(midOf(nodeAt('a', 40, 1), nodeAt('b', 1, 1))).toEqual({ x: 33, y: 3 })
  expect(midOf(nodeAt('a', 40, 1), nodeAt('b', 1, 7))).toEqual({ x: 33, y: 6 })
  // Up: from above the lower card (y 9) to below the upper one (y 1 + 5 = 6).
  expect(midOf(gc('c'), gc('b'))).toEqual({ x: 53, y: 7 })
  expect(midOf(nodeAt('c', 40, 10), nodeAt('b', 20, 1))).toEqual({ x: 43, y: 7 })
  // And each lies on the arrow drawEdges draws.
  for (const [from, to] of [[nodeAt('a', 40, 1), nodeAt('b', 1, 7)], [nodeAt('c', 40, 10), nodeAt('b', 20, 1)]] as const) {
    const g = connect({ ...g0, nodes: [from, to, g0.nodes[2]!] }, from.id, to.id, 'handoff')
    const mid = midOf(from, to)
    expect(cellEdge(drawEdges(g, size), mid.x, mid.y)).toBe(g.edges[0]!.id)
  }
})

test('an arrow between cards that overlap vertically draws no cell inside either card', async () => {
  const inside = (n: AgentNode, c: { x: number; y: number }) => c.x >= n.x && c.x < n.x + 26 && c.y >= n.y && c.y < n.y + 5
  const a = nodeAt('a', 1, 10)
  const b = nodeAt('b', 20, 8)
  const g = connect({ ...g0, nodes: [a, b, g0.nodes[2]!] }, 'a', 'b', 'handoff')
  const cells = cellsOf(drawEdges(g, size), g.edges[0]!.id)
  // Only the stub above the lower card and the head below the upper one are outside both.
  expect(cells.map(c => c.ch)).toContain('▲')
  expect(cells.filter(c => inside(a, c) || inside(b, c))).toEqual([])
  // An arrow that stays clear of the cards is unchanged.
  const clear = connect(g0, 'b', 'c', 'handoff')
  expect(cellsOf(drawEdges(clear, size), clear.edges[0]!.id).some(c => c.ch === '▼')).toBe(true)
})

const manyEdges = (count: number, kind: 'handoff' | 'delegate' = 'handoff'): Graph => ({
  ...g0,
  edges: Array.from({ length: count }, (_, i) => ({ id: `x${i}`, from: i % 2 === 0 ? 'a' : 'b', to: i % 2 === 0 ? 'b' : 'a', kind })),
})

test('the glow drops its wide underlays before it drops out altogether', async () => {
  const many = manyEdges(170)
  const views = edgesOf(many, null, true)
  const glow = vectorGlowSvg(views, { edge: null, card: 'a' }, size)
  expect(glow).not.toBeNull()
  expect(glow!.length).toBeLessThanOrEqual(SVG_LIMIT)
  // The bright strokes stay, the underlays are gone.
  expect(pathsIn(glow!)).toHaveLength(170)
  expect(glow).not.toContain('stroke-opacity')
  expect(pathsIn(glow!).every(p => p.includes('stroke-width="3.5"'))).toBe(true)
  // A handful of focused arrows keep both.
  expect(pathsIn(vectorGlowSvg(views.slice(0, 5), { edge: null, card: 'a' }, size)!)).toHaveLength(10)
})

test('the glow underlay has round caps and joins', async () => {
  const g = connect(g0, 'a', 'b', 'handoff')
  const views = edgesOf(g, null, true)
  const paths = pathsIn(vectorGlowSvg(views, { edge: views[0]!.id, card: null }, size)!)
  const underlay = paths.find(p => p.includes('stroke-width="10"'))!
  expect(underlay).toContain('stroke-linecap="round"')
  expect(underlay).toContain('stroke-linejoin="round"')
})

test('a focused delegate arrow keeps its hollow tail circle in the glow; a handoff has none', async () => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'delegate')
  const views = edgesOf(g, null, true)
  const glow = vectorGlowSvg(views, { edge: null, card: 'b' }, size)!
  const delegate = pathsIn(glow).filter(p => p.includes('marker-start'))
  expect(delegate).toHaveLength(1)
  expect(delegate[0]).toContain('stroke-width="3.5"')
  const id = delegate[0]!.match(/marker-start="url\(#([^)]+)\)"/)![1]!
  const marker = glow.match(new RegExp(`<marker id="${id}"[^>]*>.*?</marker>`))?.[0] ?? ''
  expect(marker).toContain('<circle')
  expect(marker).toContain('stroke="#a9b8e0"')
  const handoffOnly = vectorGlowSvg(views, { edge: views[0]!.id, card: null }, size)!
  expect(handoffOnly).not.toContain('marker-start')
})

test('with arrows too many even for the base alone, the base is over the limit so the pane can fall back to characters', async () => {
  const one = connect(g0, 'a', 'b', 'handoff')
  expect(vectorBaseSvg(one, edgesOf(one, null, true), size).length).toBeLessThanOrEqual(SVG_LIMIT)
  const huge = manyEdges(700, 'delegate')
  expect(vectorBaseSvg(huge, edgesOf(huge, null, true), size).length).toBeGreaterThan(SVG_LIMIT)
  const edge400 = manyEdges(400)
  expect(vectorBaseSvg(edge400, edgesOf(edge400, null, true), size).length).toBeLessThanOrEqual(SVG_LIMIT)
})

// a -> b -> c with b disabled and never run: a run passes a's output straight to c.
const through = (): Graph => {
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'handoff')
  return { ...g, nodes: g.nodes.map(n => (n.id === 'b' ? { ...n, disabled: true } : n)) }
}
const runOf = (nodes: RunView['nodes']): RunView => ({ graphId: 'g', graphName: 'G', isRunning: true, nodes })

test('arrows through a disabled card follow the run that passes over it', async () => {
  const g = through()
  const flows = (run: RunView) => edgesOf(g, run).map(e => e.flow)
  expect(flows(runOf({ a: { status: 'done' }, c: { status: 'running' } }))).toEqual(['flowing', 'flowing'])
  expect(flows(runOf({ a: { status: 'done' }, c: { status: 'waiting' } }))).toEqual(['flowing', 'flowing'])
  expect(flows(runOf({ a: { status: 'done' }, c: { status: 'done' } }))).toEqual(['delivered', 'delivered'])
  expect(flows(runOf({ a: { status: 'running' }, c: { status: 'waiting' } }))).toEqual(['idle', 'idle'])
  expect(flows(runOf({ a: { status: 'failed' }, c: { status: 'skipped' } }))).toEqual(['dead', 'dead'])
  expect(flows(runOf({}))).toEqual(['idle', 'idle'])
  // Without a run, and without the graph, nothing changes.
  expect(edgesOf(g, null).map(e => e.flow)).toEqual(['idle', 'idle'])
  expect(flowOf(g.edges[0]!, runOf({ a: { status: 'done' }, c: { status: 'done' } }))).toBe('idle')
})

test('arrows through disabled cards: the recent mark follows the agent beyond, and a delegate to a disabled helper carries nothing', async () => {
  const chain = connect(connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'handoff'), 'a', 'c', 'delegate')
  const d: Graph = { ...chain, nodes: chain.nodes.map(n => (n.id === 'b' ? { ...n, disabled: true } : n)) }
  const run = runOf({ a: { status: 'done', startedAt: 1 }, c: { status: 'done', startedAt: 20 } })
  const views = edgesOf(d, run)
  expect(views.map(e => e.flow)).toEqual(['delivered', 'delivered', 'delivered'])
  // Both arrows lead to the agent that started last, so neither fades.
  expect(views.filter(e => e.kind === 'handoff').map(e => e.recent)).toEqual([true, true])
  const helper: Graph = { ...g0, nodes: g0.nodes.map(n => (n.id === 'c' ? { ...n, disabled: true } : n)), edges: [{ id: 'dl', from: 'a', to: 'c', kind: 'delegate' }] }
  expect(edgesOf(helper, runOf({ a: { status: 'running' } }))[0]!.flow).toBe('idle')
  // Two disabled cards in a row, with nothing enabled beyond them: nothing is passed on.
  const tail = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'handoff')
  const two: Graph = { ...tail, nodes: tail.nodes.map(n => (n.id === 'a' ? n : { ...n, disabled: true })) }
  expect(edgesOf(two, runOf({ a: { status: 'done' } })).map(e => e.flow)).toEqual(['idle', 'idle'])
})

test('a disabled card is drawn dimmed only while it has no run status', async () => {
  const g: Graph = { ...g0, nodes: [{ ...g0.nodes[0]!, disabled: true }, g0.nodes[1]!, g0.nodes[2]!] }
  expect(cardsOf(g, options).map(c => c.dimmed)).toEqual([true, false, false])
  expect(cardsOf(g, { ...options, run: runOf({ a: { status: 'running' } }) })[0]).toMatchObject({ disabled: true, dimmed: false })
  expect(cardsOf(g, { ...options, run: runOf({ b: { status: 'running' } }) })[0]).toMatchObject({ disabled: true, dimmed: true })
})

// ---- activity on cards ----

const call = (id: string, tool: string, summary: string, status: 'running' | 'ok' = 'running'): import('../types').ActivityItem => ({ id, tool, summary, status, startedAt: 1000 })

test('a running agent with a current call shows tool, summary and elapsed time, clipped to the card', async () => {
  const run = runOf({ a: { status: 'running', startedAt: 1000, current: 'npm test', activity: [call('c1', 'Bash', 'npm test')] } })
  const [a, b] = cardsOf(g0, { ...options, run, now: 4000 })
  expect(a).toMatchObject({ line: 'Bash · npm test · 0:03', lineTone: 'plain', live: 'Bash · npm test' })
  // An agent without a current call keeps the plain line the canvas counts up.
  expect(b!.live).toBeUndefined()
  const long = runOf({ a: { status: 'running', startedAt: 0, current: 'x'.repeat(60), activity: [call('c1', 'WebFetch', 'x'.repeat(60))] } })
  const clipped = cardsOf(g0, { ...options, run: long, now: 65_000 })[0]!
  expect([...clipped.line].length).toBeLessThanOrEqual(22)
  expect(clipped.line.endsWith(' · 1:05')).toBe(true)
  expect(clipped.line).toContain('…')
  // Clipped by code points: an astral letter is never cut in half.
  const astral = runOf({ a: { status: 'running', startedAt: 0, current: '😀'.repeat(30), activity: [call('c1', 'T', '😀'.repeat(30))] } })
  const text = cardsOf(g0, { ...options, run: astral, now: 1000 })[0]!.line
  expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  expect([...text].length).toBeLessThanOrEqual(22)
})

test('the live line names the innermost running call, also inside a delegate', async () => {
  const nested: import('../types').ActivityItem = {
    ...call('c1', 'Agent', 'Helper'), delegate: { name: 'Helper', items: [call('c2', 'Grep', 'TODO in src', 'ok'), call('c3', 'Read', 'a.ts')] },
  }
  const run = runOf({ a: { status: 'running', startedAt: 0, current: 'a.ts', activity: [nested] } })
  expect(cardsOf(g0, { ...options, run, now: 2000 })[0]!.line).toBe('Read · a.ts · 0:02')
})

test('a done agent shows its output again, not the live line', async () => {
  const run = runOf({ a: { status: 'done', output: 'Found 3', current: 'old', activity: [call('c1', 'Bash', 'x', 'ok')] } })
  expect(cardsOf(g0, { ...options, run, now: 5000 })[0]).toMatchObject({ line: 'Found 3', lineTone: 'dim' })
})

test('a delegate helper card says who called it, then how long it took', async () => {
  const g = connect(g0, 'a', 'c', 'delegate')
  const running = cardsOf(g, { ...options, run: runOf({ a: { status: 'running' }, c: { status: 'running', calledBy: 'a', startedAt: 1000 } }), now: 3000 })[2]!
  expect(running).toMatchObject({ line: 'called by Researcher', lineTone: 'active', glyph: '◐' })
  // Cut so the whole line fits the card: no "running" text, the orange tone says it.
  expect(running.line.length).toBeLessThanOrEqual(22)
  const long = cardsOf({ ...g, nodes: g.nodes.map(n => (n.id === 'a' ? { ...n, name: 'A very long agent name' } : n)) }, { ...options, run: runOf({ a: { status: 'running' }, c: { status: 'running', calledBy: 'a' } }) })[2]!
  expect([...long.line].length).toBe(22)
  expect(long.line.endsWith('…')).toBe(true)
  // The canvas must not count its own elapsed time over the line.
  expect(running.startedAt).toBeUndefined()
  const done = cardsOf(g, { ...options, run: runOf({ a: { status: 'running' }, c: { status: 'done', calledBy: 'a', startedAt: 1000, endedAt: 5000 } }) })[2]!
  expect(done).toMatchObject({ line: 'done · 0:04', lineTone: 'dim', glyph: '●' })
  const failed = cardsOf(g, { ...options, run: runOf({ a: { status: 'running' }, c: { status: 'failed', calledBy: 'a', startedAt: 1000, endedAt: 2000, error: 'thread ended' } }) })[2]!
  expect(failed).toMatchObject({ line: 'thread ended', lineTone: 'error' })
})

test('a delegate arrow flows while its helper is called and is delivered after', async () => {
  const g = connect(g0, 'a', 'c', 'delegate')
  const flow = (c: import('../types').NodeRunView | undefined) => edgesOf(g, runOf({ a: { status: 'running' }, ...(c === undefined ? {} : { c }) }))[0]!.flow
  // Before the call, with no helper entry: the arrow follows its caller as before.
  expect(flow(undefined)).toBe('flowing')
  expect(flow({ status: 'running', calledBy: 'a' })).toBe('flowing')
  expect(flow({ status: 'done', calledBy: 'a' })).toBe('delivered')
  expect(flow({ status: 'failed', calledBy: 'a' })).toBe('dead')
  expect(flow({ status: 'cancelled', calledBy: 'a' })).toBe('dead')
  // A call by another agent does not light this arrow.
  expect(flow({ status: 'running', calledBy: 'b' })).toBe('idle')
})

test('with two callers of one helper, each arrow follows its own caller whatever the helper entry says', async () => {
  const g = connect(connect(g0, 'a', 'c', 'delegate'), 'b', 'c', 'delegate')
  const delegateTo = (status: 'running' | 'ok' | 'failed'): import('../types').ActivityItem => ({
    id: `d-${status}`, tool: 'Agent', summary: 'Checker', status, startedAt: 1000, delegate: { nodeId: 'c', name: 'Checker', items: [] },
  })
  // A is calling Checker now; B called it earlier and was answered. The merged helper entry names either as its caller.
  for (const calledBy of ['a', 'b']) {
    const run = runOf({
      a: { status: 'running', activity: [delegateTo('running')] },
      b: { status: 'running', activity: [delegateTo('ok')] },
      c: { status: 'running', calledBy, startedAt: 1000 },
    })
    expect(edgesOf(g, run).map(e => [e.from, e.flow])).toEqual([['a', 'flowing'], ['b', 'delivered']])
    // And the other way round.
    const swapped = runOf({
      a: { status: 'running', activity: [delegateTo('ok')] },
      b: { status: 'running', activity: [delegateTo('running')] },
      c: { status: 'running', calledBy, startedAt: 1000 },
    })
    expect(edgesOf(g, swapped).map(e => [e.from, e.flow])).toEqual([['a', 'delivered'], ['b', 'flowing']])
  }
  // A failed call is dead; a caller that never called it is idle once the helper ran for someone else.
  const failed = runOf({ a: { status: 'running', activity: [delegateTo('failed')] }, b: { status: 'running' }, c: { status: 'failed', calledBy: 'a' } })
  expect(edgesOf(g, failed).map(e => e.flow)).toEqual(['dead', 'idle'])
})

// One letter per cell: O running, B calling a delegate, G done, R failed, d paused, a space for nothing.
const LETTER: Record<string, string> = { '#d97757': 'O', '#7c8db5': 'B', '#5aa469': 'G', '#d4453b': 'R' }
const bar = (cells: { ch: string; color?: string | undefined; dim: boolean }[]) =>
  cells.map(c => (c.ch === ' ' ? ' ' : c.color !== undefined ? LETTER[c.color] ?? '?' : c.dim ? 'd' : '?')).join('')
const NAMES = [{ id: 'a', name: 'Researcher' }, { id: 'b', name: 'Writer' }, { id: 'c', name: 'Checker' }, { id: 'd', name: 'Editor' }, { id: 'f', name: 'Final' }]
const scripted = (): RunView => ({ ...runOf({
  a: {
    status: 'done', startedAt: 1000, endedAt: 11000,
    activity: [{ id: 'x1', tool: 'Agent', summary: 'Checker', status: 'ok', startedAt: 4000, endedAt: 6000, delegate: { nodeId: 'c', name: 'Checker', items: [] } }],
  },
  b: { status: 'failed', startedAt: 11000, endedAt: 16000 },
  c: { status: 'done', startedAt: 4000, endedAt: 6000, calledBy: 'a' },
  d: { status: 'waiting' },
  f: { status: 'done', startedAt: 16000, endedAt: 21000 },
}), isRunning: false })

test('timeline: one bar per agent with an entry, scaled from the first start to the last end, coloured by state at each cell', async () => {
  const rows = timelineOf(scripted(), NAMES, 20, 99_000)
  expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c', 'd', 'f'])
  expect(rows.map(r => r.name)).toEqual(['Researcher', 'Writer', 'Checker', 'Editor', 'Final'])
  expect(rows.every(r => r.cells.length === 20)).toBe(true)
  expect(timelineSpan(scripted(), 99_000)).toEqual({ from: 1000, to: 21000 })
  const [a, b, c, d, f] = rows.map(r => bar(r.cells))
  // 1 s per cell: a runs until 11 s, calling its delegate from 4 s to 6 s, then is done; nothing before a start.
  expect(a).toBe('OOOBBOOOOO' + 'G'.repeat(10))
  expect(b).toBe(' '.repeat(10) + 'OOOOO' + 'RRRRR')
  expect(c).toBe('   OO' + 'G'.repeat(15))
  expect(d).toBe(' '.repeat(20))
  // The last agent ends with the run: its last cell shows how it ended.
  expect(f).toBe(' '.repeat(15) + 'OOOOG')
  expect(rows[0]!.cells[0]).toEqual({ ch: '━', color: '#d97757', dim: false })
  expect(rows[3]!.cells[0]).toEqual({ ch: ' ', dim: false })
  // Half the cells: 2 s each; a cell holding an agent's start counts as running.
  const coarse = timelineOf(scripted(), NAMES, 10, 99_000).map(r => bar(r.cells))
  expect(coarse[0]).toBe('OOBOO' + 'GGGGG')
  expect(coarse[2]).toBe(' OOGGGGGGG')
})

test('timeline: a running view counts up to now; an agent waiting at its gate is dim from the last change', async () => {
  const live = { ...runOf({
    a: { status: 'running', startedAt: 1000 },
    b: { status: 'done', startedAt: 1000, endedAt: 5000 },
    p: { status: 'paused' },
  }), isRunning: true }
  const names = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'p', name: 'P' }, { id: 'z', name: 'Z' }]
  expect(timelineSpan(live, 9000)).toEqual({ from: 1000, to: 9000 })
  const rows = timelineOf(live, names, 8, 9000)
  // No entry for Z: no row.
  expect(rows.map(r => bar(r.cells))).toEqual(['OOOOOOOO', 'OOOOGGGG', '    dddd'])
  expect(rows[2]!.cells[7]).toEqual({ ch: '━', dim: true })
  // The same view a moment later: the bar is stretched over the longer time.
  expect(bar(timelineOf(live, names, 8, 17_000)[0]!.cells)).toBe('OOOOOOOO')
  expect(bar(timelineOf(live, names, 4, 9000)[1]!.cells)).toBe('OOGG')
})

test('timeline: nothing started draws empty bars; a reused entry keeps its old times out of the scale', async () => {
  const waiting = { ...runOf({ a: { status: 'waiting' }, b: { status: 'waiting' } }), isRunning: true }
  expect(timelineSpan(waiting, 5000)).toBeUndefined()
  expect(timelineOf(waiting, NAMES, 6, 5000).map(r => bar(r.cells))).toEqual(['      ', '      '])
  const reused = { ...runOf({
    a: { status: 'done', startedAt: 10, endedAt: 99, reusedFrom: { runId: 'old', at: 5 } },
    b: { status: 'done', startedAt: 5000, endedAt: 9000 },
  }), isRunning: false }
  expect(timelineSpan(reused, 0)).toEqual({ from: 5000, to: 9000 })
  expect(timelineOf(reused, NAMES, 4, 0).map(r => bar(r.cells))).toEqual(['    ', 'OOOG'])
})

test('timeline: the agent that ends the run shows its end in the last cell, failed red and cancelled red, done green', async () => {
  const names = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  for (const [status, tip] of [['failed', 'R'], ['cancelled', 'R'], ['done', 'G']] as const) {
    const run = { ...runOf({ a: { status: 'done', startedAt: 0, endedAt: 4000 }, b: { status, startedAt: 2000, endedAt: 8000 } }), isRunning: false }
    expect(timelineOf(run, names, 8, 99_000).map(r => bar(r.cells))).toEqual(['OOOOGGGG', '  OOOOO' + tip])
  }
  // Ended inside the last slice, not exactly at the end (another agent ran on to 8 s).
  const inside = { ...runOf({ a: { status: 'failed', startedAt: 0, endedAt: 7500 }, b: { status: 'done', startedAt: 0, endedAt: 8000 } }), isRunning: false }
  expect(timelineOf(inside, names, 8, 0).map(r => bar(r.cells))).toEqual(['OOOOOOOR', 'OOOOOOOG'])
  // A live view: the running agent stays orange at the tip.
  const live = { ...runOf({ a: { status: 'running', startedAt: 0 }, b: { status: 'failed', startedAt: 0, endedAt: 3000 } }), isRunning: true }
  expect(timelineOf(live, names, 8, 8000).map(r => bar(r.cells))).toEqual(['OOOOOOOO', 'OOORRRRR'])
})

// ---- check cards and retry arrows ----

const checkNode = (id: string, name: string, x: number, y: number, command: string): AgentNode => ({
  ...node(id, name, x, y), instructionsFile: '', check: { command, timeoutMin: 10 },
})
// Implementer -> Check 1 -> Writer, and Check 1 sends work back to Implementer.
const loopG = (retries?: number): Graph => {
  const base: Graph = {
    ...g0, nodes: [node('a', 'Implementer', 1, 1), checkNode('k', 'Check 1', 40, 1, 'npm test'), node('w', 'Writer', 40, 10)], edges: [],
  }
  const g = connect(connect(connect(base, 'a', 'k', 'handoff'), 'k', 'w', 'handoff'), 'k', 'a', 'retry')
  return retries === undefined ? g : { ...g, edges: g.edges.map(e => (e.kind === 'retry' ? { ...e, retries } : e)) }
}

test('a retry arrow is drawn with dotted lines and ↺ <retries> at its start', async () => {
  const g = connect(connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'c', 'handoff'), 'c', 'a', 'retry')
  const id = g.edges[2]!.id
  const rows = drawEdges(g, size)
  const lines = rows.map(rowText)
  // Judge c (40, 10) leaves its left side on its button row 13 (the retry lane), runs left to column 34, up to row 4 and ends at a's right side.
  expect(lines[13]!.slice(34, 40)).toBe('┇┅┅↺ 3')
  expect(lines[4]![27]).toBe('◄')
  expect(lines.join('\n')).toContain('┅')
  // The text belongs to the arrow (it can be picked) but has no place on its path, so no flow dot replaces it.
  const tag = rows[13]!.find(s => s.t === '↺ 3')
  expect(tag).toMatchObject({ s: 'r', e: id })
  expect(tag!.i).toBeUndefined()
  expect(rows.flat().filter(s => s.s === 'r').every(s => s.e === id)).toBe(true)
  // The number is the arrow's own.
  const ten = drawEdges({ ...g, edges: g.edges.map(e => (e.kind === 'retry' ? { ...e, retries: 10 } : e)) }, size).map(rowText)
  expect(ten[13]!.slice(34, 40)).toBe('┇┅↺ 10')
})

test('the text of a retry arrow is clipped to the room its first leg has, and left out where it would run into a card', async () => {
  const at = (x: number, y: number, id = 'n') => node(id, id, x, y)
  // Left-going, same row, two cells between the cards: the room is the glyph (a space at the end is no text).
  expect(tagOf(at(30, 1), at(1, 1), 3)).toEqual({ x: 29, y: 4, t: '↺' })
  expect(tagOf(at(31, 1), at(1, 1), 3)).toEqual({ x: 28, y: 4, t: '↺ 3' })
  // Right-going: it starts at the card's right side.
  expect(tagOf(at(1, 1), at(40, 1), 3)).toEqual({ x: 27, y: 4, t: '↺ 3' })
  expect(tagOf(at(1, 1), at(29, 1), 3)).toEqual({ x: 27, y: 4, t: '↺' })
  // Below or above: beside the first cell of the line that leaves the card's edge.
  expect(tagOf(at(1, 1), at(1, 12), 3)).toEqual({ x: 18, y: 6, t: '↺ 3' })
  expect(tagOf(at(1, 12), at(1, 1), 3)).toEqual({ x: 18, y: 11, t: '↺ 3' })
  // No room at all (the first leg has no free cell before the corner).
  expect(tagOf(at(1, 1), at(29, 3), 3)).toBeUndefined()
  // In the character layer, a label that would overwrite a card stays out.
  const g = connect({ ...g0, nodes: [node('a', 'A', 1, 1), node('b', 'B', 1, 12), node('c', 'C', 16, 6)] }, 'a', 'b', 'retry')
  expect(drawEdges(g, size).map(rowText).join('\n')).not.toContain('↺')
})

test('a retry arrow flows while its target runs again in a later round, and is idle otherwise', async () => {
  const g = loopG()
  const retry = g.edges.find(e => e.kind === 'retry')!
  const view = (a: NodeRunView): RunView => ({ graphId: 'g', graphName: 'G', isRunning: true, nodes: { a, k: { status: 'waiting', round: 2 } } })
  expect(flowOf(retry, null, g)).toBe('idle')
  expect(flowOf(retry, view({ status: 'running', round: 2 }), g)).toBe('flowing')
  expect(flowOf(retry, view({ status: 'paused', round: 3 }), g)).toBe('flowing')
  expect(flowOf(retry, view({ status: 'running' }), g)).toBe('idle')
  expect(flowOf(retry, view({ status: 'running', round: 1 }), g)).toBe('idle')
  expect(flowOf(retry, view({ status: 'waiting', round: 2 }), g)).toBe('idle')
  expect(flowOf(retry, view({ status: 'done', round: 2 }), g)).toBe('idle')
  expect(edgesOf(g, view({ status: 'running', round: 2 })).find(e => e.kind === 'retry')!.flow).toBe('flowing')
  // The handoffs keep their own flow.
  expect(edgesOf(g, view({ status: 'running', round: 2 })).filter(e => e.kind === 'handoff').map(e => e.flow)).not.toContain('delivered')
})

test('vector mode: a retry arrow is orange and dotted 2 4 and carries its text; the layer of characters does not', async () => {
  const g = loopG(2)
  const vector = edgesOf(g, null, true)
  const retry = vector.find(e => e.kind === 'retry')!
  expect(retry.tag).toEqual({ x: 37, y: 4, t: '↺ 2' })
  expect(vector.filter(e => e.kind !== 'retry').every(e => e.tag === undefined)).toBe(true)
  expect(edgesOf(g, null).every(e => e.tag === undefined)).toBe(true)
  const path = vectorBaseSvg(g, [retry], size).match(/<path d="[^"]*"[^>]*\/>/)![0]
  expect(path).toContain('stroke="#d97757"')
  expect(path).toContain('stroke-dasharray="2 4"')
  expect(path).toContain('marker-end')
  // Focused, it keeps its dots and takes the same orange.
  const glow = vectorGlowSvg(vector, { edge: retry.id, card: null }, size)!
  expect(glow).toContain('stroke-dasharray="2 4"')
  expect(glow).toContain('#d97757')
})

test('a check card shows its command on its second line, dim when it has none', async () => {
  const empty = checkNode('k', 'Check 1', 1, 1, '')
  const set = checkNode('s', 'Check 2', 30, 1, 'npm test')
  const long = checkNode('l', 'Check 3', 60, 1, 'npm run lint -- --max-warnings 0 --cache')
  const many = checkNode('m', 'Check 4', 90, 1, 'echo one\necho two')
  const g: Graph = { ...g0, nodes: [empty, set, long, many] }
  const [a, b, c, d] = cardsOf(g, options)
  expect(a).toMatchObject({ line: '$ (no command)', lineTone: 'dim' })
  expect(b).toMatchObject({ line: '$ npm test', lineTone: 'plain' })
  expect(c!.line).toBe('$ npm run lint -- --m…')
  expect(Array.from(c!.line).length).toBe(22)
  expect(d!.line).toBe('$ echo one')
  // An agent keeps its summary.
  expect(cardsOf(g0, options)[0]!.line).toBe('inherit · 0 skills')
})

test('a check card reads passed when done, and its failure when it failed', async () => {
  const g: Graph = { ...g0, nodes: [checkNode('k', 'Check 1', 1, 1, 'npm test')] }
  const run = (v: NodeRunView): RunView => ({ graphId: 'g', graphName: 'G', isRunning: false, nodes: { k: v } })
  expect(cardsOf(g, { ...options, run: run({ status: 'done', output: '## Handoff from A\n\ntext\n\n## Check 1 passed' }) })[0]).toMatchObject({ line: 'passed', lineTone: 'dim' })
  expect(cardsOf(g, { ...options, run: run({ status: 'failed', error: '`npm test` exited 1.' }) })[0]).toMatchObject({ line: '`npm test` exited 1.', lineTone: 'error' })
})

test('a loop card from round 2 on says round <r>/<retries + 1> after its status, within the 22 cells', async () => {
  const g = loopG()
  const run = (a: NodeRunView, k: NodeRunView = { status: 'waiting', round: 2 }): RunView => ({ graphId: 'g', graphName: 'G', isRunning: true, nodes: { a, k, w: { status: 'waiting' } } })
  const [a, k, w] = cardsOf(g, { ...options, run: run({ status: 'waiting', round: 2 }) })
  expect(a).toMatchObject({ line: 'waiting · round 2/4', round: 'round 2/4' })
  expect(k).toMatchObject({ line: 'waiting · round 2/4' })
  // A card outside the loop has no round.
  expect(w!.line).toBe('waiting')
  expect(w!.round).toBeUndefined()
  // The number of retries is the arrow's.
  expect(cardsOf(loopG(2), { ...options, run: run({ status: 'waiting', round: 3 }) })[0]!.line).toBe('waiting · round 3/3')
  expect(cardsOf(loopG(10), { ...options, run: run({ status: 'waiting', round: 11 }) })[0]!.line).toBe('waiting · round 11/11')
  // Round 1 (or none) says nothing.
  for (const round of [undefined, 1]) {
    const first = cardsOf(g, { ...options, run: run({ status: 'running', startedAt: 0, current: 'Read a.ts', ...(round !== undefined ? { round } : {}) }) })[0]!
    expect(first.line).toBe('Read a.ts · 0:00')
    expect(first.round).toBeUndefined()
  }
  // Without a retry arrow there is no loop to count in.
  expect(cardsOf({ ...g, edges: g.edges.filter(e => e.kind !== 'retry') }, { ...options, run: run({ status: 'waiting', round: 2 }) })[0]!.line).toBe('waiting')
  // Every status keeps within the card; the status gives way, the round stays whole.
  const fits = (v: NodeRunView) => cardsOf(g, { ...options, now: 5000, run: run(v) })[0]!
  const done = fits({ status: 'done', output: 'A very long first line of output that does not fit', round: 3 })
  expect(done.line).toBe('A very lo… · round 3/4')
  const failed = fits({ status: 'failed', error: 'Still failing after 3 retries: x', round: 4 })
  expect(failed.line).toBe('Still fai… · round 4/4')
  const running = fits({ status: 'running', startedAt: 0, current: 'Edit src/index.ts', round: 2 })
  expect(running.line).toBe('Ed… · 0:05 · round 2/4')
  expect(running.live).toBe('Ed…')
  const quiet = fits({ status: 'running', startedAt: 0, round: 2 })
  expect(quiet.line).toBe('round 2/4')
  expect(fits({ status: 'paused', round: 2 }).line).toBe('paused · … · round 2/4')
  for (const v of [{ status: 'waiting' }, { status: 'skipped' }, { status: 'cancelled', error: 'Stopped by you at the third try' }] as const) {
    expect(Array.from(fits({ ...v, round: 10 }).line).length).toBeLessThanOrEqual(22)
  }
})

test('From here on a loop card other than the target starts from the target', async () => {
  const g = loopG()
  const [a, k, w] = cardsOf(g, options)
  expect(a!.runFrom).toBeUndefined()
  expect(k).toMatchObject({ runFrom: 'Implementer', canRunFrom: true })
  expect(w!.runFrom).toBeUndefined()
  // It is judged on the part from the target on: a problem there takes it away from every card of the loop, one before the target does not.
  const broken = { ...g, nodes: g.nodes.map(n => (n.id === 'w' ? { ...n, name: '' } : n)) }
  expect(cardsOf(broken, options).map(c => c.canRunFrom)).toEqual([false, false, false])
  const upstream: Graph = connect({ ...g, nodes: [...g.nodes, node('u', '', 20, 20)] }, 'u', 'a', 'handoff')
  expect(cardsOf(upstream, options).map(c => [c.id, c.canRunFrom])).toEqual([['a', true], ['k', true], ['w', true], ['u', false]])
})

// The cells each arrow paints in the character layer (its text included), by edge id.
function cellsByEdge(g: Graph): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()
  drawEdges(g, { cols: 70, rows: 20 }).forEach((row, y) => {
    let x = 0
    for (const seg of row) {
      if (seg.e !== undefined) for (let k = 0; k < seg.t.length; k++) found.set(seg.e, (found.get(seg.e) ?? new Set<string>()).add(`${x + k},${y}`))
      x += seg.t.length
    }
  })
  return found
}

test('a retry arrow has its own lane: beside the handoff between the same two cards, in both default layouts', async () => {
  const loopAt = (k: [number, number]): Graph => {
    const base: Graph = { ...g0, nodes: [node('a', 'Implementer', 2, 1), checkNode('k', 'Check 1', k[0], k[1], 'npm test')], edges: [] }
    return connect(connect(base, 'a', 'k', 'handoff'), 'k', 'a', 'retry')
  }
  // Side by side, as + Agent then + Check place them (the first two cells of freeSpot).
  const side = loopAt([34, 1])
  const [h, r] = side.edges
  const sideCells = cellsByEdge(side)
  expect([...sideCells.get(h!.id)!].filter(c => sideCells.get(r!.id)!.has(c))).toEqual([])
  const sideRows = drawEdges(side, { cols: 70, rows: 20 }).map(rowText)
  expect(sideRows[3]!.slice(28, 34)).toBe('━━━━━►')
  expect(sideRows[4]!.slice(28, 34)).toBe('◄┅┅↺ 3')
  // Stacked in one column, as a third card is placed.
  const stack = loopAt([2, 8])
  const [h2, r2] = stack.edges
  const stackCells = cellsByEdge(stack)
  expect([...stackCells.get(h2!.id)!].filter(c => stackCells.get(r2!.id)!.has(c))).toEqual([])
  const stackRows = drawEdges(stack, { cols: 70, rows: 20 }).map(rowText)
  expect(stackRows[7]![15]).toBe('▼')
  expect(stackRows[6]![18]).toBe('▲')
  expect(stackRows[7]![18]).toBe('┇')
  expect(stackRows[7]!.slice(19, 22)).toBe('↺ 3')
  // The popup point and the vector curve keep to the lane too.
  const [handoffView, retryView] = edgesOf(side, null)
  expect(retryView!.mid).not.toEqual(handoffView!.mid)
  const [ha, , , hb] = curveOf(side.nodes[0]!, side.nodes[1]!, 'handoff')
  const [ra, , , rb] = curveOf(side.nodes[1]!, side.nodes[0]!, 'retry')
  expect([ra.y - ha.y, rb.y - hb.y]).toEqual([1, 1])
  const [va, , , vb] = curveOf(stack.nodes[0]!, stack.nodes[1]!, 'handoff')
  const [wa, , , wb] = curveOf(stack.nodes[1]!, stack.nodes[0]!, 'retry')
  expect([wa.x - va.x, wb.x - vb.x]).toEqual([3, 3])
})

test('a check card is marked for the canvas, an agent is not', async () => {
  const g: Graph = { ...g0, nodes: [node('a', 'Implementer', 1, 1), checkNode('k', 'Check 1', 40, 1, 'npm test')] }
  expect(cardsOf(g, options).map(c => c.isCheck)).toEqual([undefined, true])
})
