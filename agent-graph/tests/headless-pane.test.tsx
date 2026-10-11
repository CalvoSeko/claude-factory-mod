import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import type { AgentNode, Graph, RunRecord } from '../types'
import { CHILD_ENV } from '../hooks/headless'

const node = (id: string, name: string, x: number): AgentNode => ({
  id, name, x, y: 1, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
// Alpha -> Bravo on Headless.
const pair = (id: string): Graph => ({
  id, name: 'Flow', description: '', backend: 'headless', layout: 2,
  nodes: [node('a', 'Alpha', 2), node('b', 'Bravo', 40)],
  edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }],
})
const BAND = {
  plugin: 'agent-graph', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const
const PANE = {
  plugin: 'agent-graph', component: 'Pane', requestId: 'agent-graph',
  props: { title: 'Agent Graph', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

declare const setTimeout: (run: () => void, ms?: number) => unknown

type Args = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>

let clock: MockClock
let files = new Map<string, string>()
let kv = new Map<string, unknown>()
const norm = (path: string) => {
  const plain = path.replace(/[\\]/g, '/').replace(/^[A-Za-z]:/, '')
  const at = plain.indexOf('/.claude/agent-graph/')
  return at >= 0 ? `.${plain.slice(at)}` : plain
}
let ends = 0
const toasts: string[] = []

// What the pane's Headless cards ran: the command line and the text sent to each child's stdin.
type Child = { argv: string[]; input: string; env: Record<string, string> | undefined }
let children: Child[] = []
// A stream-json line for the child of the card whose `--agent` value contains `name`.
type Script = (child: Child) => string[]
let scripts = new Map<string, Script>()

const MODEL = 'claude-sonnet-5-5'
const usage = { input_tokens: 2, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 }
const assistant = (id: string, content: unknown[]) =>
  JSON.stringify({ type: 'assistant', message: { model: MODEL, id, role: 'assistant', content, usage }, parent_tool_use_id: null })
const toolResult = (id: string, content: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] }, parent_tool_use_id: null })
const result = (text: string, costUsd: number) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: text, total_cost_usd: costUsd })

async function openPane($: Args[0], on: Args[1], g: Graph) {
  kv = new Map<string, unknown>([['graphs', [{ id: g.id, name: g.name }]], [`graph:${g.id}`, g]])
  on('store.get', (_$, e) => ({ value: kv.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    kv.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => ({ value: kv.delete((e as unknown as { key: string }).key) }) as never)
  clock = mock.clock(on, { now: 1_000_000 })
  files = new Map(g.nodes.map(n => [n.instructionsFile, `Instructions of ${n.name}.`] as const))
  toasts.length = 0
  ends = 0
  children = []
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as unknown as { text: string }).text))
    if (/finished|was stopped|could not start/.test(toasts[toasts.length - 1]!)) ends++
    return { value: undefined } as never
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('fs.write', (_$, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    files.set(norm(path), text)
    return { value: undefined } as never
  })
  on('fs.exists', (_$, e) => ({ value: files.has(norm((e as unknown as { path: string }).path)) }) as never)
  on('fs.read', (_$, e) => ({ value: files.get(norm((e as unknown as { path: string }).path)) ?? '' }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'api-key' } }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('ui.message', () => ({ value: undefined }) as never)
  // The card's `claude -p` child: it prints the scripted stream-json lines of its card, then exits 0.
  on('process.spawn', async function* ($$: never, e: never) {
    const request = e as { argv: string[]; input?: string; env?: Record<string, string> }
    const child: Child = { argv: [...request.argv], input: request.input ?? '', env: request.env }
    children.push(child)
    const name = request.argv[request.argv.indexOf('--agent') + 1]!
    const script = [...scripts].find(([key]) => name.includes(key))![1]
    for (const line of script(child)) yield { stream: 'stdout' as const, text: `${line}\n` }
    return { value: { code: 0, signal: null } }
  } as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'agent-graph' })
  await band.unmount()
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))

async function untilEnded(before: number) {
  for (let i = 0; i < 300 && ends <= before; i++) {
    await clock.advance(2000)
    await tick()
  }
  expect(ends).toBeGreaterThan(before)
}

const recordsOf = (graphId: string): RunRecord[] =>
  [...files.keys()].filter(p => p.includes(`/${graphId}/runs/`) && p.endsWith('.json')).map(p => JSON.parse(files.get(p)!) as RunRecord)

test('a two-card Headless graph runs from the pane: both done with exact costs, the calls listed, and the second card gets the first one\'s answer', async ($, on) => {
  scripts = new Map<string, Script>([
    ['alpha', () => [
      assistant('m1', [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'npm test' } }]),
      toolResult('u1', 'all passed'),
      assistant('m2', [{ type: 'text', text: 'Tests pass.' }]),
      result('ALPHA-OUT', 0.25),
    ]],
    // Bravo echoes what it was sent, so the test can see that the first card's answer reached its stdin.
    ['bravo', child => [
      assistant('m3', [{ type: 'text', text: 'Reading the handoff.' }]),
      result(`BRAVO-OUT after ${child.input.includes('ALPHA-OUT') ? 'ALPHA-OUT' : 'nothing'}`, 0.5),
    ]],
  ])
  const g = pair('g-headless')
  const pane = await openPane($, on, g)
  const before = ends
  await pane.input({ key: 'task', text: 'Write it', kind: 'change' })
  await pane.press({ key: 'run' })
  await untilEnded(before)

  expect(toasts).toContain('Agent graph "Flow" finished')
  // Each card is its own `claude -p` process in auto mode, in order.
  expect(children).toHaveLength(2)
  for (const child of children) {
    expect(child.argv.slice(0, 9)).toEqual(['claude', '-p', '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--agents'])
    expect(child.argv).toContain('--max-budget-usd')
    expect(child.env).toEqual(CHILD_ENV)
  }
  const agents = children.map(c => c.argv[c.argv.indexOf('--agent') + 1]!)
  expect(agents[0]).toContain('alpha')
  expect(agents[1]).toContain('bravo')
  // The agents file of each card was written before it started.
  expect(files.has(norm(children[0]!.argv[children[0]!.argv.indexOf('--agents') + 1]!))).toBe(true)
  expect(children[0]!.input).toBe('Write it')
  expect(children[1]!.input).toContain('## Handoff from Alpha')
  expect(children[1]!.input).toContain('ALPHA-OUT')

  const [record, ...others] = recordsOf('g-headless')
  expect(others).toEqual([])
  expect(record).toMatchObject({ mode: 'full', ending: 'finished' })
  expect(record!.nodes['a']).toMatchObject({ status: 'done', output: 'ALPHA-OUT' })
  expect(record!.nodes['b']).toMatchObject({ status: 'done', output: 'BRAVO-OUT after ALPHA-OUT' })
  // Costs are exact (the child's own total), not estimates (the sum may differ from it in the last binary digit).
  expect(Math.abs(record!.nodes['a']!.costUsd! - 0.25)).toBeLessThan(1e-9)
  expect(Math.abs(record!.nodes['b']!.costUsd! - 0.5)).toBeLessThan(1e-9)
  expect(record!.nodes['a']!.costEstimated).toBeFalsy()
  expect(record!.nodes['b']!.costEstimated).toBeFalsy()
  expect(record!.result).toContain('BRAVO-OUT after ALPHA-OUT')
  // The first card's call is in its activity, with its result.
  expect(record!.nodes['a']!.activity).toMatchObject([{ tool: 'Bash', summary: 'npm test', status: 'ok', result: 'all passed' }])

  // The pane draws the cards with their exact cost (no ≈).
  const cards = JSON.parse(JSON.stringify((await pane.find({ key: 'canvas' }))?.props)).props.cards as Array<{ id: string; line: string }>
  expect(cards.map(c => c.line)).toEqual(['ALPHA-OUT', 'BRAVO-OUT after ALPHA-OUT'])
  expect(await pane.find({ type: 'Text', text: /≈/ })).toBeUndefined()
  await pane.unmount()
})
