import { expect, mock, type MockClock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

import { stashed, stashText, toolName, transcriptOf } from '../hooks/actions'
import { INSTRUCTIONS_TEMPLATE } from '../hooks/model'
import type { AgentNode, Graph, RunView } from '../types'

const node = (id: string, name: string, x: number, y = 1): AgentNode => ({
  id, name, x, y, instructionsFile: '', skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
// An agent's instructions file, in its graph's own folder under the home these tests give (USERPROFILE).
const HOME = '/home/u'
const fileOf = (graphId: string, id: string) => `${HOME}/.claude/agent-graph/${graphId}/${id}.md`
const flow = (id: string, nodes: AgentNode[], edges: Graph['edges'] = []): Graph => ({
  id, name: 'Flow', description: '', backend: 'local', layout: 2, nodes: nodes.map(n => ({ ...n, instructionsFile: fileOf(id, n.id) })), edges,
})
const BAND = {
  plugin: 'agent-graph', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const
const PANE = {
  plugin: 'agent-graph', component: 'Pane', requestId: 'agent-graph',
  props: { title: 'Agent Graph', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Args = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>
type Pane = Awaited<ReturnType<typeof openPane>>

let clock: MockClock
// Instructions files by path: what fs.exists / fs.read / fs.write / `rm -f` see.
let files = new Map<string, string>()
const toasts: string[] = []
let spawned = 0
// The mock file system answers Windows-style paths; the map is keyed by the plain ones.
const norm = (path: string) => path.replace(/[\\]/g, '/').replace(/^[A-Za-z]:/, '')
let ran: string[][] = []
// The tools registered since the pane opened (name, description, isDeferred).
let registered: Array<{ name: string; description?: string; isDeferred?: boolean }> = []
// The plugin's store, so a test can read what was saved (each write a copy, as the engine keeps it).
let stored = new Map<string, unknown>()

// The module keeps undo stacks per graph id and every test in this file shares it, so each test uses its own graph id.
async function openPane($: Args[0], on: Args[1], g: Graph, content: (path: string) => string | undefined = () => 'Do the work.', others: Graph[] = []) {
  stored = new Map<string, unknown>([
    ['graphs', [g, ...others].map(x => ({ id: x.id, name: x.name }))],
    ...[g, ...others].map(x => [`graph:${x.id}`, x] as const),
  ])
  on('store.get', (_$, e) => ({ value: stored.get(e.key) }) as never)
  on('store.set', (_$, e) => {
    stored.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => {
    stored.delete(e.key)
    return { value: undefined } as never
  })
  clock = mock.clock(on)
  files = new Map(g.nodes.flatMap(n => (content(n.instructionsFile) === undefined ? [] : [[n.instructionsFile, content(n.instructionsFile)!] as const])))
  toasts.length = 0
  spawned = 0
  ran = []
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as unknown as { text: string }).text))
    return { value: undefined } as never
  })
  on('fs.write', (_$, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    files.set(norm(path), text)
    return { value: undefined } as never
  })
  on('fs.exists', (_$, e) => ({ value: files.has(norm((e as unknown as { path: string }).path)) }) as never)
  on('fs.read', (_$, e) => ({ value: files.get(norm((e as unknown as { path: string }).path)) ?? '' }) as never)
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    ran.push(argv)
    if (argv[0] === 'rm') {
      // The mock file system resolves a relative path to the working directory for the other hooks, not for this one.
      const target = norm(argv[argv.length - 1]!).replace(/^\.\//, '')
      for (const key of [...files.keys()]) if (key === target || key.endsWith(`/${target}`)) files.delete(key)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('tool.register', (_$, e) => {
    registered.push(e as unknown as (typeof registered)[number])
    return { value: undefined } as never
  })
  on('agent.register', () => ({ value: undefined }) as never)
  on('agent.spawn', () => ({ model: 'm', agentId: `ag${++spawned}` }) as never)
  on('env.get', (_$, e) => ({ value: (e as unknown as { name: string }).name === 'USERPROFILE' ? HOME : undefined }) as never)
  on('ui.message', () => ({ value: undefined }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'agent-graph' })
  await band.unmount()
  registered = []
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

type Card = { id: string; name: string; x: number; y: number; disabled: boolean; warn: boolean; glyph: string; line: string }
const cardsOfPane = async (pane: Pane): Promise<Card[]> => JSON.parse(JSON.stringify((await pane.find({ key: 'canvas' }))?.props)).props.cards as Card[]
const namesOf = async (pane: Pane) => (await cardsOfPane(pane)).map(c => c.name)
const edgesOfPane = async (pane: Pane) =>
  JSON.parse(JSON.stringify((await pane.find({ key: 'canvas' }))?.props)).props.edges as Array<{ from: string; to: string; kind: string }>
const key = (pane: Pane, k: string, mods: { ctrl?: boolean; shift?: boolean } = {}) => pane.post({ events: [{ kind: 'key', key: k, ...mods }] })
const selectedName = async (pane: Pane) => {
  for (const c of await cardsOfPane(pane)) if ((await pane.find({ key: `name-${c.id}` })) !== undefined) return c.name
  return undefined
}

test('a spawn drag creates a connected, selected agent at the drop spot', async ($, on) => {
  const pane = await openPane($, on, flow('g-spawn', [node('a', 'Researcher', 2), node('b', 'Writer', 40)]))
  await pane.post({ events: [{ kind: 'spawn', from: 'a', x: 30, y: 12 }] })
  const created = (await cardsOfPane(pane)).find(c => c.name === 'Agent 3')
  expect(created).toMatchObject({ x: 28, y: 10 })
  expect((await edgesOfPane(pane)).some(e => e.from === 'a' && e.to === created!.id && e.kind === 'handoff')).toBe(true)
  expect(await pane.find({ key: `name-${created!.id}` })).toBeDefined()
  expect([...files.keys()].some(k => k.includes(created!.id))).toBe(true)
  await key(pane, 'z', { ctrl: true })
  expect(await namesOf(pane)).toEqual(['Researcher', 'Writer'])
  await pane.unmount()
})

test('a spawn near the corner stays on the canvas', async ($, on) => {
  const pane = await openPane($, on, flow('g-spawn0', [node('a', 'Researcher', 60, 20)]))
  await pane.post({ events: [{ kind: 'spawn', from: 'a', x: 1, y: 0 }] })
  expect((await cardsOfPane(pane)).find(c => c.name === 'Agent 2')).toMatchObject({ x: 0, y: 0 })
  await pane.unmount()
})

test('tab and shift-tab walk the cards in reading order', async ($, on) => {
  const g = flow('g-tab', [node('a', 'Alpha', 30, 1), node('b', 'Bravo', 2, 8), node('c', 'Charlie', 2, 1)])
  const pane = await openPane($, on, g)
  const order: Array<string | undefined> = []
  for (let i = 0; i < 4; i++) {
    await key(pane, 'tab')
    order.push(await selectedName(pane))
  }
  expect(order).toEqual(['Charlie', 'Alpha', 'Bravo', 'Charlie'])
  await key(pane, 'tab', { shift: true })
  expect(await selectedName(pane)).toBe('Bravo')
  await key(pane, 'tab', { shift: true })
  expect(await selectedName(pane)).toBe('Alpha')
  await pane.unmount()
})

test('d toggles the selected agent between disabled and enabled', async ($, on) => {
  const pane = await openPane($, on, flow('g-dis', [node('a', 'Researcher', 2), node('b', 'Writer', 40)], [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }]))
  await key(pane, 'tab')
  expect((await pane.find({ key: 'disable-a' }))?.props.label).toBe('Disable')
  await key(pane, 'd')
  const [a] = await cardsOfPane(pane)
  expect(a).toMatchObject({ disabled: true, glyph: '◌', line: 'disabled · passes input through' })
  expect((await pane.find({ key: 'disable-a' }))?.props.label).toBe('Enable')
  await key(pane, 'd')
  expect((await cardsOfPane(pane))[0]).toMatchObject({ disabled: false })
  await pane.press({ key: 'disable-a' })
  expect((await cardsOfPane(pane))[0]).toMatchObject({ disabled: true })
  await pane.unmount()
})

test('the inspector saves the when-to-use text', async ($, on) => {
  const pane = await openPane($, on, flow('g-when', [node('a', 'Researcher', 2)]))
  await key(pane, 'tab')
  const input = await pane.find({ key: 'when-a' })
  expect(String(input?.props.label)).toContain('When to use')
  await pane.input({ key: 'when-a', text: 'Call me for sources', kind: 'submit' })
  expect((await pane.find({ key: 'when-a' }))?.props.value).toBe('Call me for sources')
  await pane.unmount()
})

test('return opens the selected agent instructions', async ($, on) => {
  const pane = await openPane($, on, flow('g-ret', [node('a', 'Researcher', 2)]))
  await key(pane, 'return')
  expect(ran).toEqual([])
  await key(pane, 'tab')
  await key(pane, 'return')
  expect(ran.some(argv => argv.some(part => part.includes('a.md')))).toBe(true)
  await pane.unmount()
})

test('undo and redo walk a rename; a new edit clears redo', async ($, on) => {
  const pane = await openPane($, on, flow('g-undo', [node('a', 'Researcher', 2), node('b', 'Writer', 40)]))
  await key(pane, 'tab')
  await key(pane, 'tab')
  await key(pane, 'tab', { shift: true })
  expect(await selectedName(pane)).toBe('Researcher')
  await pane.input({ key: 'name-a', text: 'Reader', kind: 'submit' })
  expect(await namesOf(pane)).toEqual(['Reader', 'Writer'])
  await key(pane, 'z', { ctrl: true })
  expect(await namesOf(pane)).toEqual(['Researcher', 'Writer'])
  await key(pane, 'z', { ctrl: true, shift: true })
  expect(await namesOf(pane)).toEqual(['Reader', 'Writer'])
  await key(pane, 'z', { ctrl: true })
  await key(pane, 'y', { ctrl: true })
  expect(await namesOf(pane)).toEqual(['Reader', 'Writer'])
  await key(pane, 'z', { ctrl: true })
  await pane.input({ key: 'name-a', text: 'Scout', kind: 'submit' })
  await key(pane, 'y', { ctrl: true })
  expect(await namesOf(pane)).toEqual(['Scout', 'Writer'])
  await key(pane, 'z', { ctrl: true })
  await key(pane, 'z', { ctrl: true })
  await key(pane, 'z', { ctrl: true })
  expect(await namesOf(pane)).toEqual(['Researcher', 'Writer'])
  await pane.unmount()
})

test('undoing a delete brings the agent back with its instructions text', async ($, on) => {
  const g = flow('g-del', [node('a', 'Researcher', 2), node('b', 'Writer', 40)], [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }])
  const pane = await openPane($, on, g, path => (path === fileOf('g-del', 'b') ? 'Write like Orwell.' : 'Research.'))
  await pane.post({ events: [{ kind: 'press', node: 'b', action: 'delete' }] })
  expect(await namesOf(pane)).toEqual(['Researcher'])
  expect(files.has(fileOf('g-del', 'b'))).toBe(false)
  await key(pane, 'z', { ctrl: true })
  expect(await namesOf(pane)).toEqual(['Researcher', 'Writer'])
  expect(await edgesOfPane(pane)).toHaveLength(1)
  expect(files.get(fileOf('g-del', 'b'))).toBe('Write like Orwell.')
  await key(pane, 'y', { ctrl: true })
  expect(await namesOf(pane)).toEqual(['Researcher'])
  await pane.unmount()
})

test('undoing a delete whose file was never read falls back to the starter template', async ($, on) => {
  const pane = await openPane($, on, flow('g-del2', [node('a', 'Researcher', 2)]), () => undefined)
  await pane.post({ events: [{ kind: 'press', node: 'a', action: 'delete' }] })
  expect(await namesOf(pane)).toEqual([])
  await key(pane, 'z', { ctrl: true })
  expect(await namesOf(pane)).toEqual(['Researcher'])
  expect(files.get(fileOf('g-del2', 'a'))).toBe(INSTRUCTIONS_TEMPLATE('Researcher'))
  await pane.unmount()
})

test('the kind picker shows a handoff that would make a loop as plain text with the reason', async ($, on) => {
  const pane = await openPane($, on, flow('g-kind', [node('a', 'Researcher', 2), node('b', 'Writer', 40)], [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }]))
  await pane.post({ events: [{ kind: 'wire', from: 'b', to: 'a' }] })
  expect(await pane.find({ key: 'as-handoff' })).toBeUndefined()
  expect(await pane.find({ text: /Handoff ━► — Handoff arrows form a loop/ })).toBeDefined()
  expect(await pane.find({ key: 'as-delegate' })).toBeDefined()
  await pane.unmount()
})

test('the problems list selects the agent a problem is about, and Run stays withheld', async ($, on) => {
  const pane = await openPane($, on, flow('g-prob', [node('a', 'Same', 2), node('b', 'Same', 40)]))
  expect(await pane.find({ key: 'run' })).toBeUndefined()
  expect(await pane.find({ text: /fix 2 problems/ })).toBeDefined()
  expect((await pane.find({ key: 'problem-1' }))?.props.label).toBe('! Same: Another agent is also called "Same".')
  await pane.press({ key: 'problem-1' })
  expect(await selectedName(pane)).toBe('Same')
  expect(await pane.find({ key: 'name-b' })).toBeDefined()
  expect(await pane.find({ key: 'name-a' })).toBeUndefined()
  await pane.unmount()
})

test('with every agent disabled the problems list says so', async ($, on) => {
  const g = flow('g-alloff', [{ ...node('a', 'Researcher', 2), disabled: true }, { ...node('b', 'Writer', 40), disabled: true }], [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }])
  const pane = await openPane($, on, g)
  expect((await pane.find({ key: 'problem-0' }))?.props.label).toBe('! Every agent is disabled.')
  expect(await pane.find({ text: /Add at least one agent/ })).toBeUndefined()
  expect(await pane.find({ key: 'run' })).toBeUndefined()
  await pane.unmount()
})

test('an empty graph still asks for an agent', async ($, on) => {
  const pane = await openPane($, on, flow('g-empty', []))
  expect((await pane.find({ key: 'problem-0' }))?.props.label).toBe('! Add at least one agent.')
  await pane.unmount()
})

test('warnings are listed under the toolbar while Run stays available', async ($, on) => {
  const g = flow('g-warn', [node('a', 'Researcher', 2), { ...node('b', 'Writer', 40), whenToUse: '' }], [{ id: 'e1', from: 'a', to: 'b', kind: 'delegate' }])
  const pane = await openPane($, on, g, path => (path === fileOf('g-warn', 'a') ? INSTRUCTIONS_TEMPLATE('Researcher') : 'Write well.'))
  expect(await pane.find({ key: 'run' })).toBeDefined()
  const warnings = (await pane.findAll({ type: 'Button' })).filter(b => String(b.props.label).startsWith('△'))
  expect(warnings.map(b => b.props.label)).toEqual([
    '△ Researcher: The instructions are still the starter template.',
    '△ Writer: Add a "when to use" description so the agents that delegate to it know when to call it.',
  ])
  expect((await cardsOfPane(pane)).map(c => c.warn)).toEqual([true, true])
  await pane.press({ key: 'warning-1' })
  expect(await pane.find({ key: 'name-b' })).toBeDefined()
  await pane.unmount()
})

// A hook-answered agent.spawn starts no agent (the engine leaves agentId to core), so this run ends at once, with the first agent failed.
test('Save transcript writes the run as markdown next to the outputs', async ($, on) => {
  const pane = await openPane($, on, flow('g-tr', [node('a', 'Researcher', 2), node('b', 'Writer', 40)], [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }]))
  expect(await pane.find({ key: 'save-transcript' })).toBeUndefined()
  await pane.input({ key: 'task', text: 'Summarise the news', kind: 'change' })
  await pane.press({ key: 'run' })
  await clock.advance(16)
  await pane.press({ key: 'save-transcript' })
  const [path, text] = [...files.entries()].find(([p]) => p.endsWith('/transcript.md')) ?? []
  expect(path).toMatch(/agent-graph-outputs\/flow\/[^/]+\/transcript\.md$/)
  expect(text).toMatch(/^# Flow — \d{4}-\d{2}-\d{2}\n\nSummarise the news\n/)
  expect(text!.indexOf('## Researcher')).toBeGreaterThan(-1)
  expect(text!.indexOf('## Researcher')).toBeLessThan(text!.indexOf('## Writer'))
  expect(text).toMatch(/failed · \d+:\d{2}/)
  expect(text).toContain('Error: The agent did not start.')
  expect(text!.indexOf('## Result')).toBeGreaterThan(text!.indexOf('## Writer'))
  expect(toasts.some(t => t.startsWith('Saved the transcript to agent-graph-outputs/flow/'))).toBe(true)
  await pane.unmount()
})

test('a transcript lists the agents in start order with status, time and cost', async () => {
  const g = flow('g-tr2', [node('a', 'Researcher', 2), node('b', 'Writer', 40), node('c', 'Checker', 2, 9)])
  const run: RunView = {
    graphId: 'g-tr2', graphName: 'Flow', isRunning: false, task: 'Do it', result: 'All done.',
    nodes: {
      a: { status: 'done', output: 'Found 3.', startedAt: 5000, endedAt: 65000, costUsd: 0.5 },
      b: { status: 'skipped' },
      c: { status: 'done', output: 'Looks fine.', startedAt: 1000, endedAt: 4000 },
    },
  }
  const parts = ['# Flow — 2026-10-08', 'Do it', '## Checker', 'done · 0:03', 'Looks fine.', '## Researcher', 'done · 1:00 · $0.50', 'Found 3.', '## Writer', 'skipped', '## Result' + String.fromCharCode(10, 10) + 'All done.']
  expect(transcriptOf(g, run, '2026-10-08')).toBe(parts.join(String.fromCharCode(10, 10)) + String.fromCharCode(10))
})

// ---- editing, undo and tool registration ----

const OTHER = (id: string): Graph => ({ ...flow(id, [node('o', 'Other agent', 2)]), name: 'Other' })

test('an edit that changes nothing saves nothing', async ($, on) => {
  const pane = await openPane($, on, flow('g-noop', [node('a', 'Researcher', 2), node('b', 'Writer', 40)], [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }]))
  const before = stored.get('graph:g-noop')
  await pane.post({ events: [{ kind: 'edge', edge: 'missing', action: 'retype' }] })
  expect(stored.get('graph:g-noop')).toBe(before)
  await pane.post({ events: [{ kind: 'edge', edge: 'e1', action: 'retype' }] })
  expect((stored.get('graph:g-noop') as Graph).edges[0]!.kind).not.toBe('handoff')
  await pane.unmount()
})

test('a commit with an unchanged run tool registers nothing', async ($, on) => {
  const g = flow('g-reg', [node('a', 'Researcher', 2)])
  const pane = await openPane($, on, g, undefined, [OTHER('g-reg-other')])
  await key(pane, 'tab')
  await key(pane, 'right')
  expect((stored.get('graph:g-reg') as Graph).nodes[0]!.x).not.toBe(2)
  expect(registered).toEqual([])
  await pane.unmount()
})

test('deleting a graph replaces its tool with a deferred "deleted" one', async ($, on) => {
  const g = flow('g-delreg', [node('a', 'Researcher', 2)])
  const pane = await openPane($, on, g, undefined, [OTHER('g-delreg-other')])
  await pane.press({ key: 'delete-graph' })
  const stale = registered.filter(r => r.name === toolName(g))
  expect(stale).toHaveLength(1)
  expect(stale[0]!.description).toMatch(/was deleted\. Do not call/)
  await pane.unmount()
})

test('renaming a graph retires its old tool name, and undoing the rename retires the new one', async ($, on) => {
  const g = flow('g-rnreg', [node('a', 'Researcher', 2)])
  const pane = await openPane($, on, g)
  const before = toolName(g)
  await pane.input({ key: 'gname-g-rnreg', text: 'Beta', kind: 'submit' })
  const after = toolName({ ...g, name: 'Beta' })
  expect(after).not.toBe(before)
  expect(registered.find(r => r.name === before)?.description).toMatch(/was renamed\. Do not call/)
  expect(registered.find(r => r.name === after)?.description).toMatch(/^Runs the agent graph "Beta"/)
  registered = []
  await key(pane, 'z', { ctrl: true })
  expect(registered.find(r => r.name === after)?.description).toMatch(/was renamed\. Do not call/)
  expect(registered.find(r => r.name === before)?.description).toMatch(/^Runs the agent graph "Flow"/)
  await pane.unmount()
})

test('undoing a graph rename keeps the current name when the old one is now taken', async ($, on) => {
  const pane = await openPane($, on, flow('g-q4', [node('a', 'Researcher', 2)]), undefined, [OTHER('g-q4-other')])
  await pane.input({ key: 'gname-g-q4', text: 'Beta', kind: 'submit' })
  // Another graph takes the old name in the meantime.
  await pane.select({ key: 'graph', value: 'g-q4-other' })
  await pane.input({ key: 'gname-g-q4-other', text: 'Flow', kind: 'submit' })
  await pane.select({ key: 'graph', value: 'g-q4' })
  await key(pane, 'z', { ctrl: true })
  expect((await pane.find({ key: 'gname-g-q4' }))?.props.value).toBe('Beta')
  await pane.unmount()
})

test('undoing an add removes the new agent file, and redo writes its text back', async ($, on) => {
  const pane = await openPane($, on, flow('g-q5', [node('a', 'Researcher', 2)]))
  await pane.press({ key: 'add' })
  const created = (await cardsOfPane(pane)).find(c => c.name === 'Agent 2')!
  const path = [...files.keys()].find(k => k.includes(created.id))!
  expect(path).toBeDefined()
  files.set(path, 'Typed after adding.')
  await key(pane, 'z', { ctrl: true })
  expect(await namesOf(pane)).toEqual(['Researcher'])
  expect(files.has(path)).toBe(false)
  await key(pane, 'y', { ctrl: true })
  expect(await namesOf(pane)).toEqual(['Researcher', 'Agent 2'])
  expect(files.get(path)).toBe('Typed after adding.')
  await pane.unmount()
})

test('undoing a spawn removes the spawned agent file', async ($, on) => {
  const pane = await openPane($, on, flow('g-q5s', [node('a', 'Researcher', 2)]))
  await pane.post({ events: [{ kind: 'spawn', from: 'a', x: 40, y: 12 }] })
  const created = (await cardsOfPane(pane)).find(c => c.name === 'Agent 2')!
  expect([...files.keys()].some(k => k.includes(created.id))).toBe(true)
  await key(pane, 'z', { ctrl: true })
  expect([...files.keys()].some(k => k.includes(created.id))).toBe(false)
  await pane.unmount()
})

test('the stash of deleted agent texts is capped at the newest 200', () => {
  for (let i = 0; i < 260; i++) stashText('g-cap', `/x/${i}.md`, `text ${i}`)
  expect(stashed.size).toBeLessThanOrEqual(200)
  expect(stashed.has('/x/259.md')).toBe(true)
  expect(stashed.has('/x/0.md')).toBe(false)
})

test('consecutive nudges of one card are a single undo step; a pause makes a new one', async ($, on) => {
  const pane = await openPane($, on, flow('g-q19', [node('a', 'Researcher', 2)]))
  const xOf = async () => (await cardsOfPane(pane))[0]!.x
  await key(pane, 'tab')
  for (let i = 0; i < 3; i++) await key(pane, 'right')
  expect(await xOf()).toBe(5)
  await key(pane, 'z', { ctrl: true })
  expect(await xOf()).toBe(2)
  await key(pane, 'right')
  await clock.advance(1500)
  await key(pane, 'right')
  expect(await xOf()).toBe(4)
  await key(pane, 'z', { ctrl: true })
  expect(await xOf()).toBe(3)
  await key(pane, 'z', { ctrl: true })
  expect(await xOf()).toBe(2)
  await pane.unmount()
})

test('a nudge of another card does not join the previous one', async ($, on) => {
  const pane = await openPane($, on, flow('g-q19b', [node('a', 'Researcher', 2), node('b', 'Writer', 40)]))
  const xOf = async (name: string) => (await cardsOfPane(pane)).find(c => c.name === name)!.x
  await key(pane, 'tab')
  await key(pane, 'right')
  await key(pane, 'tab')
  await key(pane, 'right')
  await key(pane, 'z', { ctrl: true })
  expect(await xOf('Writer')).toBe(40)
  expect(await xOf('Researcher')).toBe(3)
  await pane.unmount()
})

test('d works while the connect picker waits for a target, but not at the kind step', async ($, on) => {
  const pane = await openPane($, on, flow('g-q11', [node('a', 'Researcher', 2), node('b', 'Writer', 40)]))
  await key(pane, 'tab')
  await pane.press({ key: 'connect' })
  await key(pane, 'd')
  expect((await cardsOfPane(pane))[0]).toMatchObject({ disabled: true })
  await key(pane, 'd')
  await pane.post({ events: [{ kind: 'wire', from: 'a', to: 'b' }] })
  await key(pane, 'd')
  expect((await cardsOfPane(pane))[0]).toMatchObject({ disabled: false })
  await pane.unmount()
})

test('a spawn dropped on a card goes to the nearest free spot', async ($, on) => {
  const pane = await openPane($, on, flow('g-q20', [node('a', 'Researcher', 2, 1), node('b', 'Writer', 28, 10)]))
  await pane.post({ events: [{ kind: 'spawn', from: 'a', x: 30, y: 12 }] })
  expect((await cardsOfPane(pane)).find(c => c.name === 'Agent 3')).toMatchObject({ x: 28, y: 16 })
  await pane.unmount()
})
