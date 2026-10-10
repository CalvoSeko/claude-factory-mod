// What a model request costs, and what each watched agent (with the delegates it started) has spent.
// Pure: register.tsx feeds the meter from `turn.step`, the Local backend reads it. Prices are list prices of
// 2026-10-09 in USD per million tokens; when they change, this is the one place to edit.

export type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type Rates = { input: number; cacheWrite: number; cacheRead: number; output: number }

// Cache writes are priced at the 1-hour rate (2x input): the usage does not say which kind of write it was, and the
// higher rate never under-counts.
const rates = (input: number, cacheRead: number, output: number): Rates => ({ input, cacheWrite: input * 2, cacheRead, output })

// Anything not listed: the highest known rate, so an unknown model never under-counts.
const UNKNOWN: Rates = rates(10, 1, 50)

const FABLE_5_1 = rates(10, 0.25, 50)
const FABLE_5 = rates(10, 1, 50)
const OPUS_5 = rates(5, 0.5, 25)
const OPUS_4 = rates(15, 1.5, 75)
const SONNET_4 = rates(3, 0.3, 15)

// Haiku 5.5 has two tiers, chosen per request by its prompt length.
const HAIKU_5_5_PROMPT_MAX = 100_000
const HAIKU_5_5_LOW = rates(0.1, 0.01, 0.5)
const HAIKU_5_5_HIGH = rates(0.5, 0.05, 2.5)

// Model id prefix -> rates (a function of the prompt length where the price depends on it).
const PRICES: readonly (readonly [string, Rates | ((promptTokens: number) => Rates)])[] = [
  ['claude-fable-5-1', FABLE_5_1],
  ['claude-mythos-5-1', FABLE_5_1],
  ['claude-fable-5', FABLE_5],
  ['claude-mythos-5', FABLE_5],
  ['claude-opus-5-5', rates(4, 0.2, 20)],
  ['claude-opus-5', OPUS_5],
  ['claude-opus-4-8', OPUS_5],
  ['claude-opus-4-7', OPUS_5],
  ['claude-opus-4-6', OPUS_5],
  ['claude-opus-4-5', OPUS_5],
  ['claude-opus-4-1', OPUS_4],
  ['claude-opus-4', OPUS_4],
  ['claude-sonnet-5-5', rates(2, 0.1, 10)],
  ['claude-sonnet-5', rates(2, 0.2, 10)],
  ['claude-sonnet-4-6', SONNET_4],
  ['claude-sonnet-4-5', SONNET_4],
  ['claude-sonnet-4', SONNET_4],
  ['claude-haiku-5-5', promptTokens => (promptTokens > HAIKU_5_5_PROMPT_MAX ? HAIKU_5_5_HIGH : HAIKU_5_5_LOW)],
  ['claude-haiku-4-5', rates(1, 0.1, 5)],
  ['claude-3-5-haiku', rates(0.8, 0.08, 4)],
]

export const WEB_SEARCH_USD = 0.01

// USD per million tokens for a model id (Bedrock's `anthropic.`/`us.anthropic.` prefixes and date suffixes are fine).
// `promptTokens` only matters for Haiku 5.5.
export function rateOf(model: string, promptTokens: number): Rates {
  const start = model.indexOf('claude-')
  if (start < 0) return UNKNOWN
  const id = model.slice(start)
  // The longest listed prefix that the id equals or continues with `-`.
  let best: (typeof PRICES)[number] | undefined
  for (const row of PRICES) {
    const prefix = row[0]
    if (id !== prefix && !id.startsWith(`${prefix}-`)) continue
    if (!best || prefix.length > best[0].length) best = row
  }
  if (!best) return UNKNOWN
  return typeof best[1] === 'function' ? best[1](promptTokens) : best[1]
}

// A token count that is missing or not a number counts as none: pricing never throws into a caller.
const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

export function requestUsd(usage: Usage, webSearches = 0): number {
  const input = count(usage.input_tokens)
  const output = count(usage.output_tokens)
  const cacheRead = count(usage.cache_read_input_tokens)
  const cacheWrite = count(usage.cache_creation_input_tokens)
  const r = rateOf(typeof usage.model === 'string' ? usage.model : '', input + cacheRead + cacheWrite)
  return (input * r.input + cacheWrite * r.cacheWrite + cacheRead * r.cacheRead + output * r.output) / 1e6 + WEB_SEARCH_USD * count(webSearches)
}

export type Meter = {
  // The spend of `agentId` and of its delegates is summed; `onUsd` gets the running total after each request.
  watch(agentId: string, onUsd: (totalUsd: number) => void): void
  // Drops the callback. Totals already added stay, and the agent and its delegates are no longer metered.
  unwatch(agentId: string): void
  // `childId` was started by `parentId` (at any depth: the root is found by following the links when a request is added).
  childOf(parentId: string, childId: string): void
  // Whether the agent is watched, or a delegate of one that is.
  isMetered(agentId: string): boolean
  // Prices one request of `agentId` into its root's total and tells the root's callback. An agent with no watched root is ignored.
  add(agentId: string, usage: Usage, webSearches: number): void
}

export function createMeter(): Meter {
  const callbacks = new Map<string, (totalUsd: number) => void>()
  const totals = new Map<string, number>()
  const parents = new Map<string, string>()

  // The watched agent at the top of `agentId`'s chain of parents, if any.
  const rootOf = (agentId: string): string | undefined => {
    let id = agentId
    // A loop in the links ends the walk instead of hanging it.
    const seen = new Set<string>()
    while (!seen.has(id)) {
      if (callbacks.has(id)) return id
      seen.add(id)
      const parent = parents.get(id)
      if (parent === undefined) return undefined
      id = parent
    }
    return undefined
  }

  return {
    watch(agentId, onUsd) {
      callbacks.set(agentId, onUsd)
      if (!totals.has(agentId)) totals.set(agentId, 0)
    },
    unwatch(agentId) {
      callbacks.delete(agentId)
    },
    childOf(parentId, childId) {
      if (parentId !== childId) parents.set(childId, parentId)
    },
    isMetered: agentId => rootOf(agentId) !== undefined,
    add(agentId, usage, webSearches) {
      const root = rootOf(agentId)
      if (root === undefined) return
      const total = (totals.get(root) ?? 0) + requestUsd(usage, webSearches)
      totals.set(root, total)
      callbacks.get(root)?.(total)
    },
  }
}

// A cost as printed: `$0.12`, or `≈$0.12` when it is an estimate.
export const usdText = (usd: number, estimated?: boolean): string => `${estimated === true ? '≈' : ''}$${usd.toFixed(2)}`

// What a run has cost so far, for its cap: the sum over the agents that really ran (a reused agent's cost was
// spent by the run it came from), and whether any of it is an estimate.
export function runSpend(nodes: Record<string, { costUsd?: number; costEstimated?: boolean; reusedFrom?: unknown }>): { usd: number; estimated: boolean } {
  let usd = 0
  let estimated = false
  for (const v of Object.values(nodes)) {
    if (v.reusedFrom !== undefined || v.costUsd === undefined) continue
    usd += v.costUsd
    if (v.costEstimated === true) estimated = true
  }
  return { usd, estimated }
}

// A cap as the person set it: a positive finite number.
export const isCap = (cap: unknown): cap is number => typeof cap === 'number' && Number.isFinite(cap) && cap > 0

// The toolbar's "spent / cap" while a capped run goes.
export const capText = (spent: { usd: number; estimated: boolean }, cap: number): string => `${usdText(spent.usd, spent.estimated)} / $${cap.toFixed(2)}`

// Whether some agent of the run (not a delegate helper's entry) is still waiting, paused or running: only then is there
// anything for a cap to stop.
export const hasLiveAgent = (nodes: Record<string, { status: string; calledBy?: string }>): boolean =>
  Object.values(nodes).some(v => v.calledBy === undefined && (v.status === 'waiting' || v.status === 'paused' || v.status === 'running'))
