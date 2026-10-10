import { expect, mock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import type { AgentNode, Graph } from '../types'
import { agentType } from '../hooks/compile'
import { createTracker } from '../hooks/activity'
import { createActivityRun, localKey, setActivityRun, trackSpawn, type ActivityRun } from '../hooks/actions'
import type { Usage } from '../hooks/cost'
import { connect } from '../hooks/model'
import { createGuard } from '../hooks/guard'
import { createCompletions, createLocalBackend } from '../hooks/local'
import { register } from '../hooks/register'
import { runGraph } from '../hooks/runner'

const node = (id: string, name: string, x = 2, budgetUsd = 2): AgentNode => ({
  id, name, x, y: 1, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd,
})
const solo = (id: string): Graph => ({ id, name: 'Solo', description: '', backend: 'local', layout: 2, nodes: [node('a', 'Scout')], edges: [] })
// Lead delegates to Helper.
const team: Graph = connect({ id: 'gt', name: 'Team', description: '', backend: 'local', nodes: [node('a', 'Lead'), node('h', 'Helper')], edges: [] }, 'a', 'h', 'delegate')
const helperType = agentType(team, team.nodes[1]!)

const BAND = {
  plugin: 'agent-graph', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const
const PANE = {
  plugin: 'agent-graph', component: 'Pane', requestId: 'agent-graph',
  props: { title: 'Agent Graph', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Args = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>

// 100 000 input and 20 000 output tokens of Sonnet 4.6: $0.30 + $0.30.
const usage = (over: Partial<Usage> = {}): Usage => ({
  model: 'claude-sonnet-4-6', input_tokens: 100_000, output_tokens: 20_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over,
})
type ServerUse = { id: string; name: string; input: unknown; startedAt: number; endedAt: number }
const stepResult = (over: { index?: number; usage?: Usage | null; serverToolUses?: ServerUse[] } = {}) => ({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(), ...over })

// What the engine's step answers beneath the mod's hook.
let beneath: Record<string, unknown> = stepResult()
const stepEvent = (agentId?: string) => ({ turnId: 't1', index: 0, model: 'claude-sonnet-4-6', messageCount: 1, ...(agentId !== undefined ? { agentId } : {}) })

async function drain<C, R>(stream: AsyncGenerator<C, R>): Promise<R> {
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  return next.value
}

// The engine loads the mod's hooks apart from this file's imports, so a run set here (setActivityRun) is invisible
// to the hooks it loaded. These tests take the turn.step hook from register, loaded here with this file's modules,
// and put it over the engine's answer.
function underEngine(on: Args[1]) {
  // The turn.step hook of register, taken out of a registration that keeps only that one.
  let stepHook: ((...args: unknown[]) => AsyncGenerator<unknown, unknown>) | undefined
  const only = ((name: string, ...rest: unknown[]) => {
    if (name === 'turn.step') stepHook = rest[rest.length - 1] as typeof stepHook
  }) as unknown as Args[1]
  register(only, {})
  // The hook runs over what the engine would answer beneath it.
  on('turn.step', async function* ($$: never, e: never) {
    return yield* stepHook!($$, e, (() => (async function* () { return { ...beneath, index: (e as { index: number }).index } })()) as never)
  } as never)
}

const cents = (usd: number) => Math.round(usd * 100)

// A run with `lead-1` watched by the meter, collecting what its callback is told.
function watched(): { run: ActivityRun; totals: number[] } {
  const tracker = createTracker(() => {}, () => 1)
  tracker.watch(localKey('lead-1'), 'a')
  const run = createActivityRun(team, tracker)
  const totals: number[] = []
  run.meter.watch('lead-1', usd => totals.push(usd))
  return { run, totals }
}

test('a step of an agent outside the run, or of none, only passes through', async ($, on) => {
  underEngine(on)
  const { run, totals } = watched()
  setActivityRun(run)
  try {
    beneath = stepResult()
    expect(await drain($.turn.step(stepEvent('stranger') as never))).toEqual(beneath)
    expect(await drain($.turn.step(stepEvent() as never))).toEqual(beneath)
  } finally {
    setActivityRun(undefined)
  }
  expect(totals).toEqual([])
  // With no run at all it is the same.
  expect(await drain($.turn.step(stepEvent('lead-1') as never))).toEqual(beneath)
  expect(totals).toEqual([])
})

test('a step of a metered agent adds its price, web searches included, and the result is unchanged', async ($, on) => {
  underEngine(on)
  const { run, totals } = watched()
  setActivityRun(run)
  try {
    beneath = stepResult()
    expect(await drain($.turn.step(stepEvent('lead-1') as never))).toEqual(beneath)
    const searches = [
      { id: 's1', name: 'web_search', input: {}, startedAt: 1, endedAt: 2 },
      { id: 's2', name: 'advisor', input: {}, startedAt: 1, endedAt: 2 },
      { id: 's3', name: 'web_search', input: {}, startedAt: 1, endedAt: 2 },
    ]
    beneath = stepResult({ index: 1, serverToolUses: searches })
    expect(await drain($.turn.step({ ...stepEvent('lead-1'), index: 1 } as never))).toEqual(beneath)
    // A step with no usage (no response arrived) adds nothing.
    beneath = stepResult({ index: 2, usage: null })
    await drain($.turn.step({ ...stepEvent('lead-1'), index: 2 } as never))
  } finally {
    setActivityRun(undefined)
  }
  expect(totals.map(cents)).toEqual([60, 122])
})

test('a meter that throws leaves the step with its result', async ($, on) => {
  underEngine(on)
  const { run } = watched()
  run.meter.watch('lead-1', () => {
    throw new Error('callback bug')
  })
  setActivityRun(run)
  try {
    beneath = stepResult()
    expect(await drain($.turn.step(stepEvent('lead-1') as never))).toEqual(beneath)
    const broken: ActivityRun = { ...run, meter: { ...run.meter, isMetered: () => { throw new Error('meter bug') } } }
    setActivityRun(broken)
    expect(await drain($.turn.step(stepEvent('lead-1') as never))).toEqual(beneath)
    // A usage the pricing cannot read does not fail it either.
    beneath = stepResult({ usage: { model: 5 } as never })
    expect(await drain($.turn.step(stepEvent('lead-1') as never))).toEqual(beneath)
  } finally {
    setActivityRun(undefined)
  }
})

test('the steps of a delegate count toward its caller, at any depth', async ($, on) => {
  underEngine(on)
  const { run, totals } = watched()
  // Lead starts Helper (agent.spawn of the run), which starts Deeper.
  expect(await trackSpawn(run, { parentAgentId: 'lead-1', subagentType: helperType }, async () => ({ agentId: 'helper-1' }))).toEqual({ agentId: 'helper-1' })
  await trackSpawn(run, { parentAgentId: 'helper-1', subagentType: 'general-purpose' }, async () => ({ agentId: 'deeper-1' }))
  setActivityRun(run)
  try {
    beneath = stepResult()
    for (const id of ['lead-1', 'helper-1', 'deeper-1']) await drain($.turn.step(stepEvent(id) as never))
  } finally {
    setActivityRun(undefined)
  }
  expect(totals.map(cents)).toEqual([60, 120, 180])
})

test('the cost link and the activity nesting do not depend on each other', async () => {
  // The tracker fails: the meter still links.
  const first = watched()
  const noTracker: ActivityRun = { ...first.run, tracker: { ...first.run.tracker, childOf: () => { throw new Error('tracker bug') } } }
  await trackSpawn(noTracker, { parentAgentId: 'lead-1', subagentType: helperType }, async () => ({ agentId: 'helper-1' }))
  expect(first.run.meter.isMetered('helper-1')).toBe(true)
  // The meter fails: the activity still nests.
  const second = watched()
  const noMeter: ActivityRun = { ...second.run, meter: { ...second.run.meter, childOf: () => { throw new Error('meter bug') } } }
  await trackSpawn(noMeter, { parentAgentId: 'lead-1', subagentType: helperType }, async () => ({ agentId: 'helper-1' }))
  expect(second.run.tracker.helpersOf('a')).toMatchObject([{ nodeId: 'h' }])
  // A parent that is metered but not tracked (or the other way round) is linked in the one it is in.
  const third = watched()
  third.run.meter.watch('solo-1', () => {})
  await trackSpawn(third.run, { parentAgentId: 'solo-1', subagentType: helperType }, async () => ({ agentId: 'kid-1' }))
  expect(third.run.meter.isMetered('kid-1')).toBe(true)
  expect(third.run.tracker.helpersOf('a')).toEqual([])
  // A spawn by an agent in neither does nothing, and one that was refused links nothing.
  await trackSpawn(third.run, { parentAgentId: 'stranger', subagentType: helperType }, async () => ({ agentId: 'x-1' }))
  await trackSpawn(third.run, { parentAgentId: 'lead-1', subagentType: helperType }, async () => ({ deny: 'no' }))
  expect(third.run.meter.isMetered('x-1')).toBe(false)
})

type NodeView = { status?: string; error?: string; costUsd?: number; costEstimated?: boolean }

// A one-agent Local run whose model requests arrive through the mod's turn.step hook. The engine ends a
// stopped agent's turn as aborted, which `stopAgent` here does the same.
async function localRun($: Args[0], budgetUsd: number) {
  const g: Graph = { ...solo('g-run'), nodes: [node('a', 'Scout', 2, budgetUsd)] }
  const run = createActivityRun(g, createTracker(() => {}, () => 1))
  setActivityRun(run)
  const completions = createCompletions()
  const stopped: string[] = []
  const views: NodeView[] = []
  let spawnedHere!: () => void
  const hasSpawned = new Promise<void>(resolve => (spawnedHere = resolve))
  const backend = createLocalBackend(g, {
    register: async () => undefined,
    spawn: async () => (spawnedHere(), { agentId: 'ag-1' }),
    stopAgent: async id => {
      stopped.push(id)
      completions.complete({ agentId: id, answer: '', reason: 'aborted' })
    },
    instructions: async () => 'Do it.',
    context: { kind: async () => 'missing', read: async () => '', files: async () => [] },
    completions,
    guard: createGuard(),
    tracker: () => run.tracker,
    meter: () => run.meter,
  })
  const controller = new AbortController()
  const result = runGraph(g, 'Go', backend, { onUpdate: view => void views.push(view.nodes['a']!), signal: controller.signal })
  await hasSpawned
  // The agent is watched once start has returned: a few ticks for the awaits in it.
  for (let i = 0; i < 20; i++) await Promise.resolve()
  return { result, stopped, views, completions, controller, step: (index: number) => drain($.turn.step({ ...stepEvent('ag-1'), index } as never)) }
}

test('an agent whose requests pass its budget is stopped once and fails with the budget text, its cost estimated', async ($, on) => {
  underEngine(on)
  beneath = stepResult()
  const { result, stopped, views, step } = await localRun($, 0.5)
  try {
    await step(0)
    // A request that lands after the stop neither stops it again nor adds to the cost.
    await step(1)
    const done = await result
    expect(stopped).toEqual(['ag-1'])
    expect('failures' in done && done.failures).toEqual({ a: 'Hit its $0.5 budget.' })
    expect(views[views.length - 1]).toMatchObject({ status: 'failed', error: 'Hit its $0.5 budget.', costEstimated: true })
    expect([...new Set(views.flatMap(v => (v.costUsd === undefined ? [] : [cents(v.costUsd)])))]).toEqual([60])
  } finally {
    setActivityRun(undefined)
  }
})

test('an agent under its budget finishes done, and a request after its end is not counted', async ($, on) => {
  underEngine(on)
  beneath = stepResult()
  const { result, stopped, views, completions, step } = await localRun($, 2)
  try {
    await step(0)
    completions.complete({ agentId: 'ag-1', answer: 'DONE', reason: 'answer' })
    const done = await result
    expect('outputs' in done && done.outputs).toEqual({ a: 'DONE' })
    expect(stopped).toEqual([])
    expect(views[views.length - 1]).toMatchObject({ status: 'done', costEstimated: true })
    // Its turn is over, so it is no longer watched: a straggler is ignored.
    const before = views.length
    await step(1)
    expect(views).toHaveLength(before)
  } finally {
    setActivityRun(undefined)
  }
})

test('a person stopping the run still ends the agent cancelled, with the cost so far', async ($, on) => {
  underEngine(on)
  beneath = stepResult()
  const { result, stopped, views, controller, step } = await localRun($, 2)
  try {
    await step(0)
    controller.abort()
    await result
    expect(stopped).toEqual(['ag-1'])
    expect(views[views.length - 1]).toMatchObject({ status: 'cancelled', error: 'Stopped.', costEstimated: true })
    expect(cents(views[views.length - 1]!.costUsd!)).toBe(60)
  } finally {
    setActivityRun(undefined)
  }
})

// ---- the pane, with a Local graph ----

let kv = new Map<string, unknown>()

async function openPane($: Args[0], on: Args[1], g: Graph) {
  kv = new Map<string, unknown>([['graphs', [{ id: g.id, name: g.name }]], [`graph:${g.id}`, g]])
  on('store.get', (_$, e) => ({ value: kv.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    kv.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => ({ value: kv.delete((e as unknown as { key: string }).key) }) as never)
  mock.clock(on, { now: 1_000_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.read', () => ({ value: 'Instructions.' }) as never)
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

test('the Budget input shows for a Local graph and saves what is entered', async ($, on) => {
  const pane = await openPane($, on, solo('g-input'))
  await pane.post({ events: [{ kind: 'down', x: 5, y: 2 }] })
  expect((await pane.find({ key: 'budget-a' }))?.props.value).toBe('2')
  await pane.input({ key: 'budget-a', text: '0.5', kind: 'submit' })
  expect((kv.get('graph:g-input') as Graph).nodes[0]!.budgetUsd).toBe(0.5)
  // Not a positive number: ignored.
  await pane.input({ key: 'budget-a', text: 'lots', kind: 'submit' })
  expect((kv.get('graph:g-input') as Graph).nodes[0]!.budgetUsd).toBe(0.5)
  await pane.unmount()
})
