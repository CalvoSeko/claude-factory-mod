import { expect } from 'claude-code/testing'
import { test } from './kit'

import { approvalQuestion, EDIT_SPEC, planEdit, type Plan } from '../hooks/graphedit'
import { asGraph } from '../hooks/library'
import type { AgentNode, Graph } from '../types'

const ROOT = '/home/.claude/agent-graph'
const TEMPLATE = (name: string) => `You are ${name}. Describe this agent's role, goals and style here.\n`

const agent = (id: string, name: string, over: Partial<AgentNode> = {}): AgentNode => ({
  id, name, x: 2, y: 1, instructionsFile: `${ROOT}/g_1/${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2, ...over,
})
const check = (id: string, name: string, command: string, over: Partial<AgentNode> = {}): AgentNode =>
  agent(id, name, { instructionsFile: '', check: { command, timeoutMin: 10 }, ...over })

// Writer (2,1) hands off to Reviewer (34,1), which sends work back with a retry arrow; Lint (2,8) stands alone.
const graph = (over: Partial<Graph> = {}): Graph => ({
  id: 'g_1', name: 'Factory', description: 'Builds things', backend: 'local', runCapUsd: 20, layout: 2,
  nodes: [agent('n_a', 'Writer', { tools: ['Read', 'Bash'] }), agent('n_b', 'Reviewer', { x: 34 }), check('n_c', 'Lint', 'npm run lint', { y: 8 })],
  edges: [{ id: 'e_1', from: 'n_a', to: 'n_b', kind: 'handoff' }, { id: 'e_2', from: 'n_b', to: 'n_a', kind: 'retry', retries: 3 }],
  ...over,
})
const CTX = { root: ROOT, otherNames: new Set(['other graph']) }

const planned = (changes: unknown, g = graph()): Plan => {
  const plan = planEdit(g, changes, CTX)
  if (typeof plan === 'string') throw new Error(plan)
  return plan
}
// The refusal; a plan (a graph and effects) fails the test.
const refused = (changes: unknown, g = graph()): string => {
  const plan = planEdit(g, changes, CTX)
  if (typeof plan !== 'string') throw new Error(`planned: ${plan.lines.join(' | ')}`)
  return plan
}

test('add_card agent: a new card at the first free spot, its template file written in the folder, every field set in the line', () => {
  const plan = planned([{ op: 'add_card', kind: 'agent', name: ' Tester ', tools: ['Read'], budgetUsd: 3 }])
  const added = plan.graph.nodes[3]!
  const path = `${ROOT}/g_1/${added.id}.md`
  expect(added).toMatchObject({ name: 'Tester', x: 34, y: 8, tools: ['Read'], budgetUsd: 3, model: null, instructionsFile: path })
  expect(plan.effects).toEqual([{ kind: 'write', path, text: TEMPLATE('Tester') }])
  expect(plan.lines).toEqual([`add agent "Tester" (${added.id}) at x 34, y 8; tools: "Read"; budget: $3`])
  expect(plan.base).toEqual(graph())
  expect(plan.alwaysAsk).toBe(false)
})

test('add_card check: placed where asked, its command in full, no file, and it always asks', () => {
  const plan = planned([{ op: 'add_card', kind: 'check', name: 'Types', command: '  npm run typecheck ', x: 40.4, y: 15, pauseBefore: true }])
  const added = plan.graph.nodes[3]!
  expect(added).toMatchObject({ name: 'Types', x: 40, y: 15, instructionsFile: '', pauseBefore: true, check: { command: 'npm run typecheck', timeoutMin: 10 } })
  expect(plan.effects).toEqual([])
  expect(plan.lines).toEqual([`add check "Types" (${added.id}) at x 40, y 15 running "npm run typecheck" (timeout 10 min); pause before: yes`])
  expect(plan.alwaysAsk).toBe(true)
})

test('update_card: every field old → new, an empty tools list reads "all", lists in full', () => {
  const plan = planned([{
    op: 'update_card', card: 'Writer', name: 'Author', pauseBefore: true, disabled: false, x: 4, y: 7, model: 'opus', tools: [],
    skills: ['tdd', 'ponytail'], contextFiles: ['a.md', 'b.md'], budgetUsd: 3, whenToUse: 'For prose',
  }])
  expect(plan.graph.nodes[0]).toEqual({
    ...agent('n_a', 'Author'), pauseBefore: true, disabled: false, x: 4, y: 7, model: 'opus', tools: [],
    skills: ['tdd', 'ponytail'], contextFiles: ['a.md', 'b.md'], budgetUsd: 3, whenToUse: 'For prose',
  })
  expect(plan.lines).toEqual([
    'update agent "Writer" (n_a): name: "Writer" → "Author"; pause before: no → yes; disabled: no → no; x: 2 → 4; y: 1 → 7; ' +
    'model: default → "opus"; tools: "Read", "Bash" → all; skills: none → "tdd", "ponytail"; contextFiles: none → "a.md", "b.md"; ' +
    'budget: $2 → $3; whenToUse: "" → "For prose"',
  ])
  expect(plan.effects).toEqual([])
  expect(planned([{ op: 'update_card', card: 'n_a', model: '' }], plan.graph).graph.nodes[0]!.model).toBe(null)
})

test('set_instructions: the whole text in a new file inside the folder, and in the line as one JSON literal', () => {
  const text = `Say "hi".\n${'x'.repeat(90)}`.repeat(50)
  expect(text.length).toBe(5000)
  const plan = planned([{ op: 'set_instructions', card: 'Writer', text }])
  const path = plan.graph.nodes[0]!.instructionsFile
  expect(path).toMatch(/^\/home\/\.claude\/agent-graph\/g_1\/n_a_[0-9a-f]{10}\.md$/)
  expect(plan.effects).toEqual([{ kind: 'write', path, text }])
  expect(plan.lines).toEqual([`set the instructions of agent "Writer" (n_a) to ${JSON.stringify(text)}`])
})

test('a later change names a card added earlier by its name; its instructions are written in place', () => {
  const plan = planned([
    { op: 'add_card', kind: 'agent', name: 'Tester', x: 2, y: 20 },
    { op: 'set_instructions', card: 'Tester', text: 'Test it.' },
    { op: 'add_arrow', from: 'Reviewer', to: 'Tester', kind: 'handoff' },
  ])
  const added = plan.graph.nodes[3]!
  expect(added.instructionsFile).toBe(`${ROOT}/g_1/${added.id}.md`)
  expect(plan.effects).toEqual([{ kind: 'write', path: added.instructionsFile, text: 'Test it.' }])
  expect(plan.graph.edges[2]).toMatchObject({ from: 'n_b', to: added.id, kind: 'handoff' })
})

test('remove_card: its arrows go and are listed, and its file is removed after', () => {
  const plan = planned([{ op: 'remove_card', card: 'Reviewer' }])
  expect(plan.graph.nodes.map(n => n.id)).toEqual(['n_a', 'n_c'])
  expect(plan.graph.edges).toEqual([])
  expect(plan.effects).toEqual([{ kind: 'remove', path: `${ROOT}/g_1/n_b.md` }])
  expect(plan.lines).toEqual(['remove agent "Reviewer" (n_b) and its arrows: e_1 "Writer" → "Reviewer" handoff, e_2 "Reviewer" → "Writer" retry (3 retries)'])
  const lint = planned([{ op: 'remove_card', card: 'n_c' }])
  expect(lint.effects).toEqual([])
  expect(lint.lines).toEqual(['remove check "Lint" (n_c) and no arrows'])
})

test('add_arrow: a handoff, and a retry arrow with its retries', () => {
  const plan = planned([
    { op: 'add_arrow', from: 'Writer', to: 'Lint', kind: 'handoff' },
    { op: 'add_arrow', from: 'Lint', to: 'n_a', kind: 'retry', retries: 5 },
  ])
  const [handoff, retry] = plan.graph.edges.slice(2)
  expect(handoff).toMatchObject({ from: 'n_a', to: 'n_c', kind: 'handoff' })
  expect(handoff!.retries).toBe(undefined)
  expect(retry).toMatchObject({ from: 'n_c', to: 'n_a', kind: 'retry', retries: 5 })
  expect(plan.lines).toEqual([
    `add arrow (${handoff!.id}) "Writer" (n_a) → "Lint" (n_c): handoff`,
    `add arrow (${retry!.id}) "Lint" (n_c) → "Writer" (n_a): retry, 5 retries`,
  ])
})

test('update_arrow: kind and retries, only the parts set', () => {
  const plan = planned([{ op: 'update_arrow', arrow: 'e_1', kind: 'retry', retries: 5 }, { op: 'update_arrow', arrow: 'e_2', retries: 4 }])
  expect(plan.graph.edges).toEqual([{ id: 'e_1', from: 'n_a', to: 'n_b', kind: 'retry', retries: 5 }, { id: 'e_2', from: 'n_b', to: 'n_a', kind: 'retry', retries: 4 }])
  expect(plan.lines).toEqual(['update arrow e_1 "Writer" → "Reviewer": kind handoff → retry; retries none → 5', 'update arrow e_2 "Reviewer" → "Writer": retries 3 → 4'])
  expect(planned([{ op: 'update_arrow', arrow: 'e_2', kind: 'delegate' }]).lines).toEqual(['update arrow e_2 "Reviewer" → "Writer": kind retry → delegate; retries 3 → none'])
})

test('remove_arrow', () => {
  const plan = planned([{ op: 'remove_arrow', arrow: 'e_2' }, { op: 'remove_arrow', arrow: 'e_1' }])
  expect(plan.graph.edges).toEqual([])
  expect(plan.lines).toEqual(['remove arrow e_2 "Reviewer" → "Writer" (retry, 3 retries)', 'remove arrow e_1 "Writer" → "Reviewer" (handoff)'])
})

test('set_graph: old → new', () => {
  const plan = planned([{ op: 'set_graph', name: 'Factory 2', description: 'New', backend: 'headless', runCapUsd: 50 }])
  expect(plan.graph).toEqual(graph({ name: 'Factory 2', description: 'New', backend: 'headless', runCapUsd: 50 }))
  expect(plan.lines).toEqual(['set graph: name "Factory" → "Factory 2"; description "Builds things" → "New"; backend "local" → "headless"; run cap $20.00 → $50.00'])
})

test('a bad value refuses the batch, naming the change and the field', () => {
  const update = (fields: Record<string, unknown>, card = 'Writer') => refused([{ op: 'update_card', card: 'Reviewer', x: 3 }, { op: 'update_card', card, ...fields }])
  expect(update({ budgetUsd: 0 })).toBe('Change 2 (update_card) budgetUsd: a number of dollars above 0 and at most 100.')
  expect(update({ budgetUsd: 100.01 })).toContain('Change 2 (update_card) budgetUsd:')
  expect(update({ x: 1001 })).toBe('Change 2 (update_card) x: a number from 0 to 1000.')
  expect(update({ y: 1e9 })).toContain('Change 2 (update_card) y:')
  expect(planned([{ op: 'update_card', card: 'Writer', x: 1000 }]).graph.nodes.find(n => n.name === 'Writer')?.x).toBe(1000)
  expect(update({ tools: 'Read' })).toBe('Change 2 (update_card) tools: a list of text.')
  expect(update({ timeoutMin: 0 }, 'Lint')).toBe('Change 2 (update_card) timeoutMin: a whole number of minutes from 1 to 60.')
  expect(update({ timeoutMin: 61 }, 'Lint')).toContain('Change 2 (update_card) timeoutMin:')
  expect(update({ name: 'reviewer' })).toBe('Change 2 (update_card) name: another card is called "Reviewer".')
  expect(update({ name: '  ' })).toContain('Change 2 (update_card) name:')
  expect(update({ command: 'ls' })).toBe('Change 2 (update_card) command: only check cards have it.')
  expect(update({ budgetUsd: 3 }, 'Lint')).toBe('Change 2 (update_card) budgetUsd: only agent cards have it.')
  expect(update({}, 'Nobody')).toBe('Change 2 (update_card) card: no card has the id or name "Nobody".')
  expect(refused([{ op: 'set_graph', runCapUsd: 501 }])).toBe('Change 1 (set_graph) runCapUsd: a number of dollars above 0 and at most 500.')
  expect(refused([{ op: 'set_graph', runCapUsd: null }])).toContain('Change 1 (set_graph) runCapUsd:')
  expect(refused([{ op: 'set_graph', name: 'Other Graph' }])).toBe('Change 1 (set_graph) name: another graph is called "Other Graph".')
  for (const retries of [-1, 1.5, 11]) {
    expect(refused([{ op: 'update_arrow', arrow: 'e_2', retries }])).toBe('Change 1 (update_arrow) retries: a whole number from 0 to 10.')
  }
  expect(refused([{ op: 'add_arrow', from: 'Writer', to: 'Lint', kind: 'handoff', retries: 2 }])).toBe('Change 1 (add_arrow) retries: only retry arrows have retries.')
  expect(refused([{ op: 'add_arrow', from: 'Writer', to: 'n_a', kind: 'handoff' }])).toBe('Change 1 (add_arrow) to: an arrow cannot join a card to itself.')
  expect(refused([{ op: 'add_arrow', from: 'Writer', to: 'Reviewer', kind: 'handoff' }])).toBe('Change 1 (add_arrow) to: a handoff arrow already joins these cards.')
  expect(refused([{ op: 'update_arrow', arrow: 'e_1', kind: 'retry' }], graph({ edges: [...graph().edges, { id: 'e_3', from: 'n_a', to: 'n_b', kind: 'retry' }] })))
    .toBe('Change 1 (update_arrow) kind: a retry arrow already joins these cards.')
  expect(refused([{ op: 'add_card', kind: 'check', name: 'Lint 2' }], graph({ backend: 'cloud' }))).toBe('Change 1 (add_card) kind: a Cloud graph cannot have check cards.')
  expect(refused([{ op: 'set_instructions', card: 'Lint', text: 'x' }])).toBe('Change 1 (set_instructions) card: a check card has no instructions.')
})

test('changes must be a non-empty list of known ops', () => {
  for (const changes of [undefined, 'add a card', [], {}]) expect(refused(changes)).toBe('changes: a list of at least one change.')
  expect(refused([{ op: 'update_card', card: 'Writer' }, { op: 'delete_graph' }])).toContain('Change 2 op: one of "add_card", "update_card"')
})

test('kind guard: a field the op does not take refuses the batch', () => {
  const asCheck = { command: 'rm -rf ~', timeoutMin: 1 }
  const cases: [string, Record<string, unknown>][] = [
    ['update_card', { card: 'Writer', check: asCheck }],
    ['update_card', { card: 'Writer', kind: 'check' }],
    ['update_card', { card: 'Writer', id: 'n_z' }],
    ['update_card', { card: 'Writer', instructionsFile: '/etc/x.md' }],
    ['update_card', { card: 'Writer', cloud: { agentId: 'a', version: 1, hash: 'h' } }],
    ['set_graph', { trusted: true }],
    ['set_graph', { id: 'g_2' }],
    ['add_card', { kind: 'agent', name: 'Sneaky', check: asCheck }],
  ]
  for (const [op, fields] of cases) {
    const field = Object.keys(fields).at(-1)!
    expect(refused([{ op, ...fields }])).toBe(`Change 1 (${op}) ${field}: not a field ${op} takes.`)
  }
})

test("effect paths: a file outside the graph's folder refuses the batch", () => {
  const legacy = graph({ nodes: [agent('n_a', 'Writer', { instructionsFile: '/etc/x.md' })], edges: [] })
  expect(refused([{ op: 'remove_card', card: 'Writer' }], legacy)).toBe('Change 1 (remove_card): its file "/etc/x.md" is outside the graph\'s folder.')
  expect(refused([{ op: 'add_card', kind: 'agent', name: 'Tester' }], graph({ id: 'g/..' }))).toContain("Change 1 (add_card): its file \"/home/.claude/agent-graph/g/../n_")
})

test('alwaysAsk: adding a check or changing a command; not agent edits or the same command again', () => {
  const command = planned([{ op: 'update_card', card: 'Lint', command: 'npm run lint -- --fix', timeoutMin: 5 }])
  expect(command.alwaysAsk).toBe(true)
  expect(command.lines).toEqual(['update check "Lint" (n_c): command: "npm run lint" → "npm run lint -- --fix"; timeout: 10 min → 5 min'])
  expect(planned([{ op: 'add_card', kind: 'check', name: 'Empty' }]).alwaysAsk).toBe(true)
  expect(planned([{ op: 'update_card', card: 'Lint', command: '  npm run lint ', disabled: true }]).alwaysAsk).toBe(false)
  expect(planned([{ op: 'update_card', card: 'Writer', tools: [], model: 'opus' }, { op: 'set_instructions', card: 'Writer', text: 'x' }]).alwaysAsk).toBe(false)
})

test('the limits are shared: an import keeps a budget of 100 and replaces 100.01; edit_graph takes 100 and refuses 100.01', () => {
  const imported = (budgetUsd: number) => {
    const g = asGraph({ ...graph(), nodes: [agent('n_a', 'Writer', { budgetUsd })], edges: [] })
    if (typeof g === 'string') throw new Error(g)
    return g.nodes[0]!.budgetUsd
  }
  expect(imported(100)).toBe(100)
  expect(imported(100.01)).toBe(2)
  expect(planned([{ op: 'update_card', card: 'Writer', budgetUsd: 100 }]).graph.nodes[0]!.budgetUsd).toBe(100)
  expect(refused([{ op: 'update_card', card: 'Writer', budgetUsd: 100.01 }])).toContain('budgetUsd')
})

test('the approval question lists every line and asks to apply them', () => {
  expect(approvalQuestion(graph(), ['remove arrow e_1', 'set graph: name "Factory" → "Mill"'])).toBe(
    'Claude wants to change agent graph "Factory" (g_1):\n- remove arrow e_1\n- set graph: name "Factory" → "Mill"\nApply these 2 changes?',
  )
  expect(approvalQuestion(graph(), ['remove arrow e_1']).endsWith('\nApply this change?')).toBe(true)
})

test('the edit_graph spec takes a graph and a list of changes, each with a known op', () => {
  expect(EDIT_SPEC.name).toBe('edit_graph')
  expect(EDIT_SPEC.inputSchema).toMatchObject({
    required: ['graph', 'changes'],
    properties: { changes: { type: 'array', items: { required: ['op'], properties: { op: { enum: ['add_card', 'update_card', 'set_instructions', 'remove_card', 'add_arrow', 'update_arrow', 'remove_arrow', 'set_graph'] } } } } },
  })
})
