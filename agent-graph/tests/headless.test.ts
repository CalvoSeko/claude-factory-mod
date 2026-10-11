import { expect } from 'claude-code/testing'
import { test } from './kit'

import { requestUsd } from '../hooks/cost'
import { createStreamReader, type StreamSink } from '../hooks/headless'

// Dollars are floats: compare within a billionth of a dollar.
const near = (actual: number | undefined, expected: number) => expect(Math.abs((actual ?? NaN) - expected)).toBeLessThan(1e-9)

type Seen = { starts: unknown[][]; ends: unknown[][]; costs: number[] }

const recorder = (): { sink: StreamSink; seen: Seen } => {
  const seen: Seen = { starts: [], ends: [], costs: [] }
  const sink: StreamSink = {
    callStart: (...args) => void seen.starts.push(args),
    callEnd: (...args) => void seen.ends.push(args),
    cost: usd => void seen.costs.push(usd),
  }
  return { sink, seen }
}

const usage = (over: Record<string, number> = {}) => ({
  input_tokens: 2,
  output_tokens: 100,
  cache_creation_input_tokens: 1000,
  cache_read_input_tokens: 5000,
  ...over,
})

const MODEL = 'claude-sonnet-5-5'
const expectedUsd = (u = usage()) => requestUsd({ model: MODEL, ...u })

const assistant = (id: string, content: unknown[], parent: string | null = null, u = usage()) =>
  JSON.stringify({ type: 'assistant', message: { model: MODEL, id, role: 'assistant', content, usage: u }, parent_tool_use_id: parent })

const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })

const toolResults = (parent: string | null, ...blocks: Array<{ id: string; content: unknown; isError?: boolean }>) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: blocks.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: b.content, ...(b.isError === undefined ? {} : { is_error: b.isError }) })),
    },
    parent_tool_use_id: parent,
  })

const result = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'done', total_cost_usd: 0.25, ...over })

test('the card\'s own call starts, then ends with its result text', () => {
  const { sink, seen } = recorder()
  const reader = createStreamReader(sink)
  reader.line(JSON.stringify({ type: 'system', subtype: 'init', cwd: 'C:\\x' }))
  reader.line(assistant('msg_1', [toolUse('toolu_A', 'Bash', { command: 'ls' })]))
  reader.line(toolResults(null, { id: 'toolu_A', content: 'a.txt\nb.txt' }))
  expect(seen.starts).toEqual([['toolu_A', 'Bash', { command: 'ls' }, undefined]])
  expect(seen.ends).toEqual([['toolu_A', true, 'a.txt\nb.txt']])
})

test('an Agent call and the delegate\'s own call under it carry their parent through', () => {
  const { sink, seen } = recorder()
  const reader = createStreamReader(sink)
  reader.line(assistant('msg_1', [toolUse('toolu_A', 'Agent', { subagent_type: 'helper', prompt: 'read it' })]))
  reader.line(toolResults(null, { id: 'toolu_A', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }))
  reader.line(assistant('msg_2', [toolUse('toolu_B', 'Read', { file_path: 'FACTORY.md' })], 'toolu_A'))
  reader.line(toolResults('toolu_A', { id: 'toolu_B', content: '1\t# FACTORY.md' }))
  expect(seen.starts).toEqual([
    ['toolu_A', 'Agent', { subagent_type: 'helper', prompt: 'read it' }, undefined],
    ['toolu_B', 'Read', { file_path: 'FACTORY.md' }, 'toolu_A'],
  ])
  // A text-block array is joined into one string.
  expect(seen.ends).toEqual([
    ['toolu_A', true, 'Async agent launched successfully.'],
    ['toolu_B', true, '1\t# FACTORY.md'],
  ])
})

test('an errored tool result ends the call as not ok; several blocks in one event all end', () => {
  const { sink, seen } = recorder()
  const reader = createStreamReader(sink)
  reader.line(assistant('msg_1', [toolUse('toolu_A', 'Bash', {}), toolUse('toolu_B', 'Read', {})]))
  reader.line(toolResults(null, { id: 'toolu_A', content: 'boom', isError: true }, { id: 'toolu_B', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], isError: false }))
  expect(seen.ends).toEqual([
    ['toolu_A', false, 'boom'],
    ['toolu_B', true, 'one\ntwo'],
  ])
})

test('a long tool result is clipped to 2048 characters', () => {
  const { sink, seen } = recorder()
  const reader = createStreamReader(sink)
  reader.line(assistant('msg_1', [toolUse('toolu_A', 'Bash', {})]))
  reader.line(toolResults(null, { id: 'toolu_A', content: 'x'.repeat(5000) }))
  const text = seen.ends[0]![2] as string
  expect(text.length).toBe(2048)
  expect(text.endsWith('…')).toBe(true)
})

test('assistant events that share one message id are counted once', () => {
  const { sink, seen } = recorder()
  const reader = createStreamReader(sink)
  reader.line(assistant('msg_1', [{ type: 'thinking', thinking: '' }]))
  reader.line(assistant('msg_1', [{ type: 'text', text: 'hi' }]))
  reader.line(assistant('msg_1', [toolUse('toolu_A', 'Bash', {})]))
  expect(seen.costs.length).toBe(1)
  near(seen.costs[0], expectedUsd())
  // A new message id adds its own usage to the running total (a delegate's included).
  reader.line(assistant('msg_2', [{ type: 'text', text: 'again' }], 'toolu_A'))
  expect(seen.costs.length).toBe(2)
  near(seen.costs[1], 2 * expectedUsd())
  // The same events again change nothing.
  reader.line(assistant('msg_2', [{ type: 'text', text: 'again' }], 'toolu_A'))
  expect(seen.costs.length).toBe(2)
})

test('two result events: the last non-empty text, the last subtype and cost', () => {
  const { sink } = recorder()
  const reader = createStreamReader(sink)
  reader.line(result({ result: 'interim', total_cost_usd: 0.1 }))
  reader.line(result({ result: '', total_cost_usd: 0.3 }))
  expect(reader.end()).toEqual({
    result: { subtype: 'success', isError: false, text: 'interim', ownText: '', costUsd: 0.3, apiErrorStatus: null },
    other: '',
  })
})

test('an error result carries its subtype and API status', () => {
  const { sink } = recorder()
  const reader = createStreamReader(sink)
  reader.line(result({ subtype: 'success', is_error: true, api_error_status: 529, result: 'API Error: 529 overloaded', total_cost_usd: 0 }))
  expect(reader.end().result).toEqual({ subtype: 'success', isError: true, text: 'API Error: 529 overloaded', ownText: 'API Error: 529 overloaded', costUsd: 0, apiErrorStatus: 529 })
  const budget = createStreamReader(recorder().sink)
  budget.line(result({ subtype: 'error_max_budget_usd', is_error: false, result: undefined, total_cost_usd: 1.02 }))
  expect(budget.end().result).toEqual({ subtype: 'error_max_budget_usd', isError: false, text: '', ownText: '', costUsd: 1.02, apiErrorStatus: null })
})

test('a last result with errors and no text: its own text is its errors, the answer stays the earlier one', () => {
  const reader = createStreamReader(recorder().sink)
  reader.line(result({ result: 'An earlier answer.' }))
  reader.line(result({ subtype: 'error_during_execution', is_error: true, result: undefined, errors: ['Tool crashed', 'socket hang up'] }))
  const end = reader.end().result!
  expect(end.text).toBe('An earlier answer.')
  expect(end.ownText).toBe('Tool crashed; socket hang up')
})

test('no result event: end() has no result; non-JSON lines are kept in other, the last 2000 characters', () => {
  const { sink } = recorder()
  const reader = createStreamReader(sink)
  reader.line('Error: spawn failed')
  reader.line('')
  reader.line(assistant('msg_1', [{ type: 'text', text: 'hi' }]))
  reader.line('second line')
  expect(reader.end()).toEqual({ other: 'Error: spawn failed\nsecond line' })
  const long = createStreamReader(recorder().sink)
  for (let i = 0; i < 100; i++) long.line(`line ${String(i).padStart(3, '0')} ${'y'.repeat(40)}`)
  const other = long.end().other
  expect(other.length).toBe(2000)
  expect(other.endsWith(`line 099 ${'y'.repeat(40)}`)).toBe(true)
})

test('a malformed or unexpected line never throws', () => {
  const { sink, seen } = recorder()
  const reader = createStreamReader(sink)
  const lines = [
    '{"type":"assistant","message":',
    'null',
    '42',
    '[]',
    '{}',
    '{"type":"assistant"}',
    '{"type":"assistant","message":{"id":"m","content":"nope","usage":null}}',
    '{"type":"assistant","message":{"id":"m2","content":[null,5,{"type":"tool_use"},{"type":"tool_use","id":7,"name":"x"}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result"},null,{"type":"tool_result","tool_use_id":"t"}]}}',
    '{"type":"user","message":{"content":"plain"}}',
    '{"type":"result","result":42,"total_cost_usd":"lots"}',
  ]
  for (const l of lines) reader.line(l)
  const end = reader.end()
  expect(seen.starts).toEqual([])
  expect(end.result?.text).toBe('')
  expect(end.result?.costUsd).toBeUndefined()
})

test('a sink that throws never breaks the reader', () => {
  const sink: StreamSink = {
    callStart: () => { throw new Error('start') },
    callEnd: () => { throw new Error('end') },
    cost: () => { throw new Error('cost') },
  }
  const reader = createStreamReader(sink)
  reader.line(assistant('msg_1', [toolUse('toolu_A', 'Bash', {})]))
  reader.line(toolResults(null, { id: 'toolu_A', content: 'ok' }))
  reader.line(result({ result: 'fine' }))
  expect(reader.end().result?.text).toBe('fine')
})
