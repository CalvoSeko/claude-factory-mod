import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph } from '../types'
import type { Api, AgentBody, SkillFile } from '../hooks/cloud/api'
import { agentBody, ensureEnvironment, syncGraph, type SyncDeps } from '../hooks/cloud/sync'
import { connect } from '../hooks/model'

const node = (id: string, name: string, over: Partial<AgentNode> = {}): AgentNode => ({
  id, name, x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2, ...over,
})
const graph = (nodes: AgentNode[]): Graph => ({ id: 'g', name: 'Flow', description: '', backend: 'cloud', nodes, edges: [] })

function fakeApi() {
  const log: string[] = []
  let n = 0
  const api = {
    createEnvironment: async () => { log.push('env'); return { id: 'env_1' } },
    createAgent: async (body: AgentBody) => { log.push(`create ${body.name}`); n++; return { id: `agent_${n}`, version: 1 } },
    updateAgent: async (id: string) => { log.push(`update ${id}`); return { id, version: 2 } },
    createSkill: async (files: SkillFile[]) => { log.push(`skill ${files.length}`); return { id: 'skill_1' } },
    createSkillVersion: async (id: string) => { log.push(`skill-version ${id}`); return { id: 'skver_2' } },
  } as unknown as Api
  return { api, log }
}

function deps(api: Api): SyncDeps {
  const kv = new Map<string, unknown>()
  return {
    api,
    store: { get: async k => kv.get(k), set: async (k, v) => void kv.set(k, v), delete: async k => void kv.delete(k) },
    instructions: async n => `I am ${n.name}.`,
    skillFiles: async name => (name === 'tdd' ? { files: [{ path: 'tdd/SKILL.md', text: '---\nname: tdd\n---' }] } : { error: `Skill "${name}" was not found.` }),
    hash: async text => `h${text.length}`,
  }
}

test('the environment is created once and reused', async () => {
  const { api, log } = fakeApi()
  const d = deps(api)
  expect(await ensureEnvironment(d)).toBe('env_1')
  expect(await ensureEnvironment(d)).toBe('env_1')
  expect(log).toEqual(['env'])
})

test('agent bodies map tools, model, skills and the delegate roster', async () => {
  const g = graph([node('a', 'Lead', { tools: ['Read', 'Bash'], model: 'sonnet' })])
  expect(agentBody(g, g.nodes[0]!, 'SYS', [{ type: 'anthropic', skill_id: 'xlsx' }], ['agent_9'])).toEqual({
    name: 'Flow / Lead',
    description: 'SYS',
    model: 'claude-sonnet-5-5',
    system: 'SYS',
    tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: false }, configs: [{ name: 'read', enabled: true }, { name: 'bash', enabled: true }] }],
    skills: [{ type: 'anthropic', skill_id: 'xlsx' }],
    multiagent: { type: 'coordinator', agents: ['agent_9'] },
  })
  const plain = agentBody(graph([node('b', 'B')]), node('b', 'B'), 'S', [], [])
  expect(plain.model).toBe('claude-opus-5-5')
  expect(plain.multiagent).toBeNull()
})

test('sync creates delegates first, then skips unchanged agents and updates changed ones', async () => {
  const { api, log } = fakeApi()
  const d = deps(api)
  let g = connect(graph([node('a', 'Lead', { skills: ['tdd', 'pdf'] }), node('b', 'Reader')]), 'a', 'b', 'delegate')
  const first = await syncGraph(g, d)
  expect(first.problems).toEqual([])
  expect(log).toEqual(['create Flow / Reader', 'skill 1', 'create Flow / Lead'])
  expect(first.graph.nodes.map(n => n.cloud?.agentId)).toEqual(['agent_2', 'agent_1'])

  log.length = 0
  const again = await syncGraph(first.graph, d)
  expect(log).toEqual([])
  g = { ...again.graph, nodes: again.graph.nodes.map(n => (n.id === 'b' ? { ...n, model: 'haiku' } : n)) }
  await syncGraph(g, d)
  expect(log).toEqual(['update agent_1'])
})

test('a missing skill is a problem on its node', async () => {
  const { api } = fakeApi()
  const g = graph([node('a', 'Lead', { skills: ['ghost'] })])
  const synced = await syncGraph(g, deps(api))
  expect(synced.problems).toEqual([{ target: { kind: 'node', id: 'a' }, message: 'Skill "ghost" was not found.' }])
})

test('a throwing skill upload is a problem on its node, other nodes still sync', async () => {
  const { api, log } = fakeApi()
  api.createSkill = async () => {
    throw new Error('upload refused')
  }
  const d = deps(api)
  const g = graph([node('a', 'Lead', { skills: ['tdd'] }), node('b', 'Reader')])
  const synced = await syncGraph(g, d)
  expect(synced.problems).toEqual([{ target: { kind: 'node', id: 'a' }, message: 'Could not sync this agent: upload refused' }])
  expect(log).toEqual(['create Flow / Reader'])
})

test('the stored agent description is the when-to-use, else the first instructions line', async () => {
  const withUse = node('a', 'A', { whenToUse: ' Call for sums ' })
  expect(agentBody(graph([withUse]), withUse, 'Does things.\nMore.', [], []).description).toBe('Call for sums')
  const plain = node('b', 'B')
  expect(agentBody(graph([plain]), plain, 'Does things.\nMore.', [], []).description).toBe('Does things.')
})

test('agent bodies skip tool names that are only inherited object keys', async () => {
  const n = node('a', 'A', { tools: ['constructor', 'Read', 'toString'] })
  const body = agentBody(graph([n]), n, 'S', [], [])
  expect(body.tools).toEqual([{ type: 'agent_toolset_20260401', default_config: { enabled: false }, configs: [{ name: 'read', enabled: true }] }])
})

test('a coordinator whose helper could not be synced is skipped with a problem', async () => {
  const { api, log } = fakeApi()
  const g = connect(connect(graph([node('a', 'Lead'), node('b', 'Reader', { skills: ['ghost'] }), node('c', 'Writer')]), 'a', 'b', 'delegate'), 'a', 'c', 'delegate')
  const synced = await syncGraph(g, deps(api))
  expect(synced.problems).toEqual([
    { target: { kind: 'node', id: 'b' }, message: 'Skill "ghost" was not found.' },
    { target: { kind: 'node', id: 'a' }, message: 'Its helper Reader could not be synced.' },
  ])
  expect(log).toEqual(['create Flow / Writer'])
  expect(synced.graph.nodes.find(n => n.id === 'a')?.cloud).toBeUndefined()
})
