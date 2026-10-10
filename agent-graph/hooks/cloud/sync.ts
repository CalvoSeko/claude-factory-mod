import type { AgentNode, Graph } from '../../types'
import { firstLine, systemText } from '../compile'
import type { KeyValue } from '../library'
import { CLOUD_TOOLS, incoming, isCheck, nodeById, outgoing, updateNode, type Problem } from '../model'
import type { AgentBody, Api, SkillFile } from './api'

export const CLOUD_MODELS: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5-1',
}
const DEFAULT_MODEL = 'claude-opus-5-5'

export const ANTHROPIC_SKILLS = new Set(['xlsx', 'docx', 'pptx', 'pdf'])

export type SkillRef = { type: 'anthropic'; skill_id: string } | { type: 'custom'; skill_id: string; version: 'latest' }

export type SyncDeps = {
  api: Api
  store: KeyValue
  instructions(node: AgentNode): Promise<string>
  skillFiles(name: string): Promise<{ files: SkillFile[] } | { error: string }>
  hash(text: string): Promise<string>
}

const ENVIRONMENT_KEY = 'cloud:environment'
const skillKey = (name: string) => `cloud:skill:${name}`
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function ensureEnvironment(deps: SyncDeps): Promise<string> {
  const known = await deps.store.get(ENVIRONMENT_KEY)
  if (typeof known === 'string') return known
  const created = await deps.api.createEnvironment('agent-graph')
  await deps.store.set(ENVIRONMENT_KEY, created.id)
  return created.id
}

export async function skillRef(deps: SyncDeps, name: string): Promise<SkillRef | { error: string }> {
  if (ANTHROPIC_SKILLS.has(name)) return { type: 'anthropic', skill_id: name }
  const found = await deps.skillFiles(name)
  if ('error' in found) return found
  const hash = await deps.hash(JSON.stringify(found.files))
  const cached = (await deps.store.get(skillKey(name))) as { id: string; hash: string } | undefined
  if (cached?.hash === hash) return { type: 'custom', skill_id: cached.id, version: 'latest' }
  let id: string
  if (cached !== undefined) {
    await deps.api.createSkillVersion(cached.id, found.files)
    id = cached.id
  } else {
    id = (await deps.api.createSkill(found.files)).id
  }
  await deps.store.set(skillKey(name), { id, hash })
  return { type: 'custom', skill_id: id, version: 'latest' }
}

export function agentBody(g: Graph, node: AgentNode, system: string, skills: SkillRef[], delegateIds: string[]): AgentBody {
  const names = node.tools.length > 0
    ? node.tools.flatMap(t => (Object.hasOwn(CLOUD_TOOLS, t) ? [CLOUD_TOOLS[t]!] : []))
    : Object.values(CLOUD_TOOLS)
  return {
    name: `${g.name} / ${node.name}`,
    description: node.whenToUse?.trim() || firstLine(system) || node.name,
    model: (node.model !== null ? CLOUD_MODELS[node.model] : undefined) ?? DEFAULT_MODEL,
    system,
    tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: false }, configs: names.map(name => ({ name, enabled: true })) }],
    skills,
    multiagent: delegateIds.length > 0 ? { type: 'coordinator', agents: delegateIds } : null,
  }
}

// Creates or updates each node's stored agent, delegates first so rosters can
// name them; unchanged nodes (same config hash) are left alone.
export async function syncGraph(g: Graph, deps: SyncDeps): Promise<{ graph: Graph; problems: Problem[] }> {
  const problems: Problem[] = []
  const ordered = [...g.nodes].sort(
    (a, b) => Number(incoming(g, b.id, 'delegate').length > 0) - Number(incoming(g, a.id, 'delegate').length > 0),
  )
  let graph = g
  for (const original of ordered) {
    const node = nodeById(graph, original.id)!
    // A check card is no agent (and is a problem on Cloud): nothing is synced for it.
    if (isCheck(node)) continue
    const onNode = (text: string) => problems.push({ target: { kind: 'node', id: node.id }, message: text })
    try {
      const skills: SkillRef[] = []
      let skillProblem = false
      for (const name of node.skills) {
        const ref = await skillRef(deps, name)
        if ('error' in ref) {
          onNode(ref.error)
          skillProblem = true
        } else {
          skills.push(ref)
        }
      }
      if (skillProblem) continue
      const delegateIds: string[] = []
      const unsynced: string[] = []
      for (const e of outgoing(graph, node.id, 'delegate')) {
        const helper = nodeById(graph, e.to)
        if (helper === undefined) continue
        if (helper.cloud?.agentId === undefined) unsynced.push(helper.name)
        else delegateIds.push(helper.cloud.agentId)
      }
      // A coordinator synced without a helper would quietly lose it from its roster.
      if (unsynced.length > 0) {
        onNode(`Its helper ${unsynced.join(', ')} could not be synced.`)
        continue
      }
      const body = agentBody(graph, node, await systemText(graph, node, deps.instructions, 'cloud'), skills, delegateIds)
      const hash = await deps.hash(JSON.stringify(body))
      if (node.cloud?.hash === hash) continue
      const saved = node.cloud !== undefined
        ? await deps.api.updateAgent(node.cloud.agentId, body)
        : await deps.api.createAgent(body)
      graph = updateNode(graph, node.id, { cloud: { agentId: saved.id, version: saved.version, hash } })
    } catch (error) {
      onNode(`Could not sync this agent: ${message(error)}`)
    }
  }
  return { graph, problems }
}
