import { expect, mock } from 'claude-code/testing'
import { test } from './kit'
import type { AgentInfo, RenderElement } from 'claude-code'

import { refreshAgents, type Host } from '../hooks/actions'
import { bandLine, runPlan, workingAgents } from '../hooks/band'
import type { AgentNode, BandAgent, Graph, NodeRunView, RunView } from '../types'

const card = (id: string, name: string): AgentNode => ({
  id, name, x: 2, y: 1, instructionsFile: `/tmp/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2,
})
// Plan -> Build -> Check, Check retries Build, Build calls the Scout helper.
const factory: Graph = {
  id: 'g-band', name: 'Factory', description: '', backend: 'local', layout: 2,
  nodes: [card('p', 'Plan'), card('b', 'Build'), card('c', 'Check'), card('s', 'Scout')],
  edges: [
    { id: 'e1', from: 'p', to: 'b', kind: 'handoff' },
    { id: 'e2', from: 'b', to: 'c', kind: 'handoff' },
    { id: 'e3', from: 'c', to: 'b', kind: 'retry' },
    { id: 'e4', from: 'b', to: 's', kind: 'delegate' },
  ],
}
const live = (nodes: Record<string, NodeRunView>): RunView => ({ graphId: factory.id, graphName: factory.name, isRunning: true, nodes, plan: runPlan(factory) })
const none = { shown: [], more: 0 }

test('runPlan keeps each card name, handoff targets and retry targets', () => {
  expect(runPlan(factory)).toEqual({
    names: { p: 'Plan', b: 'Build', c: 'Check', s: 'Scout' },
    next: { p: ['b'], b: ['c'], c: [], s: [] },
    retry: { p: [], b: [], c: ['b'], s: [] },
  })
})

test('bandLine: nothing without a run or subagents, and nothing of a run that ended', () => {
  const empty = { working: none, paused: none, next: none, agents: none }
  expect(bandLine(null, [])).toEqual(empty)
  expect(bandLine({ ...live({ b: { status: 'running' } }), isRunning: false }, [])).toEqual(empty)
})

test('bandLine: the running cards with their current call cut to 30, a called helper, and the waiting handoff targets next', () => {
  const line = bandLine(live({
    p: { status: 'done' },
    b: { status: 'running', current: 'Bash · npm test -- --watch=false --reporter=dot' },
    c: { status: 'waiting' },
    s: { status: 'running', calledBy: 'b' },
  }), [])
  expect(line.working).toEqual({
    shown: [{ name: 'Build', isHelper: false, current: 'Bash · npm test -- --watch=fa…' }, { name: 'Scout', isHelper: true }],
    more: 0,
  })
  expect(line.paused).toEqual(none)
  expect(line.next).toEqual({ shown: ['Check'], more: 0 })
})

test('bandLine: a paused card, and the retry targets next when no handoff target waits', () => {
  const paused = bandLine(live({ p: { status: 'done' }, b: { status: 'done' }, c: { status: 'paused' } }), [])
  expect(paused.working).toEqual(none)
  expect(paused.paused).toEqual({ shown: ['Check'], more: 0 })
  expect(paused.next).toEqual({ shown: ['Build'], more: 0 })
  // A handoff target that already ran is not next.
  const last = bandLine(live({ p: { status: 'done' }, b: { status: 'running' }, c: { status: 'done' } }), [])
  expect(last.next).toEqual(none)
})

test('bandLine: at most 3 names per part and 4 subagents, then the count of the rest', () => {
  const wide: Graph = {
    ...factory,
    nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(id => card(id, id.toUpperCase())),
    edges: ['f', 'g', 'h', 'i', 'j'].map((to, i) => ({ id: `e${i}`, from: 'a', to, kind: 'handoff' as const })),
  }
  const run: RunView = {
    graphId: wide.id, graphName: wide.name, isRunning: true, plan: runPlan(wide),
    nodes: Object.fromEntries(wide.nodes.map((n, i) => [n.id, { status: i < 5 ? 'running' : 'waiting' } as NodeRunView])),
  }
  const agents: BandAgent[] = [1, 2, 3, 4, 5, 6].map(i => ({ id: `x${i}`, description: `Task ${i}`, type: 'Explore' }))
  const line = bandLine(run, agents)
  expect(line.working.shown.map(w => w.name)).toEqual(['A', 'B', 'C'])
  expect(line.working.more).toBe(2)
  expect(line.next).toEqual({ shown: ['F', 'G', 'H'], more: 2 })
  expect(line.agents).toEqual({ shown: agents.slice(0, 4), more: 2 })
  // Subagents show without a run too.
  expect(bandLine(null, agents.slice(0, 1)).agents).toEqual({ shown: agents.slice(0, 1), more: 0 })
})

test('workingAgents keeps running and pending subagents the graph did not start', () => {
  const info = (id: string, status: AgentInfo['status'], over: Partial<AgentInfo> = {}): AgentInfo => ({ id, description: `Task ${id}`, type: 'Explore', status, ...over })
  expect(workingAgents([
    info('run', 'running'),
    info('new', 'pending', { type: 'general-purpose' }),
    info('card', 'running', { spawnedBy: 'agent-graph' }),
    info('other-plugin', 'running', { spawnedBy: 'other' }),
    info('mate', 'idle', { type: 'teammate', teammateId: 'mate@team' }),
    info('wait', 'waiting'),
    info('done', 'completed'),
    info('failed', 'failed'),
  ])).toEqual([
    { id: 'run', description: 'Task run', type: 'Explore' },
    { id: 'new', description: 'Task new', type: 'general-purpose' },
    { id: 'other-plugin', description: 'Task other-plugin', type: 'Explore' },
  ])
})

test('refreshAgents writes the band list only when it changed, and keeps it when the list is refused', async () => {
  let list: AgentInfo[] = [{ id: 'x1', description: 'Find bugs', type: 'Explore', status: 'running' }]
  let refuse = false
  let agents: BandAgent[] = []
  let writes = 0
  const host = {
    agent: { list: async () => {
      if (refuse) throw new Error('no list')
      return list
    } },
    read: async () => agents,
    update: async (_slot: string, change: (value: BandAgent[]) => BandAgent[]) => {
      writes++
      agents = change(agents)
      return agents
    },
  } as unknown as Host
  await refreshAgents(host)
  expect(agents).toEqual([{ id: 'x1', description: 'Find bugs', type: 'Explore' }])
  expect(writes).toBe(1)
  await refreshAgents(host)
  expect(writes).toBe(1)
  refuse = true
  await refreshAgents(host)
  expect(agents).toEqual([{ id: 'x1', description: 'Find bugs', type: 'Explore' }])
  refuse = false
  list = [{ ...list[0]!, status: 'completed' }]
  await refreshAgents(host)
  expect(agents).toEqual([])
  expect(writes).toBe(2)
})

const BAND = {
  plugin: 'agent-graph',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const
const PANE = {
  plugin: 'agent-graph', component: 'Pane', requestId: 'agent-graph',
  props: { title: 'Agent Graph', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('the band button toggles the pane and keeps the other band', async ($, on) => {
  mock.store(on)
  // Opening the pane on a graph already open reads its instructions again, at most every 2 s.
  mock.clock(on)
  const opened: string[] = []
  const closed: string[] = []
  on('ui.open', (_$, e) => { opened.push(e.id); return { value: { isPlaced: true } } as never })
  on('ui.close', (_$, e) => { closed.push(e.id); return { value: undefined } as never })
  on('fs.write', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /other band/ }), `${surface}: other band`).toBeDefined()
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.indexOf('other band'), `${surface}: the other band comes first`).toBeGreaterThan(-1)
    expect(drawn.indexOf('other band')).toBeLessThan(drawn.indexOf('agent-graph'))
    expect((await ui.find({ key: 'agent-graph' }))?.props.label).toBe('⧉ Agent Graph')
    await ui.press({ key: 'agent-graph' })
    expect((await ui.find({ key: 'agent-graph' }))?.props.label).toBe('Close graph')
    await ui.press({ key: 'agent-graph' })
    expect((await ui.find({ key: 'agent-graph' }))?.props.label).toBe('⧉ Agent Graph')
    await ui.unmount()
  }
  expect(opened).toEqual(['agent-graph', 'agent-graph'])
  expect(closed).toEqual(['agent-graph', 'agent-graph'])
})

test('the band button steps aside for a survey', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'survey') as RenderElement
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ key: 'agent-graph' })).toBeUndefined()
  expect(await ui.find({ text: /survey/ })).toBeDefined()
})

// Keep this test last in the file: its run never finishes, and while it goes the
// module's active-run slot refuses any later run in this file.
test('during a run the band shows the working card, the one next and the session subagents', async ($, on) => {
  const flow: Graph = {
    id: 'g-run', name: 'Flow', description: '', backend: 'local', layout: 2,
    nodes: [card('a', 'Researcher'), { ...card('b', 'Writer'), x: 40 }],
    edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'handoff' }],
  }
  mock.store(on, { graphs: [{ id: flow.id, name: flow.name }], [`graph:${flow.id}`]: flow })
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.message', () => ({ value: undefined }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.read', () => ({ value: 'Do the work.' }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('agent.register', () => ({ value: undefined }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })
  let listed: AgentInfo[] = []
  let lists = 0
  on('agent.list', () => {
    lists++
    return { value: listed } as never
  })
  // The graph's own agent never answers, so the run stays on it; a subagent Claude starts does.
  on('agent.spawn', (_$, e) => (e.description === 'Find bugs' ? ({ model: 'm', agentId: 'x1' }) as never : new Promise(() => {}) as never))

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const drawn = async () => JSON.stringify(await band.drawn())
  // No run and no subagents: the button alone, as before.
  const before = await drawn()
  expect(before).not.toMatch(/◐|▶|⏸|next:|⚙/)
  await band.press({ key: 'agent-graph' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.input({ key: 'task', text: 'do it', kind: 'change' })
  await pane.press({ key: 'run' })
  await clock.advance(16)
  expect(await band.find({ text: /◐ Flow 0\/2/ })).toBeDefined()
  expect(await band.find({ text: /▶ Researcher/ })).toBeDefined()
  expect(await band.find({ text: /next: Writer/ })).toBeDefined()
  expect(await band.find({ text: /⚙/ })).toBeUndefined()

  // Claude starts a subagent: the band lists it, and not the graph's own card.
  listed = [
    { id: 'x1', description: 'Find bugs', type: 'Explore', status: 'running' },
    { id: 'card-a', description: 'Researcher', type: 'agent-graph:researcher', status: 'running', spawnedBy: 'agent-graph' },
  ]
  await $.agent.spawn({ prompt: 'Look for bugs.', description: 'Find bugs', subagentType: 'Explore' } as never)
  expect(await band.find({ text: /⚙ Find bugs \(Explore\)/ })).toBeDefined()
  expect(await band.find({ text: /agent-graph:researcher/ })).toBeUndefined()

  // Its turn ends while the engine still lists it as running; 2 s on it is gone.
  const listsBefore = lists
  await $.turn.complete({ agentId: 'x1', answer: 'Found none.', reason: 'answer', durationMs: 5, isAborted: false, turnId: 't1' } as never)
  expect(lists).toBe(listsBefore + 1)
  expect(await band.find({ text: /⚙ Find bugs/ })).toBeDefined()
  listed = listed.filter(a => a.id !== 'x1')
  await clock.advance(2000)
  expect(lists).toBe(listsBefore + 2)
  expect(await band.find({ text: /⚙/ })).toBeUndefined()
  expect(await band.find({ text: /▶ Researcher/ })).toBeDefined()
  await pane.unmount()
  await band.unmount()
})
