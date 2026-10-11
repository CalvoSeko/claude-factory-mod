import type { RestartKind } from '../types'

// A failure that clears by waiting, as a backend saw it: its kind, and the error words (read again for a reset time).
// Only a backend decides this; the runner never reads error text.
export type Transient = { kind: RestartKind; text: string }

// The waits before the first, second and third automatic retry.
export const RESTART_WAITS_MS: readonly number[] = [30_000, 120_000, 300_000]
export const MAX_RESTARTS = 3
// A usage limit that says when it resets is retried this long after that time, but never more than MAX_RESET_WAIT_MS away.
export const RESET_MARGIN_MS = 30_000
export const MAX_RESET_WAIT_MS = 6 * 60 * 60_000

// Words that mark a failure no wait clears, whatever else the text says.
const PERMANENT = /authentication|billing|invalid_request|permission_error|not_found_error|model_not_found|prompt is too long|max_output_tokens|credit balance/i
const USAGE = /\busage limit\b|\b(?:session|weekly|5-hour|daily|opus|sonnet) limit\b|\bhit your (?:usage |session )?limit\b/i
// A status code in the text: not a dollar amount or part of a longer number.
const code = (digits: string) => new RegExp(`(?<![$.,\\d])${digits}(?![\\d]|[.,]\\d)`)
const OVERLOADED = new RegExp(`${code('529').source}|overloaded`, 'i')
const RATE = new RegExp(`${code('429').source}|rate[ _-]?limit|too many requests`, 'i')
const NETWORK = /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network error|request timed out|connection (?:error|lost|reset|refused|closed)/i
const SERVER = new RegExp(`${code('5\\d\\d').source}|internal server error|bad gateway|service unavailable|gateway time-?out|server[ _]error|\\bapi_error\\b`, 'i')

// The engine's API error kinds (StopFailure's `error`) that never clear by waiting.
const PERMANENT_KINDS = new Set([
  'authentication_failed', 'billing_error', 'invalid_request', 'model_not_found', 'max_output_tokens',
  'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error',
])

const limitKind = (text: string): RestartKind => (USAGE.test(text) ? 'usage-limit' : 'rate-limit')

export function transientOfText(text: string): Transient | undefined {
  if (PERMANENT.test(text)) return undefined
  const kind: RestartKind | undefined = USAGE.test(text)
    ? 'usage-limit'
    : OVERLOADED.test(text) ? 'overloaded'
    : RATE.test(text) ? 'rate-limit'
    : NETWORK.test(text) ? 'network'
    : SERVER.test(text) ? 'server'
    : undefined
  return kind === undefined ? undefined : { kind, text }
}

// What ended a Local agent's turn, in the engine's words (`classic.StopFailure`'s `error` and `error_details`).
export function transientOfEngine(error: string, details: string | undefined): Transient | undefined {
  if (PERMANENT_KINDS.has(error)) return undefined
  const text = details ?? error
  if (error === 'rate_limit') return { kind: limitKind(text), text }
  if (error === 'overloaded') return { kind: 'overloaded', text }
  if (error === 'server_error') return { kind: 'server', text }
  return details === undefined ? undefined : transientOfText(details)
}

// An HTTP status a request failed with.
export function transientOfStatus(status: number, text: string): Transient | undefined {
  if (status === 429) return { kind: limitKind(text), text }
  if (status === 529) return { kind: 'overloaded', text }
  return status >= 500 && status <= 599 ? { kind: 'server', text } : undefined
}

// A cloud `session.error`'s `error`: its type and message read together.
export function transientOfCloud(error: unknown): Transient | undefined {
  if (typeof error === 'string') return transientOfText(error)
  if (typeof error !== 'object' || error === null) return undefined
  const { type, message } = error as { type?: unknown; message?: unknown }
  return transientOfText([type, message].filter(part => typeof part === 'string' && part !== '').join(': '))
}

// When a limit says it resets: `…|<epoch seconds>`, an ISO 8601 time, `resets in 2h 15m`, or `resets [at] 3pm` / `3:30am`
// (local time, the next one to come).
export function resetTimeOf(text: string, now: number): number | undefined {
  const epoch = /\|(\d{10})\b/.exec(text)
  if (epoch !== null) return Number(epoch[1]) * 1000
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(text)
  if (iso !== null) {
    const at = Date.parse(iso[0])
    return Number.isNaN(at) ? undefined : at
  }
  const relative = /\bresets? in\s+(?:(\d+)\s*h\w*)?\s*(?:(\d+)\s*m\w*)?/i.exec(text)
  if (relative !== null && (relative[1] !== undefined || relative[2] !== undefined)) {
    return now + (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * 60_000
  }
  const clock = /\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i.exec(text)
  if (clock === null) return undefined
  const at = new Date(now)
  at.setHours((Number(clock[1]) % 12) + (clock[3]!.toLowerCase() === 'p' ? 12 : 0), Number(clock[2] ?? 0), 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

// How long to wait before retry `attempt` (1-based): a usage limit that says when it resets waits until just after
// then (capped); anything else, or a reset that cannot be read or has passed, takes the next step.
export function restartDelay(t: Transient, attempt: number, now: number): number {
  const reset = t.kind === 'usage-limit' ? resetTimeOf(t.text, now) : undefined
  if (reset !== undefined && reset > now) return Math.min(reset + RESET_MARGIN_MS - now, MAX_RESET_WAIT_MS)
  return RESTART_WAITS_MS[Math.min(attempt, RESTART_WAITS_MS.length) - 1]!
}

const WORDS: Record<RestartKind, string> = {
  'usage-limit': 'usage limit',
  'rate-limit': 'rate limited (429)',
  overloaded: 'API overloaded (529)',
  network: 'network error',
  server: 'server error (5xx)',
}
export const restartWords = (kind: RestartKind): string => WORDS[kind]
