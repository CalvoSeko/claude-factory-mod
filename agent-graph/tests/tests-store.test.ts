import { expect } from 'claude-code/testing'
import { test } from './kit'

import { inGraphFolder, type TextFiles } from '../hooks/library'
import { createTestStore, gradePrompt, parseVerdict, testName } from '../hooks/tests'
import type { TestCase } from '../types'

const memory = () => {
  const map = new Map<string, string>()
  // Like the mod's own adapter, a change outside the graph's folder does nothing.
  const files: TextFiles = {
    read: async path => map.get(path),
    write: async (graphId, path, text) => void (inGraphFolder('/root', graphId, path) && map.set(path, text)),
    remove: async (graphId, path) => void (inGraphFolder('/root', graphId, path) && map.delete(path)),
    removeDir: async graphId => void [...map.keys()].filter(k => k.startsWith(`/root/${graphId}/`)).forEach(k => map.delete(k)),
  }
  return { map, files }
}

const sample = (patch: Partial<TestCase> = {}): TestCase => ({
  id: 't1', name: 'Write a haiku', task: 'Write a haiku about autumn', expected: 'Leaves fall slowly down', mustHold: '', createdAt: 5, fromRun: 'r1', ...patch,
})

test('tests round-trip through the file of their graph', async () => {
  const { map, files } = memory()
  const store = createTestStore(files, '/root')
  expect(await store.list('g1')).toEqual([])
  const tests = [sample(), sample({ id: 't2', last: { verdict: 'pass', reason: 'Fine.', runId: 'r2', at: 9, result: 'Leaves fall' } })]
  await store.save('g1', tests)
  expect([...map.keys()]).toEqual(['/root/g1/tests.json'])
  expect(await store.list('g1')).toEqual(tests)
  expect(await store.list('g2')).toEqual([])
})

test('an unreadable or malformed tests file is no tests', async () => {
  const { map, files } = memory()
  const store = createTestStore(files, '/root')
  map.set('/root/g1/tests.json', '{ not json')
  expect(await store.list('g1')).toEqual([])
  map.set('/root/g1/tests.json', '{"id":"t1"}')
  expect(await store.list('g1')).toEqual([])
  map.set('/root/g1/tests.json', '[null, 3, {"id":"t1"}, {"id":"t2","name":"n","task":"t","expected":"e","mustHold":"","createdAt":1,"fromRun":"r"}]')
  expect((await store.list('g1')).map(t => t.id)).toEqual(['t2'])
  const broken: TextFiles = { ...files, read: async () => { throw new Error('locked') } }
  expect(await createTestStore(broken, '/root').list('g1')).toEqual([])
})

test('removing a graph removes its tests file', async () => {
  const { map, files } = memory()
  const store = createTestStore(files, '/root')
  await store.save('g1', [sample()])
  await store.removeGraph('g1')
  expect(map.size).toBe(0)
})

test('a test is named by the first line of its task, clipped to 40', () => {
  expect(testName('\n  Write a haiku  \nabout autumn')).toBe('Write a haiku')
  expect(testName('x'.repeat(50))).toBe(`${'x'.repeat(39)}…`)
  expect(testName('x'.repeat(40))).toBe('x'.repeat(40))
  expect(testName('  \n ')).toBe('')
})

test('parseVerdict reads the first JSON object in the reply', () => {
  expect(parseVerdict('{"pass": true, "reason": "Same content."}')).toEqual({ verdict: 'pass', reason: 'Same content.' })
  expect(parseVerdict('Here is my verdict:\n```json\n{"pass": false, "reason": "Misses {the point}."}\n```\nHope it helps.')).toEqual({ verdict: 'fail', reason: 'Misses {the point}.' })
  expect(parseVerdict('{"pass": true}')).toEqual({ verdict: 'pass', reason: '' })
})

test('parseVerdict gives undefined for anything that is not a verdict', () => {
  expect(parseVerdict('')).toBeUndefined()
  expect(parseVerdict('It passes.')).toBeUndefined()
  expect(parseVerdict('{"pass": true, "reason": ')).toBeUndefined()
  expect(parseVerdict('{"pass": "yes", "reason": "x"}')).toBeUndefined()
  expect(parseVerdict('{"verdict": "pass"}')).toBeUndefined()
  expect(parseVerdict('[true]')).toBeUndefined()
})

test('the grading prompt holds the task, the accepted result, the new result and the must-hold notes', () => {
  const prompt = gradePrompt(sample({ mustHold: 'Exactly three lines' }), 'Brown leaves drift down')
  for (const part of ['Write a haiku about autumn', 'Leaves fall slowly down', 'Brown leaves drift down', 'Exactly three lines', '"pass"']) expect(prompt).toContain(part)
  // No notes: the prompt says so.
  expect(gradePrompt(sample(), 'x')).toContain('(none)')
})

test('the grading prompt clips each text at 20 000 characters', () => {
  const prompt = gradePrompt(sample({ task: 'T'.repeat(30_000), expected: 'E'.repeat(30_000), mustHold: 'M'.repeat(30_000) }), 'R'.repeat(30_000))
  for (const c of ['T', 'E', 'R', 'M']) {
    expect(prompt).toContain(c.repeat(20_000))
    expect(prompt).not.toContain(c.repeat(20_001))
  }
})
