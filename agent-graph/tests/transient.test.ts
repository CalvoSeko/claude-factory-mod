import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { RestartKind } from '../types'

import {
  MAX_RESET_WAIT_MS, resetTimeOf, restartDelay, restartWords, transientOfCloud, transientOfEngine, transientOfStatus, transientOfText,
} from '../hooks/transient'

test('error texts of a limit, an overload, the network or a server map to their kind', () => {
  const cases: Array<[string, string]> = [
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}', 'rate-limit'],
    ['Too many requests', 'rate-limit'],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'overloaded'],
    ['The API is overloaded', 'overloaded'],
    ['API Error: 503 Service Unavailable', 'server'],
    ['API Error: 500 Internal server error', 'server'],
    ['Internal server error', 'server'],
    ['getaddrinfo ENOTFOUND api.anthropic.com', 'network'],
    ['read ECONNRESET', 'network'],
    ['API Error: Connection error.', 'network'],
    ['connection lost', 'network'],
    ['Claude AI usage limit reached|1760000000', 'usage-limit'],
    ["You've hit your session limit · resets 3pm (Europe/London)", 'usage-limit'],
    ['5-hour limit reached ∙ resets 3pm', 'usage-limit'],
    ['API Error: 429 Claude AI usage limit reached', 'usage-limit'],
  ]
  for (const [text, kind] of cases) expect([text, transientOfText(text)?.kind]).toEqual([text, kind])
  expect(transientOfText('read ECONNRESET')).toEqual({ kind: 'network', text: 'read ECONNRESET' })
})

test("real failures, the mod's own words among them, are never temporary", () => {
  const texts = [
    'Refused: the request looked harmful',
    'Refused.',
    'Hit its $2 budget.',
    'Hit its $500 budget.',
    'Stopped.',
    'Stopped (not confirmed).',
    'Stopped: the run reached its $5.00 cap.',
    '`npm test` exited 1.',
    'Timed out after 10 min.',
    'Still failing after 3 retries: No VERDICT line.',
    'prompt is too long: 250000 tokens > 200000 maximum',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    'Your credit balance is too low',
    'The agent stopped with an error.',
    'The session ended without an answer.',
    'Waiting for a tool approval; open its Console link to answer it.',
    'Session error: boom',
  ]
  for (const text of texts) expect([text, transientOfText(text)]).toEqual([text, undefined])
})

test("the engine's error kinds: limits, overloads and server errors are temporary; account and request errors never are", () => {
  expect(transientOfEngine('rate_limit', undefined)).toEqual({ kind: 'rate-limit', text: 'rate_limit' })
  expect(transientOfEngine('rate_limit', 'Claude AI usage limit reached|1760000000')?.kind).toBe('usage-limit')
  expect(transientOfEngine('overloaded', 'Overloaded')).toEqual({ kind: 'overloaded', text: 'Overloaded' })
  expect(transientOfEngine('server_error', undefined)?.kind).toBe('server')
  expect(transientOfEngine('unknown', 'read ECONNRESET')?.kind).toBe('network')
  expect(transientOfEngine('unknown', 'something odd')).toBeUndefined()
  expect(transientOfEngine('unknown', undefined)).toBeUndefined()
  for (const kind of ['authentication_failed', 'billing_error', 'invalid_request', 'model_not_found', 'max_output_tokens', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error']) {
    expect([kind, transientOfEngine(kind, '429 rate limit, ECONNRESET')]).toEqual([kind, undefined])
  }
})

test('HTTP statuses: 429, 529 and 5xx are temporary, 4xx are not', () => {
  expect(transientOfStatus(429, 'rate_limit_error (429): slow down')).toEqual({ kind: 'rate-limit', text: 'rate_limit_error (429): slow down' })
  expect(transientOfStatus(429, 'usage limit reached')?.kind).toBe('usage-limit')
  expect(transientOfStatus(529, 'x')?.kind).toBe('overloaded')
  expect(transientOfStatus(500, 'x')?.kind).toBe('server')
  expect(transientOfStatus(503, 'x')?.kind).toBe('server')
  for (const status of [400, 401, 403, 404, 413]) expect(transientOfStatus(status, 'overloaded')).toBeUndefined()
})

test("a cloud session error reads its type and message; a request error stays a failure", () => {
  expect(transientOfCloud({ type: 'overloaded_error', message: 'Overloaded' })?.kind).toBe('overloaded')
  expect(transientOfCloud({ type: 'rate_limit_error', message: 'slow down' })?.kind).toBe('rate-limit')
  expect(transientOfCloud({ type: 'api_error', message: 'oops' })?.kind).toBe('server')
  expect(transientOfCloud({ message: 'Connection error' })?.kind).toBe('network')
  expect(transientOfCloud({ type: 'invalid_request_error', message: 'bad' })).toBeUndefined()
  expect(transientOfCloud({ type: 'invalid_request_error', message: 'the model is overloaded' })).toBeUndefined()
  expect(transientOfCloud({ message: 'boom' })).toBeUndefined()
  expect(transientOfCloud(undefined)).toBeUndefined()
})

test('a reset time is read from an epoch suffix, ISO 8601, a clock time (next to come) or a span', () => {
  const now = new Date(2026, 9, 11, 10, 0).getTime()
  expect(resetTimeOf('Claude AI usage limit reached|1760000000', now)).toBe(1_760_000_000_000)
  expect(resetTimeOf('limit resets at 2026-10-11T15:00:00Z', now)).toBe(Date.parse('2026-10-11T15:00:00Z'))
  expect(resetTimeOf("You've hit your limit · resets 3pm (Europe/London)", now)).toBe(new Date(2026, 9, 11, 15, 0).getTime())
  expect(resetTimeOf('limit reached ∙ resets at 3:30am', now)).toBe(new Date(2026, 9, 12, 3, 30).getTime())
  expect(resetTimeOf('resets 3pm', new Date(2026, 9, 11, 16, 0).getTime())).toBe(new Date(2026, 9, 12, 15, 0).getTime())
  expect(resetTimeOf('resets 12am', now)).toBe(new Date(2026, 9, 12, 0, 0).getTime())
  expect(resetTimeOf('Session limit · resets in 2h 15m', now)).toBe(now + (2 * 60 + 15) * 60_000)
  expect(resetTimeOf('resets in 40m', now)).toBe(now + 40 * 60_000)
  expect(resetTimeOf('usage limit reached', now)).toBeUndefined()
})

test('the waits are 30 s, 2 min, 5 min; a usage limit with a reset waits until just after it, capped at 6 h', () => {
  const now = 1_000_000
  const network = { kind: 'network' as const, text: 'read ECONNRESET' }
  expect([1, 2, 3].map(n => restartDelay(network, n, now))).toEqual([30_000, 120_000, 300_000])
  const epoch = (ms: number) => `usage limit reached|${Math.round(ms / 1000)}`
  const t0 = 1_760_000_000_000
  expect(restartDelay({ kind: 'usage-limit', text: epoch(t0 + 3_600_000) }, 1, t0)).toBe(3_600_000 + 30_000)
  expect(restartDelay({ kind: 'usage-limit', text: epoch(t0 + 10 * 3_600_000) }, 1, t0)).toBe(MAX_RESET_WAIT_MS)
  // Passed, or not readable: the steps.
  expect(restartDelay({ kind: 'usage-limit', text: epoch(t0 - 60_000) }, 2, t0)).toBe(120_000)
  expect(restartDelay({ kind: 'usage-limit', text: 'usage limit reached' }, 1, t0)).toBe(30_000)
  // Only a usage limit waits for a reset.
  expect(restartDelay({ kind: 'rate-limit', text: epoch(t0 + 3_600_000) }, 1, t0)).toBe(30_000)
})

test('each kind has words for the person', () => {
  const kinds: RestartKind[] = ['usage-limit', 'rate-limit', 'overloaded', 'network', 'server']
  expect(kinds.map(restartWords)).toEqual([
    'usage limit', 'rate limited (429)', 'API overloaded (529)', 'network error', 'server error (5xx)',
  ])
})
