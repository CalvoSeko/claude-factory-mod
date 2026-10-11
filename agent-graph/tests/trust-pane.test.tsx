import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import type { Graph } from '../types'

// An imported (untrusted) graph with one check card: a run of it spawns that check's command.
const shared = (id: string): Graph => ({
  id, name: 'Shared', description: 'Lints the repo.\nThen reports.', backend: 'local', layout: 2, trusted: false,
  nodes: [{ id: 'k', name: 'Lint', x: 2, y: 1, instructionsFile: '', skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2, check: { command: 'npm run lint', timeoutMin: 5 } }],
  edges: [],
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

let clock: MockClock
let kv = new Map<string, unknown>()
let spawns: string[][] = []
let ends = 0

async function openPane($: Args[0], on: Args[1], g: Graph) {
  kv = new Map<string, unknown>([['graphs', [{ id: g.id, name: g.name }]], [`graph:${g.id}`, g]])
  spawns = []
  ends = 0
  on('store.get', (_$, e) => ({ value: kv.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    kv.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => ({ value: kv.delete((e as unknown as { key: string }).key) }) as never)
  clock = mock.clock(on, { now: 1_000_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_$, e) => {
    if (/finished|was stopped|could not start/.test(String((e as unknown as { text: string }).text))) ends++
    return { value: undefined } as never
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('fs.write', () => ({ value: undefined }) as never)
  on('fs.exists', () => ({ value: false }) as never)
  on('fs.read', () => ({ value: '' }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('ui.message', () => ({ value: undefined }) as never)
  // The check's command: it prints one line and exits 0.
  on('process.spawn', async function* ($$: never, e: never) {
    spawns.push([...(e as { argv: string[] }).argv])
    yield { stream: 'stdout' as const, text: 'ok\n' }
    return { value: { code: 0, signal: null } }
  } as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'agent-graph' })
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // With a task, so a refused run is the trust gate, not a missing task.
  await pane.input({ key: 'task', text: 'Lint it', kind: 'change' })
  return pane
}

const stored = (id: string) => kv.get(`graph:${id}`) as Graph
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))
async function untilEnded() {
  for (let i = 0; i < 300 && ends === 0; i++) {
    await clock.advance(2000)
    await tick()
  }
  expect(ends).toBeGreaterThan(0)
}

test('Run on an imported graph shows the approval view with its command and description, and starts nothing', async ($, on) => {
  const pane = await openPane($, on, shared('t1'))
  expect(await pane.find({ key: 'trust-run' })).toBeUndefined()
  await pane.press({ key: 'run' })
  expect((await pane.find({ key: 'trust-run' }))?.props.label).toBe('Trust and run')
  expect((await pane.find({ key: 'trust-cancel' }))?.props.label).toBe('Cancel')
  expect(await pane.find({ type: 'Text', text: 'Review this imported graph before it runs' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Check "Lint" runs "npm run lint" (timeout 5 min)' })).toBeDefined()
  // The description in full, as a JSON literal: its newline shows as \n.
  expect(await pane.find({ type: 'Text', text: `Description (shown to Claude as the tool's text): "Lints the repo.\\nThen reports."` })).toBeDefined()
  expect(await pane.find({ key: 'stop' })).toBeUndefined()
  expect(spawns).toEqual([])
  await pane.unmount()
})

test('Cancel hides the approval view and the graph stays untrusted', async ($, on) => {
  const pane = await openPane($, on, shared('t2'))
  await pane.press({ key: 'run' })
  await pane.press({ key: 'trust-cancel' })
  expect(await pane.find({ key: 'trust-run' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /npm run lint/ })).toBeUndefined()
  expect(stored('t2').trusted).toBe(false)
  expect(spawns).toEqual([])
  await pane.unmount()
})

test('Trust and run stores the graph as trusted, runs it and closes the view', async ($, on) => {
  const pane = await openPane($, on, shared('t3'))
  await pane.press({ key: 'run' })
  await pane.press({ key: 'trust-run' })
  expect(stored('t3').trusted).toBe(true)
  await untilEnded()
  expect(spawns).toHaveLength(1)
  expect(spawns[0]!.join(' ')).toContain('npm run lint')
  expect(await pane.find({ key: 'trust-run' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'Review this imported graph before it runs' })).toBeUndefined()
  await pane.unmount()
})
