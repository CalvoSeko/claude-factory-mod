import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { ActivityItem } from '../types'
import { BUDGET_CHARS, ERROR_SHORT, MAX_ITEMS, STOPPED_TEXT, UNFINISHED_TEXT, clip, createTracker, summarize } from '../hooks/activity'

function make() {
  let t = 1000
  const changes: string[] = []
  const tracker = createTracker(id => void changes.push(id), () => t)
  return { tracker, changes, at: (n: number) => (t = n) }
}

test('a call starts running and ends ok with its result', () => {
  const { tracker, changes, at } = make()
  tracker.watch('k', 'a')
  const id = tracker.callStart('k', 'Bash', { command: 'npm test' })!
  expect(id).toBeDefined()
  expect(tracker.itemsOf('a')).toMatchObject([{ id, tool: 'Bash', summary: 'npm test', status: 'running', startedAt: 1000, input: '{"command":"npm test"}' }])
  expect(tracker.currentOf('a')).toBe('npm test')
  at(1500)
  tracker.callEnd(id, { ok: true, result: 'passed' })
  expect(tracker.itemsOf('a')[0]).toMatchObject({ status: 'ok', endedAt: 1500, result: 'passed' })
  expect(tracker.currentOf('a')).toBeUndefined()
  expect(changes).toEqual(['a', 'a'])
})

test('a call that failed has its error and a denied one is denied', () => {
  const { tracker } = make()
  tracker.watch('k', 'a')
  const failed = tracker.callStart('k', 'Read', { file_path: '/x' })!
  tracker.callEnd(failed, { ok: false, error: 'ENOENT' })
  const denied = tracker.callStart('k', 'Agent', { description: 'dig' })!
  tracker.callEnd(denied, { ok: false, denied: true, error: 'not allowed' })
  expect(tracker.itemsOf('a')).toMatchObject([
    { status: 'failed', error: 'ENOENT' },
    { status: 'denied', error: 'not allowed' },
  ])
})

test('an agent that is not watched is not recorded, and unwatch stops recording', () => {
  const { tracker, changes } = make()
  expect(tracker.callStart('nobody', 'Bash', { command: 'ls' })).toBeUndefined()
  tracker.watch('k', 'a')
  tracker.callStart('k', 'Bash', { command: 'ls' })
  tracker.unwatch('k')
  expect(tracker.callStart('k', 'Bash', { command: 'pwd' })).toBeUndefined()
  expect(tracker.itemsOf('a')).toHaveLength(1)
  expect(tracker.itemsOf('unknown')).toEqual([])
  expect(changes).toEqual(['a'])
})

test('callEnd with an unknown id, or twice, does nothing', () => {
  const { tracker, changes, at } = make()
  tracker.watch('k', 'a')
  const id = tracker.callStart('k', 'Bash', { command: 'ls' })!
  tracker.callEnd('nope', { ok: true })
  tracker.callEnd(id, { ok: true, result: 'one' })
  at(9000)
  tracker.callEnd(id, { ok: false, error: 'two' })
  expect(tracker.itemsOf('a')[0]).toMatchObject({ status: 'ok', result: 'one', endedAt: 1000 })
  expect(changes).toHaveLength(2)
})

test('a spawned child nests its calls under the parent\'s open Agent call', () => {
  const { tracker } = make()
  tracker.watch('p', 'a')
  const call = tracker.callStart('p', 'Agent', { description: 'research', subagent_type: 'researcher' })!
  expect(tracker.childOf('p', 'c', 'Researcher', 'h')).toBe(call)
  const inner = tracker.callStart('c', 'Grep', { pattern: 'foo' })!
  tracker.callEnd(inner, { ok: true, result: 'hit' })
  tracker.callEnd(call, { ok: true, result: 'done' })
  const [agent] = tracker.itemsOf('a')
  expect(tracker.itemsOf('a')).toHaveLength(1)
  expect(agent).toMatchObject({ tool: 'Agent', summary: 'research', status: 'ok', delegate: { nodeId: 'h', name: 'Researcher' } })
  expect(agent!.delegate!.items).toMatchObject([{ tool: 'Grep', summary: 'foo', status: 'ok' }])
})

test('a child with no open Agent call gets a new delegate item that callEnd closes', () => {
  const { tracker, at } = make()
  tracker.watch('p', 'a')
  const id = tracker.childOf('p', 'c', 'Helper', 'h')!
  expect(tracker.itemsOf('a')).toMatchObject([{ id, tool: 'Helper', summary: 'Helper', status: 'running', delegate: { name: 'Helper', nodeId: 'h', items: [] } }])
  expect(tracker.currentOf('a')).toBe('Helper')
  at(2000)
  tracker.callEnd(id, { ok: true })
  expect(tracker.itemsOf('a')[0]).toMatchObject({ status: 'ok', endedAt: 2000 })
  expect(tracker.childOf('unwatched', 'x', 'Nope')).toBeUndefined()
})

test('calls nest two levels deep and the innermost running call is current', () => {
  const { tracker, changes } = make()
  tracker.watch('p', 'a')
  tracker.callStart('p', 'Agent', { description: 'level one' })
  tracker.childOf('p', 'c1', 'One', 'h1')
  tracker.callStart('c1', 'Agent', { description: 'level two' })
  tracker.childOf('c1', 'c2', 'Two', 'h2')
  const deep = tracker.callStart('c2', 'Bash', { command: 'make' })!
  expect(tracker.currentOf('a')).toBe('make')
  const one = tracker.itemsOf('a')[0]!
  const two = one.delegate!.items[0]!
  expect(two.delegate!.items).toMatchObject([{ tool: 'Bash' }])
  tracker.callEnd(deep, { ok: true })
  expect(tracker.currentOf('a')).toBe('level two')
  // Nested changes are reported for the agent that owns the list.
  expect(new Set(changes)).toEqual(new Set(['a']))
})

test('helpersOf lists helper calls with their caller, times, items and status', () => {
  const { tracker, at } = make()
  tracker.watch('p', 'a')
  const call = tracker.callStart('p', 'Agent', { description: 'go' })!
  tracker.childOf('p', 'c1', 'One', 'h1')
  at(1200)
  tracker.callStart('c1', 'Agent', { description: 'again' })
  tracker.childOf('c1', 'c2', 'Two', 'h2')
  const inner = tracker.callStart('c2', 'Read', { file_path: '/f' })!
  expect(tracker.helpersOf('a')).toMatchObject([
    { nodeId: 'h1', name: 'One', calledBy: 'a', status: 'running', startedAt: 1000, current: '/f' },
    { nodeId: 'h2', name: 'Two', calledBy: 'h1', status: 'running', startedAt: 1200, current: '/f', items: [{ tool: 'Read' }] },
  ])
  at(1800)
  tracker.callEnd(inner, { ok: true })
  tracker.callEnd(call, { ok: false, error: 'boom' })
  const helpers = tracker.helpersOf('a')
  expect(helpers[0]).toMatchObject({ nodeId: 'h1', status: 'failed', endedAt: 1800, error: 'boom', current: 'again' })
  expect(helpers[1]).toMatchObject({ nodeId: 'h2', status: 'running' })
  expect(tracker.helpersOf('none')).toEqual([])
})

test('a helper called twice is one entry; it ends done or failed by its last call', () => {
  const { tracker, at } = make()
  tracker.watch('p', 'a')
  const first = tracker.childOf('p', 'c1', 'H', 'h')!
  at(1100)
  tracker.callEnd(first, { ok: true })
  at(1200)
  const second = tracker.childOf('p', 'c2', 'H', 'h')!
  expect(tracker.helpersOf('a')).toMatchObject([{ nodeId: 'h', status: 'running', startedAt: 1000 }])
  expect(tracker.helpersOf('a')[0]!.endedAt).toBeUndefined()
  at(1300)
  tracker.callEnd(second, { ok: false, error: 'bad' })
  expect(tracker.helpersOf('a')).toMatchObject([{ nodeId: 'h', status: 'failed', startedAt: 1000, endedAt: 1300, error: 'bad' }])
})

test('delegate items without a node id are not helpers', () => {
  const { tracker } = make()
  tracker.watch('p', 'a')
  tracker.childOf('p', 'c', 'Anon')
  expect(tracker.helpersOf('a')).toEqual([])
})

test('the 201st item collapses the oldest into one "earlier calls" item', () => {
  const { tracker } = make()
  tracker.watch('k', 'a')
  for (let i = 1; i <= MAX_ITEMS; i++) tracker.callEnd(tracker.callStart('k', 'Bash', { command: `c${i}` })!, { ok: true })
  expect(tracker.itemsOf('a')).toHaveLength(MAX_ITEMS)
  expect(tracker.itemsOf('a')[0]!.summary).toBe('c1')
  tracker.callEnd(tracker.callStart('k', 'Bash', { command: 'c201' })!, { ok: true })
  const items = tracker.itemsOf('a')
  expect(items).toHaveLength(MAX_ITEMS)
  expect(items[0]).toMatchObject({ tool: '…', summary: '… 2 earlier calls', status: 'ok' })
  expect(items[1]!.summary).toBe('c3')
  expect(items.at(-1)!.summary).toBe('c201')
  tracker.callStart('k', 'Bash', { command: 'c202' })
  expect(tracker.itemsOf('a')[0]!.summary).toBe('… 3 earlier calls')
  expect(tracker.itemsOf('a')).toHaveLength(MAX_ITEMS)
})

test('nested delegate items count toward their delegator', () => {
  const { tracker } = make()
  tracker.watch('p', 'a')
  for (let i = 1; i < MAX_ITEMS; i++) tracker.callEnd(tracker.callStart('p', 'Bash', { command: `b${i}` })!, { ok: true })
  tracker.callStart('p', 'Agent', { description: 'big' })
  tracker.childOf('p', 'c', 'Big', 'h')
  expect(tracker.itemsOf('a')).toHaveLength(MAX_ITEMS)
  for (let i = 0; i < 5; i++) tracker.callStart('c', 'Bash', { command: `n${i}` })
  // 200 calls of the agent's own plus 5 nested: the oldest six collapse into one, leaving 195 + the 5 under the Agent call.
  const items = tracker.itemsOf('a')
  expect(items).toHaveLength(MAX_ITEMS - 5)
  expect(items[0]!.summary).toBe('… 6 earlier calls')
  expect(items.at(-1)!.delegate!.items).toHaveLength(5)
})

test('input and result text past the budget is dropped; summaries stay', () => {
  const { tracker } = make()
  tracker.watch('k', 'a')
  const big = 'x'.repeat(2000)
  const per = Math.ceil(BUDGET_CHARS / 4000)
  for (let i = 0; i < per; i++) {
    const id = tracker.callStart('k', 'Bash', { command: big })!
    tracker.callEnd(id, { ok: true, result: big })
  }
  const late = tracker.callStart('k', 'Bash', { command: 'late command' })!
  tracker.callEnd(late, { ok: true, result: 'late result' })
  const last = tracker.itemsOf('a').at(-1)!
  expect(last).toMatchObject({ summary: 'late command', status: 'ok' })
  expect(last.input).toBeUndefined()
  expect(last.result).toBeUndefined()
  // The first calls kept theirs.
  expect(tracker.itemsOf('a')[0]!.input).toBeDefined()
  expect(tracker.itemsOf('a')[0]!.result).toBe(big)
})

test('input and result are each clipped to 2048 characters', () => {
  const { tracker } = make()
  tracker.watch('k', 'a')
  const id = tracker.callStart('k', 'Write', { file_path: '/f', content: 'y'.repeat(5000) })!
  tracker.callEnd(id, { ok: false, error: 'e'.repeat(5000), result: 'r'.repeat(5000) })
  const item = tracker.itemsOf('a')[0]!
  expect(item.input!.length).toBe(2048)
  expect(item.input!.endsWith('…')).toBe(true)
  expect(item.result!.length).toBe(2048)
  expect(item.error!.length).toBe(2048)
})

test('a string input is kept as it is; an input that cannot be turned into text is dropped', () => {
  const { tracker } = make()
  tracker.watch('k', 'a')
  tracker.callStart('k', 'Bash', 'ls -la')
  const cyclic: Record<string, unknown> = {}
  cyclic['self'] = cyclic
  tracker.callStart('k', 'Odd', cyclic)
  tracker.callStart('k', 'Nothing', undefined)
  expect(tracker.itemsOf('a')).toMatchObject([{ input: 'ls -la', summary: 'ls -la' }, { summary: '' }, { summary: '' }])
  expect(tracker.itemsOf('a')[1]!.input).toBeUndefined()
  expect(tracker.itemsOf('a')[2]!.input).toBeUndefined()
})

test('a listener that throws never breaks the tracker, and subscribe adds and removes listeners', () => {
  const tracker = createTracker(() => { throw new Error('listener') }, () => 1)
  tracker.watch('k', 'a')
  const seen: string[] = []
  const off = tracker.subscribe(id => void seen.push(id))
  expect(() => tracker.callStart('k', 'Bash', { command: 'ls' })).not.toThrow()
  off()
  tracker.callStart('k', 'Bash', { command: 'pwd' })
  expect(seen).toEqual(['a'])
  expect(tracker.itemsOf('a')).toHaveLength(2)
})

test('a clock that throws never breaks the tracker', () => {
  const tracker = createTracker(() => {}, () => { throw new Error('clock') })
  tracker.watch('k', 'a')
  expect(() => tracker.callStart('k', 'Bash', { command: 'ls' })).not.toThrow()
})

test('summaries: Bash is the first line of the command', () => {
  expect(summarize('Bash', { command: 'npm test\nnpm run build' })).toBe('npm test')
  expect(summarize('Bash', { command: '  git   status  ' })).toBe('git status')
})

test('summaries: file tools use file_path', () => {
  for (const tool of ['Read', 'Write', 'Edit', 'NotebookEdit']) expect(summarize(tool, { file_path: '/a/b.ts', content: 'z' })).toBe('/a/b.ts')
})

test('summaries: Grep is pattern, with " in " and the path when set', () => {
  expect(summarize('Grep', { pattern: 'foo' })).toBe('foo')
  expect(summarize('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src')
})

test('summaries: Glob, WebFetch and WebSearch', () => {
  expect(summarize('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  expect(summarize('WebFetch', { url: 'https://x.test', prompt: 'p' })).toBe('https://x.test')
  expect(summarize('WebSearch', { query: 'cats' })).toBe('cats')
})

test('summaries: Agent is the description, else the subagent type', () => {
  expect(summarize('Agent', { description: 'dig in', subagent_type: 'explorer' })).toBe('dig in')
  expect(summarize('Agent', { subagent_type: 'explorer', prompt: 'long' })).toBe('explorer')
})

test('summaries: an mcp tool is server/tool and the first string argument', () => {
  expect(summarize('mcp__github__search_issues', { limit: 5, query: 'bug' })).toBe('github/search_issues bug')
  expect(summarize('mcp__github__search_issues', { limit: 5 })).toBe('github/search_issues')
  expect(summarize('mcp__srv__a__b', { q: 'x' })).toBe('srv/a__b x')
})

test('summaries: any other tool is the first string field, else empty', () => {
  expect(summarize('Custom', { n: 1, text: 'hello', other: 'later' })).toBe('hello')
  expect(summarize('Custom', { n: 1 })).toBe('')
  expect(summarize('Custom', 'plain')).toBe('plain')
  expect(summarize('Custom', null)).toBe('')
  expect(summarize('Bash', {})).toBe('')
})

test('summaries: whitespace is collapsed and the line is clipped to 80 with an ellipsis', () => {
  expect(summarize('Custom', { t: 'a \t b\n\n c' })).toBe('a b c')
  const long = summarize('Bash', { command: 'z'.repeat(200) })
  expect(long.length).toBe(80)
  expect(long.endsWith('…')).toBe(true)
  expect(summarize('Bash', { command: 'z'.repeat(80) })).toBe('z'.repeat(80))
})

test('clip keeps text up to the limit and ends longer text with an ellipsis', () => {
  expect(clip('abc', 3)).toBe('abc')
  expect(clip('abcd', 3)).toBe('ab…')
  expect(clip('', 5)).toBe('')
})

const countOf = (items: ActivityItem[]): number => items.reduce((sum, i) => sum + 1 + countOf(i.delegate?.items ?? []), 0)

test('one Agent call with a thousand nested calls stays within the limit', () => {
  const { tracker } = make()
  tracker.watch('p', 'a')
  const call = tracker.callStart('p', 'Agent', { description: 'busy' })!
  tracker.childOf('p', 'c', 'Busy', 'h')
  for (let i = 0; i < 1000; i++) tracker.callEnd(tracker.callStart('c', 'Bash', { command: `n${i}` })!, { ok: true })
  expect(countOf(tracker.itemsOf('a'))).toBeLessThanOrEqual(MAX_ITEMS)
  const [agent] = tracker.itemsOf('a')
  expect(tracker.itemsOf('a')).toHaveLength(1)
  expect(agent).toMatchObject({ id: call, status: 'running' })
  expect(agent!.delegate!.items[0]!.summary).toMatch(/^… \d+ earlier calls$/)
  expect(agent!.delegate!.items.at(-1)!.summary).toBe('n999')
  // The helper's entry follows the bounded list and ends normally.
  tracker.callEnd(call, { ok: true })
  expect(tracker.helpersOf('a')).toMatchObject([{ nodeId: 'h', status: 'done' }])
  expect(tracker.helpersOf('a')[0]!.items.length).toBeLessThanOrEqual(MAX_ITEMS)
})

test('open delegate items are never merged away, whatever the overflow', () => {
  const { tracker } = make()
  tracker.watch('p', 'a')
  const one = tracker.callStart('p', 'Agent', { description: 'one' })!
  const two = tracker.callStart('p', 'Agent', { description: 'two' })!
  tracker.childOf('p', 'c1', 'One', 'h1')
  tracker.childOf('p', 'c2', 'Two', 'h2')
  for (let i = 0; i < 150; i++) {
    tracker.callEnd(tracker.callStart('c1', 'Bash', { command: `a${i}` })!, { ok: true })
    tracker.callEnd(tracker.callStart('c2', 'Bash', { command: `b${i}` })!, { ok: true })
  }
  expect(countOf(tracker.itemsOf('a'))).toBeLessThanOrEqual(MAX_ITEMS)
  expect(tracker.itemsOf('a').map(i => [i.id, i.status])).toEqual([[one, 'running'], [two, 'running']])
  expect(tracker.helpersOf('a').map(h => [h.nodeId, h.status])).toEqual([['h1', 'running'], ['h2', 'running']])
  tracker.callEnd(one, { ok: true })
  tracker.callEnd(two, { ok: false, error: 'x' })
  expect(tracker.helpersOf('a').map(h => [h.nodeId, h.status])).toEqual([['h1', 'done'], ['h2', 'failed']])
})

test('a finished call with a running call under it is not folded', () => {
  const { tracker } = make()
  tracker.watch('p', 'a')
  const outer = tracker.callStart('p', 'Agent', { description: 'outer' })!
  tracker.childOf('p', 'c', 'Outer', 'h')
  tracker.callStart('c', 'Bash', { command: 'still going' })
  tracker.callEnd(outer, { ok: true })
  for (let i = 0; i < 250; i++) tracker.callEnd(tracker.callStart('p', 'Read', { file_path: `/f${i}` })!, { ok: true })
  expect(tracker.itemsOf('a')[0]).toMatchObject({ id: outer, status: 'ok' })
  expect(tracker.itemsOf('a')[0]!.delegate!.items).toMatchObject([{ summary: 'still going', status: 'running' }])
  expect(countOf(tracker.itemsOf('a'))).toBeLessThanOrEqual(MAX_ITEMS)
})

test('clip does not cut a surrogate pair in two', () => {
  const text = `ab${'😀'}cd`
  expect(clip(text, 4)).toBe('ab…')
  expect(clip(text, 5)).toBe('ab😀…')
})

const keptText = (items: ActivityItem[]): number =>
  items.reduce((sum, i) => sum + (i.input?.length ?? 0) + (i.result?.length ?? 0) + (i.error?.length ?? 0) + keptText(i.delegate?.items ?? []), 0)

test('error text counts toward the budget; once it is spent an error keeps a short line', () => {
  const { tracker } = make()
  tracker.watch('k', 'a')
  const long = `exit 1: ${'e'.repeat(5000)}`
  for (let i = 0; i < 200; i++) tracker.callEnd(tracker.callStart('k', 'Bash', { command: `${'x'.repeat(1500)} "${i}"` })!, { ok: false, error: long })
  const items = tracker.itemsOf('a')
  expect(items).toHaveLength(200)
  expect(keptText(items)).toBeLessThanOrEqual(BUDGET_CHARS + items.length * ERROR_SHORT)
  // The red row still says why.
  expect(items.at(-1)!.error!.length).toBeLessThanOrEqual(ERROR_SHORT)
  expect(items.at(-1)!.error!.startsWith('exit 1: eee')).toBe(true)
  expect(JSON.stringify(items).length).toBeLessThan(250_000)
})

test('endOpen ends every open call of an agent, nested ones too, as failed with the reason', () => {
  const { tracker, at } = make()
  tracker.watch('p', 'a')
  tracker.watch('q', 'b')
  const bash = tracker.callStart('p', 'Bash', { command: 'sleep 99' })!
  const agent = tracker.callStart('p', 'Agent', { description: 'ask' })!
  tracker.childOf('p', 'c', 'Helper', 'h')
  const inner = tracker.callStart('c', 'Read', { file_path: '/f' })!
  const done = tracker.callStart('p', 'Glob', { pattern: '*' })!
  tracker.callEnd(done, { ok: true })
  const other = tracker.callStart('q', 'Bash', { command: 'elsewhere' })!
  at(5000)
  tracker.endOpen(STOPPED_TEXT, 'a')
  expect(tracker.itemsOf('a').map(i => [i.id, i.status, i.error, i.endedAt])).toEqual([
    [bash, 'failed', 'Stopped.', 5000],
    [agent, 'failed', 'Stopped.', 5000],
    [done, 'ok', undefined, 1000],
  ])
  expect(tracker.itemsOf('a')[1]!.delegate!.items).toMatchObject([{ id: inner, status: 'failed', error: 'Stopped.', endedAt: 5000 }])
  expect(tracker.currentOf('a')).toBeUndefined()
  // A stopped helper is cancelled, not failed.
  expect(tracker.helpersOf('a')).toMatchObject([{ nodeId: 'h', status: 'cancelled', error: 'Stopped.', endedAt: 5000 }])
  // Another agent's call is left alone; a late end changes nothing.
  expect(tracker.itemsOf('b')[0]!.status).toBe('running')
  tracker.callEnd(bash, { ok: true, result: 'late' })
  expect(tracker.itemsOf('a')[0]).toMatchObject({ status: 'failed', error: 'Stopped.' })
  expect(tracker.itemsOf('a')[0]!.result).toBeUndefined()
  // Without an agent it ends every agent's open calls.
  tracker.endOpen(UNFINISHED_TEXT)
  expect(tracker.itemsOf('b')).toMatchObject([{ id: other, status: 'failed', error: 'Not finished when the run ended.' }])
})

test('a helper whose call was not finished when the run ended is failed', () => {
  const { tracker } = make()
  tracker.watch('p', 'a')
  tracker.childOf('p', 'c', 'Helper', 'h')
  tracker.endOpen(UNFINISHED_TEXT, 'a')
  expect(tracker.helpersOf('a')).toMatchObject([{ nodeId: 'h', status: 'failed', error: UNFINISHED_TEXT }])
})

test('a spawn adopts the Agent call whose id it is given, else the oldest open one', () => {
  const { tracker } = make()
  tracker.watch('p', 'a')
  const one = tracker.callStart('p', 'Agent', { description: 'one' })!
  const two = tracker.callStart('p', 'Agent', { description: 'two' })!
  expect(tracker.childOf('p', 'c2', 'Two', 'h2', two)).toBe(two)
  expect(tracker.childOf('p', 'c1', 'One', 'h1', one)).toBe(one)
  expect(tracker.itemsOf('a').map(i => [i.id, i.delegate?.nodeId])).toEqual([[one, 'h1'], [two, 'h2']])
  const three = tracker.callStart('p', 'Agent', { description: 'three' })!
  expect(tracker.childOf('p', 'c3', 'Three', 'h3', 'no-such-call')).toBe(three)
})

test('folding refunds the folded calls\' text: after 250 calls the newest still keep input and result', () => {
  const { tracker } = make()
  tracker.watch('k', 'a')
  for (let i = 0; i < 250; i++) tracker.callEnd(tracker.callStart('k', 'Bash', { command: `call ${i} ${'x'.repeat(400)}` })!, { ok: true, result: 'r'.repeat(600) })
  const items = tracker.itemsOf('a')
  expect(items.at(-1)!.summary).toMatch(/^call 249 /)
  expect(items.at(-1)!.input).toBeDefined()
  expect(items.at(-1)!.result).toBe('r'.repeat(600))
  expect(keptText(items)).toBeLessThanOrEqual(BUDGET_CHARS)
})
