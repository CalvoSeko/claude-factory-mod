import { expect } from 'claude-code/testing'
import { test } from './kit'

import { capText, createMeter, hasLiveAgent, isCap, rateOf, requestUsd, runSpend, type Usage } from '../hooks/cost'

// Dollars are floats: compare within a billionth of a dollar.
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(1e-9)

const rates = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({ input, cacheWrite, cacheRead, output })

const usage = (model: string, over: Partial<Usage> = {}): Usage => ({
  model,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...over,
})

test('each row of the price table prices its models', () => {
  const rows: [string, ReturnType<typeof rates>][] = [
    ['claude-fable-5-1', rates(10, 20, 0.25, 50)],
    ['claude-mythos-5-1', rates(10, 20, 0.25, 50)],
    ['claude-fable-5', rates(10, 20, 1, 50)],
    ['claude-mythos-5', rates(10, 20, 1, 50)],
    ['claude-opus-5-5', rates(4, 8, 0.2, 20)],
    ['claude-opus-5', rates(5, 10, 0.5, 25)],
    ['claude-opus-4-8', rates(5, 10, 0.5, 25)],
    ['claude-opus-4-7', rates(5, 10, 0.5, 25)],
    ['claude-opus-4-6', rates(5, 10, 0.5, 25)],
    ['claude-opus-4-5', rates(5, 10, 0.5, 25)],
    ['claude-opus-4-1', rates(15, 30, 1.5, 75)],
    ['claude-opus-4', rates(15, 30, 1.5, 75)],
    ['claude-sonnet-5-5', rates(2, 4, 0.1, 10)],
    ['claude-sonnet-5', rates(2, 4, 0.2, 10)],
    ['claude-sonnet-4-6', rates(3, 6, 0.3, 15)],
    ['claude-sonnet-4-5', rates(3, 6, 0.3, 15)],
    ['claude-sonnet-4', rates(3, 6, 0.3, 15)],
    ['claude-haiku-5-5', rates(0.1, 0.2, 0.01, 0.5)],
    ['claude-haiku-4-5', rates(1, 2, 0.1, 5)],
    ['claude-3-5-haiku', rates(0.8, 1.6, 0.08, 4)],
  ]
  for (const [id, expected] of rows) expect([id, rateOf(id, 0)]).toEqual([id, expected])
})

test('a date suffix or a Bedrock-style prefix does not change the price', () => {
  expect(rateOf('claude-opus-4-5-20251101', 0)).toEqual(rates(5, 10, 0.5, 25))
  expect(rateOf('claude-opus-4-20250514', 0)).toEqual(rates(15, 30, 1.5, 75))
  expect(rateOf('anthropic.claude-sonnet-5-5', 0)).toEqual(rates(2, 4, 0.1, 10))
  expect(rateOf('us.anthropic.claude-sonnet-5-5-v1:0', 0)).toEqual(rates(2, 4, 0.1, 10))
  expect(rateOf('claude-3-5-haiku-20241022', 0)).toEqual(rates(0.8, 1.6, 0.08, 4))
})

test('the longest listed prefix wins, and only at a hyphen boundary', () => {
  // sonnet-5-5 is not sonnet-5: they differ in the cache-read rate.
  expect(rateOf('claude-sonnet-5-5', 0).cacheRead).toBe(0.1)
  expect(rateOf('claude-sonnet-5', 0).cacheRead).toBe(0.2)
  expect(rateOf('claude-sonnet-5-20260101', 0).cacheRead).toBe(0.2)
  // claude-opus-45 shares a prefix with claude-opus-4 but not at a hyphen, so it is unknown.
  expect(rateOf('claude-opus-4-5', 0).input).toBe(5)
  expect(rateOf('claude-opus-45', 0)).toEqual(rates(10, 20, 1, 50))
  expect(rateOf('claude-fable-5-1-20260101', 0).cacheRead).toBe(0.25)
})

test('Haiku 5.5 is priced by prompt length: 100 000 tokens is the lower tier, 100 001 the higher', () => {
  expect(rateOf('claude-haiku-5-5', 100_000)).toEqual(rates(0.1, 0.2, 0.01, 0.5))
  expect(rateOf('claude-haiku-5-5', 100_001)).toEqual(rates(0.5, 1, 0.05, 2.5))
  expect(rateOf('claude-haiku-5-5-20260301', 100_001)).toEqual(rates(0.5, 1, 0.05, 2.5))
  // Other models ignore the prompt length.
  expect(rateOf('claude-sonnet-4-5', 500_000)).toEqual(rates(3, 6, 0.3, 15))
})

test('a request counts input, cache reads and cache writes together as the prompt for Haiku 5.5', () => {
  const low = usage('claude-haiku-5-5', { input_tokens: 50_000, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 20_000 })
  // 100 000 in all: the lower tier.
  near(requestUsd(low), (50_000 * 0.1 + 20_000 * 0.2 + 30_000 * 0.01) / 1e6)
  const high = usage('claude-haiku-5-5', { input_tokens: 50_001, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 20_000 })
  near(requestUsd(high), (50_001 * 0.5 + 20_000 * 1 + 30_000 * 0.05) / 1e6)
})

test('requestUsd adds the four token kinds, with cache writes at twice the input rate', () => {
  const u = usage('claude-sonnet-4-5', {
    input_tokens: 1_000,
    output_tokens: 2_000,
    cache_read_input_tokens: 10_000,
    cache_creation_input_tokens: 4_000,
  })
  near(requestUsd(u), (1_000 * 3 + 4_000 * 6 + 10_000 * 0.3 + 2_000 * 15) / 1e6)
  // The 1-hour cache-write rate is 2x the input rate in every row, the unknown one included.
  for (const id of ['claude-fable-5', 'claude-opus-5-5', 'claude-opus-4', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-3-5-haiku', 'claude-unheard-of']) {
    const r = rateOf(id, 0)
    near(r.cacheWrite, r.input * 2)
  }
  near(requestUsd(usage('claude-opus-4-1', { cache_creation_input_tokens: 1_000_000 })), 30)
})

test('each web search adds a cent', () => {
  const u = usage('claude-sonnet-4-5', { input_tokens: 1_000_000 })
  near(requestUsd(u), 3)
  near(requestUsd(u, 0), 3)
  near(requestUsd(u, 3), 3.03)
  near(requestUsd(usage('claude-sonnet-4-5'), 2), 0.02)
})

test('an unknown model is priced at 10 / 20 / 1 / 50', () => {
  expect(rateOf('gpt-something', 0)).toEqual(rates(10, 20, 1, 50))
  expect(rateOf('', 0)).toEqual(rates(10, 20, 1, 50))
  expect(rateOf('claude-newest-9', 0)).toEqual(rates(10, 20, 1, 50))
  expect(rateOf('claude-', 0)).toEqual(rates(10, 20, 1, 50))
  near(requestUsd(usage('mystery', { input_tokens: 1_000_000, output_tokens: 1_000_000 })), 60)
})

test('requestUsd treats broken token counts as zero instead of throwing', () => {
  const broken = { model: 'claude-sonnet-4-5', input_tokens: Number.NaN, output_tokens: 1_000_000 } as unknown as Usage
  near(requestUsd(broken), 15)
})

test('the meter sums an agent\'s requests and reports the running total', () => {
  const meter = createMeter()
  const totals: number[] = []
  meter.watch('a', t => void totals.push(t))
  const u = usage('claude-sonnet-4-5', { input_tokens: 1_000_000 })
  meter.add('a', u, 0)
  meter.add('a', u, 1)
  expect(totals).toHaveLength(2)
  near(totals[0]!, 3)
  near(totals[1]!, 6.01)
})

test('a delegate counts toward its watched root, two levels deep', () => {
  const meter = createMeter()
  const totals: number[] = []
  meter.watch('root', t => void totals.push(t))
  meter.childOf('root', 'child')
  meter.childOf('child', 'grandchild')
  expect(meter.isMetered('root')).toBe(true)
  expect(meter.isMetered('child')).toBe(true)
  expect(meter.isMetered('grandchild')).toBe(true)
  const u = usage('claude-sonnet-4-5', { input_tokens: 1_000_000 })
  meter.add('grandchild', u, 0)
  meter.add('child', u, 0)
  meter.add('root', u, 0)
  expect(totals).toHaveLength(3)
  near(totals[0]!, 3)
  near(totals[1]!, 6)
  near(totals[2]!, 9)
})

test('two watched roots keep separate totals', () => {
  const meter = createMeter()
  const a: number[] = []
  const b: number[] = []
  meter.watch('a', t => void a.push(t))
  meter.watch('b', t => void b.push(t))
  meter.childOf('b', 'b-child')
  const u = usage('claude-sonnet-4-5', { input_tokens: 1_000_000 })
  meter.add('a', u, 0)
  meter.add('b-child', u, 0)
  meter.add('b', u, 0)
  expect(a).toHaveLength(1)
  near(a[0]!, 3)
  expect(b).toHaveLength(2)
  near(b[1]!, 6)
})

test('an agent with no watched root is ignored', () => {
  const meter = createMeter()
  const totals: number[] = []
  meter.watch('a', t => void totals.push(t))
  const u = usage('claude-sonnet-4-5', { input_tokens: 1_000_000 })
  expect(meter.isMetered('stranger')).toBe(false)
  meter.add('stranger', u, 0)
  // A child linked under an unmetered parent is recorded but not metered.
  meter.childOf('stranger', 'its-child')
  expect(meter.isMetered('its-child')).toBe(false)
  meter.add('its-child', u, 0)
  expect(totals).toEqual([])
})

test('unwatch drops the callback and the agent and its delegates stop being metered', () => {
  const meter = createMeter()
  const totals: number[] = []
  meter.watch('a', t => void totals.push(t))
  meter.childOf('a', 'kid')
  const u = usage('claude-sonnet-4-5', { input_tokens: 1_000_000 })
  meter.add('kid', u, 0)
  meter.unwatch('a')
  expect(meter.isMetered('a')).toBe(false)
  expect(meter.isMetered('kid')).toBe(false)
  meter.add('a', u, 0)
  meter.add('kid', u, 0)
  expect(totals).toHaveLength(1)
  // Unwatching an agent that was never watched does nothing.
  meter.unwatch('nobody')
})

test('a link that loops back on itself does not hang the meter', () => {
  const meter = createMeter()
  meter.childOf('x', 'y')
  meter.childOf('y', 'x')
  expect(meter.isMetered('x')).toBe(false)
  meter.add('x', usage('claude-sonnet-4-5', { input_tokens: 1 }), 0)
})

test('a run\'s spend adds the agents that ran, not the reused ones, and is estimated when any of them is', () => {
  expect(runSpend({})).toEqual({ usd: 0, estimated: false })
  const reused = { runId: 'r1', at: 1 }
  expect(runSpend({ a: { costUsd: 0.5 }, b: { costUsd: 0.25 }, c: {}, d: { costUsd: 9, reusedFrom: reused } })).toEqual({ usd: 0.75, estimated: false })
  expect(runSpend({ a: { costUsd: 0.5, costEstimated: true }, d: { costUsd: 9, costEstimated: true, reusedFrom: reused } })).toEqual({ usd: 0.5, estimated: true })
  // Only a reused agent is estimated: nothing counted is.
  expect(runSpend({ a: { costUsd: 0.5 }, d: { costUsd: 9, costEstimated: true, reusedFrom: reused } }).estimated).toBe(false)
})

test('the cap text has two decimals and a ≈ before an estimated spend; only a positive finite number is a cap', () => {
  expect(capText({ usd: 0.5, estimated: false }, 5)).toBe('$0.50 / $5.00')
  expect(capText({ usd: 0.125, estimated: true }, 0.5)).toBe('≈$0.13 / $0.50')
  expect([1, 0.01, 1e6].map(isCap)).toEqual([true, true, true])
  expect([0, -1, NaN, Infinity, '2', undefined, null].map(isCap)).toEqual([false, false, false, false, false, false, false])
})

test('a cap has something to stop only while an agent (not a helper entry) is waiting, paused or running', () => {
  expect(hasLiveAgent({})).toBe(false)
  expect(hasLiveAgent({ a: { status: 'done' }, b: { status: 'failed' }, c: { status: 'skipped' }, d: { status: 'cancelled' } })).toBe(false)
  for (const status of ['waiting', 'paused', 'running']) expect(hasLiveAgent({ a: { status: 'done' }, b: { status } })).toBe(true)
  expect(hasLiveAgent({ a: { status: 'done' }, h: { status: 'running', calledBy: 'a' } })).toBe(false)
})
