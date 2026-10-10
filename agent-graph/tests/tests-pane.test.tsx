import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import type { AgentNode, Graph, RunIndex, RunSummary, TestCase } from '../types'

const node = (id: string, name: string, x: number): AgentNode => ({
  id, name, x, y: 1, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
// Alpha -> Bravo on Cloud (the mocks can answer its REST calls, which they cannot do for a local agent).
const pair = (id: string): Graph => ({
  id, name: 'Flow', description: '', backend: 'cloud', layout: 2,
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
type Pane = Awaited<ReturnType<typeof openPane>>

let clock: MockClock
let files = new Map<string, string>()
// A path may arrive as given or resolved against the working folder: the mod's own files are keyed from `.claude/agent-graph/` on.
const norm = (path: string) => {
  const plain = path.replace(/[\\]/g, '/').replace(/^[A-Za-z]:/, '')
  const at = plain.indexOf('/.claude/agent-graph/')
  return at >= 0 ? `.${plain.slice(at)}` : plain
}
const testsPath = (graphId: string) => `./.claude/agent-graph/${graphId}/tests.json`
const toasts: string[] = []
const opened: string[][] = []
let ends = 0

type Session = { id: string; name: string; prompt: string; isInterrupted: boolean }
let sessions: Session[] = []
let holding = new Set<string>()
let agentsMade = 0
let kv = new Map<string, unknown>()
// What the grader answers, and a gate it waits at (to look at the pane while a test is being graded).
let verdictReply = '{"pass": true, "reason": "Same."}'
let gradeGate: Promise<void> | undefined
let graded = 0

const json = (body: unknown, status = 200) => ({ status, ok: status < 300, headers: {}, text: JSON.stringify(body) })

function cloud(url: string, method: string, body: string | undefined) {
  const path = url.replace('https://api.anthropic.com', '')
  const parsed = body === undefined ? {} : JSON.parse(body)
  if (method === 'POST' && path === '/v1/environments') return json({ id: 'env1' })
  if (method === 'POST' && path.startsWith('/v1/agents')) return json({ id: `agent${++agentsMade}`, version: 1 })
  if (method === 'POST' && path === '/v1/sessions') {
    const session = {
      id: `s${sessions.length + 1}`,
      name: String(parsed.title).split(' / ')[1]!,
      prompt: String(parsed.initial_events[0].content[0].text),
      isInterrupted: false,
    }
    sessions.push(session)
    return json({ id: session.id })
  }
  const events = path.match(/^\/v1\/sessions\/(\w+)\/events/)
  if (events !== null) {
    const session = sessions.find(s => s.id === events[1])!
    if (method === 'POST') {
      session.isInterrupted = true
      return json({})
    }
    if (session.isInterrupted) return json({ data: [{ id: '9', type: 'session.status_idle', stop_reason: { type: 'interrupted' } }] })
    if (holding.has(session.name)) return json({ data: [] })
    return json({ data: [
      { id: '1', type: 'agent.message', content: [{ type: 'text', text: `${session.name.toUpperCase()}-OUT` }] },
      { id: '2', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ] })
  }
  if (path.startsWith('/v1/files')) return json({ data: [] })
  return json({ error: { type: 'not_found', message: path } }, 404)
}

// A test as the file keeps it.
const made = (id: string, task: string, patch: Partial<TestCase> = {}): TestCase => ({
  id, name: task.split('\n')[0]!, task, expected: 'ACCEPTED', mustHold: '', createdAt: 1, fromRun: 'r0', ...patch,
})
const at = (hour: number, minute: number) => new Date(2026, 9, 8, hour, minute).getTime()
const full = (id: string, costUsd: number, mode: RunSummary['mode'] = 'full'): RunSummary => ({ id, at: 1, ending: 'finished', mode, taskLine: 'Old', costUsd })

async function openPane($: Args[0], on: Args[1], g: Graph, seed: { tests?: TestCase[]; runs?: RunSummary[] } = {}) {
  kv = new Map<string, unknown>([['graphs', [{ id: g.id, name: g.name }]], [`graph:${g.id}`, g]])
  if (seed.runs !== undefined) kv.set(`runs:${g.id}`, { runs: seed.runs, latest: {} } satisfies RunIndex)
  on('store.get', (_$, e) => ({ value: kv.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    kv.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => ({ value: kv.delete((e as unknown as { key: string }).key) }) as never)
  clock = mock.clock(on, { now: 1_000_000 })
  files = new Map(g.nodes.map(n => [n.instructionsFile, `Instructions of ${n.name}.`] as const))
  if (seed.tests !== undefined) files.set(testsPath(g.id), JSON.stringify(seed.tests))
  toasts.length = 0
  opened.length = 0
  ends = 0
  sessions = []
  holding = new Set()
  agentsMade = 0
  verdictReply = '{"pass": true, "reason": "Same."}'
  gradeGate = undefined
  graded = 0
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as unknown as { text: string }).text))
    if (/finished|was stopped|could not start|^Tests:/.test(toasts[toasts.length - 1]!)) ends++
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
  on('process.run', (_$, e) => {
    opened.push((e as unknown as { argv: string[] }).argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('model.complete', async () => {
    graded++
    await gradeGate
    return { value: { isAnswered: true, text: verdictReply, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  })
  on('tool.register', () => ({ value: undefined }) as never)
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'api-key' } }) as never)
  on('http.fetch', (_$, e) => {
    const { url, init } = e as unknown as { url: string; init?: { method?: string; body?: string } }
    return { value: cloud(url, init?.method ?? 'GET', init?.body) } as never
  })
  on('env.get', () => ({ value: undefined }) as never)
  on('ui.message', () => ({ value: undefined }) as never)
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

// Moves the clock until `done` holds.
async function until(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300 && !(await done()); i++) {
    await clock.advance(2000)
    await tick()
  }
  expect(await done()).toBe(true)
}

const testsOf = (graphId: string) => JSON.parse(files.get(testsPath(graphId)) ?? '[]') as TestCase[]
const text = async (pane: Pane, match: string | RegExp) => (await pane.find({ type: 'Text', text: match })) !== undefined
const button = async (pane: Pane, key: string) => (await pane.find({ type: 'Button', key })) !== undefined

async function run(pane: Pane, task = 'Write it') {
  const before = ends
  await pane.input({ key: 'task', text: task, kind: 'change' })
  await pane.press({ key: 'run' })
  await untilEnded(before)
}

test('Save as test shows for a run with a result, and adds a row that is not run', async ($, on) => {
  const g = pair('p-save')
  const pane = await openPane($, on, g)
  expect(await button(pane, 'save-test')).toBe(false)
  await run(pane, 'Write a haiku')
  expect((await pane.find({ type: 'Button', key: 'save-test' }))?.props.label).toBe('Save as test')
  expect(await text(pane, /^Tests$/)).toBe(false)
  await pane.press({ key: 'save-test' })
  expect(toasts).toContain('Saved test "Write a haiku".')
  expect(await text(pane, /^Tests$/)).toBe(true)
  expect(await text(pane, 'Write a haiku · not run')).toBe(true)
  const [saved] = testsOf(g.id)
  expect(saved).toMatchObject({ task: 'Write a haiku', mustHold: '' })
  // Not run yet: no Compare, no Accept latest.
  for (const key of ['test-run-', 'test-hold-', 'test-del-']) expect(await button(pane, `${key}${saved!.id}`)).toBe(true)
  for (const key of ['test-compare-', 'test-accept-']) expect(await button(pane, `${key}${saved!.id}`)).toBe(false)
  await pane.unmount()
})

test('a past run can be saved as a test too', async ($, on) => {
  const pane = await openPane($, on, pair('p-past'))
  await run(pane, 'First')
  await run(pane, 'Second')
  const [, older] = (kv.get('runs:p-past') as RunIndex).runs
  await pane.press({ key: `run-${older!.id}` })
  await pane.press({ key: 'save-test' })
  expect(testsOf('p-past').map(t => t.task)).toEqual(['First'])
  await pane.unmount()
})

test('running a test shows its grade: ✓ pass, the reason and the time; history reads test: <name>', async ($, on) => {
  const g = pair('p-grade')
  const pane = await openPane($, on, g, { tests: [made('t1', 'Write a haiku')] })
  expect(await text(pane, 'Write a haiku · not run')).toBe(true)
  const before = ends
  await pane.press({ key: 'test-run-t1' })
  await untilEnded(before)
  await until(async () => await text(pane, /^Write a haiku · ✓ pass · Same\. · \d\d:\d\d$/))
  expect(toasts).toContain('Tests: 1 passed, 0 failed')
  // Compare and Accept appear with the result.
  expect(await button(pane, 'test-compare-t1')).toBe(true)
  expect(await button(pane, 'test-accept-t1')).toBe(true)
  await until(async () => (await pane.find({ type: 'Button', text: /test: Write a haiku · "Write a haiku"$/ })) !== undefined)
  await pane.unmount()
})

test('the verdict texts: fail, could not grade, and a long reason is clipped to the row', async ($, on) => {
  const long = 'x'.repeat(300)
  const last = (verdict: 'pass' | 'fail' | 'ungraded', reason: string) => ({ verdict, reason, runId: 'r1', at: at(14, 5), result: 'R' })
  const pane = await openPane($, on, pair('p-verdicts'), {
    tests: [
      made('t1', 'Failing', { last: last('fail', 'Lost the point.') }),
      made('t2', 'Odd', { last: last('ungraded', "Couldn't grade: the reply was not a verdict.") }),
      made('t3', 'Wordy', { last: last('pass', long) }),
    ],
  })
  expect(await text(pane, 'Failing · ✗ fail · Lost the point. · 14:05')).toBe(true)
  expect(await text(pane, "Odd · ? couldn't grade · Couldn't grade: the reply was not a verdict. · 14:05")).toBe(true)
  const row = await pane.find({ type: 'Text', text: /^Wordy · ✓ pass · x+…? · 14:05$/ })
  expect(row).toBeDefined()
  expect(String(row!.props.children ?? '').length).toBeLessThanOrEqual(120)
  await pane.unmount()
})

test('a reason over several lines reads as one line; an empty reason leaves nothing after the verdict', async ($, on) => {
  const last = (reason: string) => ({ verdict: 'fail' as const, reason, runId: 'r1', at: at(14, 5), result: 'R' })
  const pane = await openPane($, on, pair('p-reasons'), {
    tests: [made('t1', 'Lines', { last: last('  Lost\nthe\r\n\tpoint.\n') }), made('t2', 'Blank', { last: last(' \n ') })],
  })
  expect(await text(pane, 'Lines · ✗ fail · Lost the point. · 14:05')).toBe(true)
  expect(await text(pane, 'Blank · ✗ fail · 14:05')).toBe(true)
  await pane.unmount()
})

test('each test row is keyed by its test, and a long reason is clipped by characters, not code units', async ($, on) => {
  const last = (reason: string) => ({ verdict: 'pass' as const, reason, runId: 'r1', at: at(14, 5), result: 'R' })
  const pane = await openPane($, on, pair('p-keys'), {
    tests: [made('t1', 'One', { last: last('\u{1D538}'.repeat(300)) }), made('t2', 'Two')],
  })
  expect(await pane.find({ key: 'test-t1' })).toBeDefined()
  expect(await pane.find({ key: 'test-t2' })).toBeDefined()
  // An odd number of code units would leave half a pair at the cut.
  const row = await pane.find({ type: 'Text', text: /^One · ✓ pass · (\u{1D538})+…? · 14:05$/u })
  expect(row).toBeDefined()
  await pane.unmount()
})

test('Run all tests (n) with the cost of the newest full run, to two decimals', async ($, on) => {
  const tests = [made('t1', 'One'), made('t2', 'Two')]
  const pane = await openPane($, on, pair('p-cost'), { tests, runs: [full('r3', 0, 'full'), full('r2', 0.5, 'test'), full('r1', 0.84), full('r0', 9)] })
  expect((await pane.find({ type: 'Button', key: 'run-tests' }))?.props.label).toBe('Run all tests (2) · about $1.68')
  await pane.unmount()
})

test('the estimate carries the ≈ when the full run it is based on was estimated', async ($, on) => {
  const tests = [made('t1', 'One'), made('t2', 'Two')]
  const pane = await openPane($, on, pair('p-est'), { tests, runs: [{ ...full('r1', 0.84), costEstimated: true }] })
  expect((await pane.find({ type: 'Button', key: 'run-tests' }))?.props.label).toBe('Run all tests (2) · about ≈$1.68')
  await pane.unmount()
})

test('without a known full-run cost the estimate is left out', async ($, on) => {
  const pane = await openPane($, on, pair('p-nocost'), { tests: [made('t1', 'One')], runs: [full('r1', 0), full('r0', 0.3, 'from-here')] })
  expect((await pane.find({ type: 'Button', key: 'run-tests' }))?.props.label).toBe('Run all tests (1)')
  await pane.unmount()
})

test('Must hold ✎ opens an input for that test; Save keeps the notes', async ($, on) => {
  const g = pair('p-hold')
  const pane = await openPane($, on, g, { tests: [made('t1', 'One', { mustHold: 'Old note' }), made('t2', 'Two')] })
  expect((await pane.find({ type: 'Button', key: 'test-hold-t1' }))?.props.label).toBe('Must hold ✎')
  expect(await pane.find({ key: 'test-hold-input' })).toBeUndefined()
  await pane.press({ key: 'test-hold-t1' })
  const input = await pane.find({ type: 'Input', key: 'test-hold-input' })
  expect(input?.props).toMatchObject({ value: 'Old note', submitLabel: 'Save' })
  expect(await pane.findAll({ key: 'test-hold-input' })).toHaveLength(1)
  await pane.input({ key: 'test-hold-input', text: '  Mentions Bravo  ', kind: 'submit' })
  expect(testsOf(g.id).map(t => t.mustHold)).toEqual(['Mentions Bravo', ''])
  expect(await pane.find({ key: 'test-hold-input' })).toBeUndefined()
  await pane.unmount()
})

test('deleting a test takes two presses', async ($, on) => {
  const g = pair('p-del')
  const pane = await openPane($, on, g, { tests: [made('t1', 'One'), made('t2', 'Two')] })
  expect((await pane.find({ type: 'Button', key: 'test-del-t1' }))?.props.label).toBe('✕')
  await pane.press({ key: 'test-del-t1' })
  expect((await pane.find({ type: 'Button', key: 'test-del-t1' }))?.props.label).toBe('✕ sure?')
  expect((await pane.find({ type: 'Button', key: 'test-del-t2' }))?.props.label).toBe('✕')
  expect(testsOf(g.id)).toHaveLength(2)
  await pane.press({ key: 'test-del-t1' })
  expect(testsOf(g.id).map(t => t.id)).toEqual(['t2'])
  expect(await text(pane, /^One/)).toBe(false)
  expect(await text(pane, 'Two · not run')).toBe(true)
  await pane.unmount()
})

test('Compare and Accept latest show only with a last result; Accept latest not for an empty one', async ($, on) => {
  const g = pair('p-compare')
  const last = (result: string) => ({ verdict: 'fail' as const, reason: 'Different.', runId: 'r1', at: at(9, 30), result })
  const pane = await openPane($, on, g, {
    tests: [made('t1', 'None'), made('t2', 'Some', { last: last('NEW RESULT') }), made('t3', 'Empty', { last: { ...last(''), verdict: 'ungraded' } })],
  })
  const has = async (key: string) => button(pane, key)
  expect([await has('test-compare-t1'), await has('test-accept-t1')]).toEqual([false, false])
  expect([await has('test-compare-t2'), await has('test-accept-t2')]).toEqual([true, true])
  expect([await has('test-compare-t3'), await has('test-accept-t3')]).toEqual([true, false])
  expect((await pane.find({ type: 'Button', key: 'test-compare-t2' }))?.props.label).toBe('Compare ↗')
  expect((await pane.find({ type: 'Button', key: 'test-accept-t2' }))?.props.label).toBe('Accept latest')

  await pane.press({ key: 'test-compare-t2' })
  expect(files.get(`./.claude/agent-graph/${g.id}/tests/t2-compare.md`)).toMatch(/## Latest · fail · Different\. · 09:30\n+NEW RESULT/)
  expect(opened).toHaveLength(1)

  await pane.press({ key: 'test-accept-t2' })
  expect(testsOf(g.id)[1]).toMatchObject({ expected: 'NEW RESULT', last: { verdict: 'pass', reason: 'Accepted by you.' } })
  expect(await text(pane, /^Some · ✓ pass · Accepted by you\. · 09:30$/)).toBe(true)
  await pane.unmount()
})

test('while a test batch goes: Stop, no Run or Step, and every test and run button is plain text', async ($, on) => {
  const g = pair('p-batch')
  const pane = await openPane($, on, g, { tests: [made('t1', 'One', { last: { verdict: 'pass', reason: 'ok', runId: 'r1', at: at(8, 0), result: 'R' } }), made('t2', 'Two')], runs: [full('r1', 0.4)] })
  expect([await button(pane, 'run'), await button(pane, 'step'), await button(pane, 'stop')]).toEqual([true, true, false])
  holding.add('Alpha')
  await pane.press({ key: 'run-tests' })
  await until(() => sessions.length > 0)

  // A test's graph run is going.
  const plain = async () => {
    expect([await button(pane, 'run'), await button(pane, 'step'), await button(pane, 'stop')]).toEqual([false, false, true])
    for (const key of ['run-tests', 'test-run-t1', 'test-hold-t1', 'test-compare-t1', 'test-accept-t1', 'test-del-t1', 'test-run-t2', 'save-test', 'run-r1']) expect(await button(pane, key)).toBe(false)
    // The rows and the labels stay as text.
    expect(await text(pane, /^One · ✓ pass · ok/)).toBe(true)
    expect(await text(pane, /Run all tests \(2\)/)).toBe(true)
  }
  await plain()

  // Between two runs, while the first test is graded: no run is going, the batch still is.
  holding.clear()
  let release = () => {}
  gradeGate = new Promise<void>(resolve => void (release = resolve))
  await until(() => graded > 0)
  await plain()

  // Stop ends the batch; the buttons come back.
  await pane.press({ key: 'stop' })
  release()
  await until(async () => await button(pane, 'run'))
  expect(await button(pane, 'run-tests')).toBe(true)
  expect(await button(pane, 'test-run-t1')).toBe(true)
  expect(await button(pane, 'stop')).toBe(false)
  await pane.unmount()
})

test('after the batch the Tests section is live again', async ($, on) => {
  const pane = await openPane($, on, pair('p-after'), { tests: [made('t1', 'One')] })
  const before = ends
  await pane.press({ key: 'run-tests' })
  await untilEnded(before)
  await until(async () => (await button(pane, 'run-tests')) && (await button(pane, 'run')))
  expect(await text(pane, /^One · ✓ pass · Same\./)).toBe(true)
  await pane.unmount()
})
