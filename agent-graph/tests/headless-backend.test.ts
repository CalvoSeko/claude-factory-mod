import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph } from '../types'
import { createTracker, type Tracker } from '../hooks/activity'
import { requestUsd } from '../hooks/cost'
import { createHeadlessBackend, type HeadlessDeps } from '../hooks/headless'
import type { CommandChunk, CommandEnd } from '../hooks/local'
import { connect } from '../hooks/model'
import type { Backend, NodeOutcome } from '../hooks/runner'

declare const setTimeout: (run: () => void, ms?: number) => unknown

const node = (id: string, name: string, over: Partial<AgentNode> = {}): AgentNode => ({
  id, name, x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2, ...over,
})
const graph = (nodes: AgentNode[]): Graph => ({ id: 'g', name: 'Flow', description: '', backend: 'headless', nodes, edges: [] })
// Lead delegates to Reader.
const pair = () => connect(graph([node('a', 'Lead'), node('b', 'Reader')]), 'a', 'b', 'delegate')

const HOME = 'C:/Users/me'
const FILE_A = `${HOME}/.claude/agent-graph/g/headless/flow--lead-a.json`
const ENDED: CommandEnd = { code: 0, signal: null }

// A child scripted piece by piece, then its end: an exit, an error on the next pull, or a hang until it is returned.
function scripted(chunks: CommandChunk[], end: CommandEnd | Error | 'hang' = ENDED) {
  let at = 0
  let isReturned = false
  let release: (() => void) | undefined
  const gone: CommandEnd = { code: null, signal: 'SIGTERM' }
  const child = {
    async next(): Promise<IteratorResult<CommandChunk, CommandEnd>> {
      if (isReturned) return { done: true, value: gone }
      if (at < chunks.length) return { done: false, value: chunks[at++]! }
      if (end instanceof Error) throw end
      if (end === 'hang') {
        await new Promise<void>(resolve => (release = resolve))
        return { done: true, value: gone }
      }
      return { done: true, value: end }
    },
    // Records that the stream was returned (not that the child died at once: a native generator queues return() behind a pending pull).
    async return(value: CommandEnd): Promise<IteratorResult<CommandChunk, CommandEnd>> {
      isReturned = true
      release?.()
      return { done: true, value }
    },
    async throw(error: unknown): Promise<IteratorResult<CommandChunk, CommandEnd>> {
      throw error
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
  return { child: child as unknown as AsyncGenerator<CommandChunk, CommandEnd>, isReturned: () => isReturned }
}

const out = (...lines: string[]): CommandChunk => ({ stream: 'stdout', text: lines.map(l => `${l}\n`).join('') })

const MODEL = 'claude-sonnet-5-5'
const usage = { input_tokens: 2, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 }
const assistant = (id: string, content: unknown[], parent: string | null = null) =>
  JSON.stringify({ type: 'assistant', message: { model: MODEL, id, role: 'assistant', content, usage }, parent_tool_use_id: parent })
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
const toolResult = (id: string, content: string, parent: string | null = null, isError = false) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, parent_tool_use_id: parent })
const result = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'All done.', total_cost_usd: 0.25, ...over })

type Spawned = { argv: string[]; input: string; env: Record<string, string> }

function setup(children: Array<ReturnType<typeof scripted> | Error>, over: Partial<HeadlessDeps> = {}) {
  const writes = new Map<string, string>()
  const spawned: Spawned[] = []
  const checkStarts: string[] = []
  const checks: Backend = {
    prepare: async () => [],
    start: async n => {
      checkStarts.push(n.id)
      return { done: Promise.resolve({ ok: true, text: 'passed', files: [] }), stop: async () => {} }
    },
  }
  const deps: HeadlessDeps = {
    home: async () => HOME,
    write: async (path, text) => void writes.set(path, text),
    spawn: (argv, input, env) => {
      spawned.push({ argv, input, env })
      const next = children.shift()
      if (next === undefined) throw new Error('no child scripted')
      if (next instanceof Error) throw next
      return next.child
    },
    instructions: async n => `I am ${n.name}.`,
    context: { kind: async () => 'missing', read: async () => '', files: async () => [] },
    checks,
    ...over,
  }
  return { deps, writes, spawned, checkStarts }
}

const run = async (g: Graph, deps: HeadlessDeps, n = g.nodes[0]!) => {
  const costs: number[] = []
  const estimated: Array<boolean | undefined> = []
  const started = await createHeadlessBackend(g, deps).start(n, 'Do the task.', [], (usd, isEstimate) => {
    costs.push(usd)
    estimated.push(isEstimate)
  })
  return { started, costs, estimated, outcome: () => started.done }
}

test('a card runs as claude -p in auto mode with its agents file, its budget, the prompt on stdin and none of the host links', async () => {
  const g = pair()
  const { deps, spawned } = setup([scripted([out(result())])])
  await (await run(g, deps)).outcome()
  expect(spawned).toEqual([{
    argv: [
      'claude', '-p', '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--agents', FILE_A, '--agent', 'flow--lead-a', '--max-budget-usd', '2',
    ],
    input: 'Do the task.',
    env: {
      CLAUDE_CODE_PLUGIN_DIRS: '',
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '',
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_CODE_HOST_SESSION_ID: '',
      CLAUDE_CODE_MESSAGING_SOCKET: '',
      CLAUDE_CODE_MESSAGING_TOKEN: '',
    },
  }])
})

test('the executable is CLAUDE_CODE_EXECPATH when the session has it, else claude', async () => {
  const g = pair()
  const withPath = setup([scripted([out(result())])], { execPath: async () => 'C:/Program Files/Claude/claude.exe' })
  await (await run(g, withPath.deps)).outcome()
  expect(withPath.spawned[0]!.argv[0]).toBe('C:/Program Files/Claude/claude.exe')
  for (const execPath of [async () => undefined, async () => '']) {
    const without = setup([scripted([out(result())])], { execPath })
    await (await run(g, without.deps)).outcome()
    expect(without.spawned[0]!.argv[0]).toBe('claude')
  }
})

test('no budget flag without a positive finite budget', async () => {
  for (const budgetUsd of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    const g = graph([node('a', 'Lead', { budgetUsd })])
    const { deps, spawned } = setup([scripted([out(result())])])
    await (await run(g, deps)).outcome()
    expect(spawned[0]!.argv.includes('--max-budget-usd')).toBe(false)
  }
})

test('prepare writes each card\'s agents file: the card and its delegates, keyed by name, with no name inside', async () => {
  const g = pair()
  const { deps, writes } = setup([])
  expect(await createHeadlessBackend(g, deps).prepare(g)).toEqual([])
  const lead = JSON.parse(writes.get(FILE_A)!) as Record<string, Record<string, unknown>>
  expect(Object.keys(lead)).toEqual(['flow--lead-a', 'flow--reader-b'])
  expect(lead['flow--lead-a']!['name']).toBeUndefined()
  expect(lead['flow--reader-b']!['name']).toBeUndefined()
  expect(lead['flow--lead-a']!['description']).toBe('I am Lead.')
  expect(String(lead['flow--lead-a']!['prompt'])).toContain('- Reader (subagent_type "flow--reader-b"): I am Reader.')
  // Lead has every tool, so its Agent calls are not limited; Reader has no delegates, so no Agent tool.
  expect(lead['flow--lead-a']!['tools']).toBeUndefined()
  expect(lead['flow--lead-a']!['disallowedTools']).toBeUndefined()
  expect(lead['flow--reader-b']).toEqual({ description: 'I am Reader.', prompt: 'I am Reader.', disallowedTools: ['Agent'] })
  const reader = JSON.parse(writes.get(`${HOME}/.claude/agent-graph/g/headless/flow--reader-b.json`)!) as Record<string, unknown>
  expect(Object.keys(reader)).toEqual(['flow--reader-b'])
})

test('the delegates of a delegate are in the agents file of the card too', async () => {
  const g = connect(connect(graph([node('a', 'Lead'), node('b', 'Reader'), node('c', 'Fetcher')]), 'a', 'b', 'delegate'), 'b', 'c', 'delegate')
  const { deps, writes } = setup([])
  expect(await createHeadlessBackend(g, deps).prepare(g)).toEqual([])
  expect(Object.keys(JSON.parse(writes.get(FILE_A)!) as object)).toEqual(['flow--lead-a', 'flow--reader-b', 'flow--fetcher-c'])
  expect(Object.keys(JSON.parse(writes.get(`${HOME}/.claude/agent-graph/g/headless/flow--reader-b.json`)!) as object)).toEqual(['flow--reader-b', 'flow--fetcher-c'])
})

test('a card with a tool list may start only its delegates; without delegates it has no Agent tool', async () => {
  const base = graph([node('a', 'Lead', { tools: ['Read', 'Bash'] }), node('b', 'Reader', { tools: ['Read'] }), node('c', 'Writer')])
  const g = connect(connect(base, 'a', 'b', 'delegate'), 'a', 'c', 'delegate')
  const { deps, writes } = setup([])
  await createHeadlessBackend(g, deps).prepare(g)
  const agents = JSON.parse(writes.get(FILE_A)!) as Record<string, { tools?: string[]; disallowedTools?: string[] }>
  expect(agents['flow--lead-a']!.tools).toEqual(['Read', 'Bash', 'Agent(flow--reader-b, flow--writer-c)'])
  expect(agents['flow--lead-a']!.disallowedTools).toBeUndefined()
  expect(agents['flow--reader-b']).toMatchObject({ tools: ['Read'], disallowedTools: ['Agent'] })
  expect(agents['flow--writer-c']!.disallowedTools).toEqual(['Agent'])
})

test('prepare reports a reviewer\'s verdict tail, missing context and a failed write as node problems; check cards are skipped', async () => {
  const g0 = graph([
    node('a', 'Lead'),
    node('b', 'Reviewer'),
    node('c', 'Reader', { contextFiles: ['gone.md'] }),
    node('k', 'Check 1', { instructionsFile: '', check: { command: 'npm test', timeoutMin: 5 } }),
  ])
  const g = connect(connect(g0, 'a', 'b', 'handoff'), 'b', 'a', 'retry')
  const writes = new Map<string, string>()
  const { deps } = setup([], {
    write: async (path, text) => {
      if (path.endsWith('flow--lead-a.json')) throw new Error('disk full')
      writes.set(path, text)
    },
  })
  const problems = await createHeadlessBackend(g, deps).prepare(g)
  expect(problems).toEqual([
    { target: { kind: 'node', id: 'c' }, message: 'Context path not found: gone.md' },
    { target: { kind: 'node', id: 'a' }, message: 'Could not write this agent\'s settings: disk full' },
  ])
  const reviewer = JSON.parse(writes.get(`${HOME}/.claude/agent-graph/g/headless/flow--reviewer-b.json`)!) as Record<string, { prompt: string }>
  expect(reviewer['flow--reviewer-b']!.prompt.endsWith('`VERDICT: fail` and what must change.')).toBe(true)
  expect([...writes.keys()].some(p => p.includes('check'))).toBe(false)
})

test('success: the answer is the last non-empty result, the exact cost comes last, and stdout lines may span pieces', async () => {
  const g = pair()
  const first = result({ result: 'The answer.', total_cost_usd: 0.1 })
  const last = result({ result: '', total_cost_usd: 0.25 })
  const lines = [assistant('msg_1', [{ type: 'text', text: 'hi' }]), first].join('\r\n')
  const { deps } = setup([scripted([
    { stream: 'stdout', text: lines.slice(0, 40) },
    { stream: 'stdout', text: `${lines.slice(40)}\n` },
    // The last line has no newline: it is still read.
    { stream: 'stdout', text: last },
  ])])
  const { outcome, costs, estimated } = await run(g, deps)
  expect(await outcome()).toEqual({ ok: true, text: 'The answer.', files: [] })
  // The live estimate of the one message, then the exact total.
  expect(costs).toEqual([requestUsd({ model: MODEL, ...usage }), 0.25])
  expect(estimated).toEqual([true, false])
})

test('the card\'s calls are tracked, and a delegate\'s calls nest under the Agent call that started it', async () => {
  const g = pair()
  const tracker = createTracker(() => {}, () => 0)
  const { deps } = setup([scripted([out(
    assistant('m1', [toolUse('t1', 'Bash', { command: 'ls' })]),
    toolResult('t1', 'a.txt'),
    assistant('m2', [toolUse('t2', 'Agent', { description: 'Read it', prompt: 'read', subagent_type: 'flow--reader-b' })]),
    toolResult('t2', 'Async agent launched successfully.'),
    assistant('m3', [toolUse('t3', 'Read', { file_path: 'FACTORY.md' })], 't2'),
    toolResult('t3', '# FACTORY.md', 't2'),
    result(),
  )])], { tracker: () => tracker })
  const { outcome } = await run(g, deps)
  expect((await outcome()).ok).toBe(true)
  const items = tracker.itemsOf('a')
  expect(items.map(i => [i.tool, i.status])).toEqual([['Bash', 'ok'], ['Agent', 'ok']])
  expect(items[0]!.result).toBe('a.txt')
  const delegate = items[1]!.delegate!
  expect(delegate.name).toBe('Reader')
  expect(delegate.nodeId).toBe('b')
  expect(delegate.items.map(i => [i.tool, i.summary, i.status])).toEqual([['Read', 'FACTORY.md', 'ok']])
  expect(tracker.helpersOf('a').map(h => [h.nodeId, h.status])).toEqual([['b', 'done']])
})

test('a delegate still open when the card fails ends with the card', async () => {
  const g = pair()
  const tracker = createTracker(() => {}, () => 0)
  const { deps } = setup([scripted([out(
    assistant('m2', [toolUse('t2', 'Agent', { prompt: 'read', subagent_type: 'flow--reader-b' })]),
    toolResult('t2', 'Async agent launched successfully.'),
    assistant('m3', [toolUse('t3', 'Read', { file_path: 'x' })], 't2'),
  )], { code: 1, signal: null })], { tracker: () => tracker })
  const { outcome } = await run(g, deps)
  expect((await outcome()).ok).toBe(false)
  const agentCall = tracker.itemsOf('a')[0]!
  expect(agentCall.status).toBe('failed')
  expect(agentCall.delegate!.items[0]!.status).toBe('failed')
})

test('the budget: a max-budget result, or an exact cost that reached it, ends the card failed', async () => {
  const g = pair()
  const byFlag = setup([scripted([out(result({ subtype: 'error_max_budget_usd', is_error: true, result: '', total_cost_usd: 2.1 }))])])
  const flagged = await run(g, byFlag.deps)
  expect(await flagged.outcome()).toEqual({ ok: false, reason: 'Hit its $2 budget.' })
  expect(flagged.costs.at(-1)).toBe(2.1)
  const byCost = setup([scripted([out(result({ total_cost_usd: 2 }))])])
  expect(await (await run(g, byCost.deps)).outcome()).toEqual({ ok: false, reason: 'Hit its $2 budget.' })
})

test('an API error result fails with its text: 529 is temporary, 400 is not', async () => {
  const g = pair()
  const busy = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
  const overloaded = setup([scripted([out(result({ is_error: true, api_error_status: 529, result: busy }))])])
  expect(await (await run(g, overloaded.deps)).outcome()).toEqual({
    ok: false,
    reason: `The agent stopped with an error: ${busy}`,
    transient: { kind: 'overloaded', text: busy },
  })
  const bad = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}'
  const invalid = setup([scripted([out(result({ is_error: true, api_error_status: 400, result: bad }))])])
  expect(await (await run(g, invalid.deps)).outcome()).toEqual({ ok: false, reason: `The agent stopped with an error: ${bad}` })
})

test('a last result that is an error with no text fails with its errors, not an earlier answer', async () => {
  const g = pair()
  const { deps } = setup([scripted([out(
    result({ result: 'Overloaded servers are fine here.' }),
    result({ subtype: 'error_during_execution', is_error: true, result: undefined, errors: ['Tool crashed'] }),
  )])])
  expect(await (await run(g, deps)).outcome()).toEqual({ ok: false, reason: 'The agent stopped with an error: Tool crashed' })
})

test('an exit without a result fails with the tail of stderr, or the exit code', async () => {
  const g = pair()
  const crashed = setup([scripted([
    out(assistant('m1', [{ type: 'text', text: 'working' }])),
    { stream: 'stderr', text: 'Error: connect ECONNRESET\n' },
  ], { code: 1, signal: null })])
  const outcome: NodeOutcome = await (await run(g, crashed.deps)).outcome()
  expect(outcome).toEqual({
    ok: false,
    reason: 'The agent stopped with an error: Error: connect ECONNRESET',
    transient: { kind: 'network', text: 'Error: connect ECONNRESET' },
  })
  const silent = setup([scripted([], { code: 3, signal: null })])
  expect(await (await run(g, silent.deps)).outcome()).toEqual({ ok: false, reason: 'The agent stopped with an error: exit 3' })
})

test('a child that cannot start fails with Could not start Claude Code', async () => {
  const g = pair()
  const thrown = setup([new Error('spawn claude ENOENT')])
  expect(await (await run(g, thrown.deps)).outcome()).toEqual({ ok: false, reason: 'Could not start Claude Code: spawn claude ENOENT' })
  const rejected = setup([scripted([], new Error('spawn claude ENOENT'))])
  expect(await (await run(g, rejected.deps)).outcome()).toEqual({ ok: false, reason: 'Could not start Claude Code: spawn claude ENOENT' })
})

test('Stop mid-stream returns the child and ends the card Stopped.', async () => {
  const g = pair()
  const tracker = createTracker(() => {}, () => 0)
  const child = scripted([out(assistant('m1', [toolUse('t1', 'Bash', { command: 'sleep 99' })]))], 'hang')
  const { deps } = setup([child], { tracker: () => tracker })
  const { started, outcome, estimated } = await run(g, deps)
  // Let the first piece be read.
  await new Promise<void>(resolve => void setTimeout(resolve, 0))
  await started.stop()
  expect(await outcome()).toEqual({ ok: false, reason: 'Stopped.' })
  expect(child.isReturned()).toBe(true)
  // No exact total came: the only cost reported is an estimate.
  expect(estimated).toEqual([true])
  expect(tracker.itemsOf('a').map(i => [i.tool, i.status, i.error])).toEqual([['Bash', 'failed', 'Stopped.']])
})

test('a throwing tracker, cost callback or activity never changes the outcome', async () => {
  const g = pair()
  const boom = () => {
    throw new Error('boom')
  }
  const tracker: Tracker = {
    watch: boom, unwatch: boom, isWatched: boom, callStart: boom, callEnd: boom, childOf: boom, endOpen: boom,
    itemsOf: boom, currentOf: boom, helpersOf: boom, subscribe: boom,
  }
  const { deps } = setup([scripted([out(
    assistant('m1', [toolUse('t1', 'Bash', { command: 'ls' })]),
    toolResult('t1', 'a.txt'),
    result(),
  )])], { tracker: () => tracker })
  const started = await createHeadlessBackend(g, deps).start(g.nodes[0]!, 'go', [], boom)
  expect(await started.done).toEqual({ ok: true, text: 'All done.', files: [] })
})

test('a check card goes to the checks backend', async () => {
  const g = graph([node('k', 'Check 1', { instructionsFile: '', check: { command: 'npm test', timeoutMin: 5 } })])
  const { deps, spawned, checkStarts } = setup([])
  const { outcome } = await run(g, deps)
  expect(await outcome()).toEqual({ ok: true, text: 'passed', files: [] })
  expect(checkStarts).toEqual(['k'])
  expect(spawned).toEqual([])
})
