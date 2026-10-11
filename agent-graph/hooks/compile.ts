import type { AgentNode, BackendKind, Graph } from '../types'
import { nodeById, outgoing, retryOut, slug } from './model'

export type ContextSource = {
  kind(path: string): Promise<'file' | 'dir' | 'missing'>
  read(path: string): Promise<string>
  files(dir: string): Promise<string[]>
}

export type ContextFile = { path: string; relative: string; text: string }

export type LocalAgentSpec = {
  name: string
  description: string
  prompt: string
  tools?: string[]
  model?: string
  skills?: string[]
}

export const LOCAL_CONTEXT_LIMIT = 200 * 1024

// Unique by node id (names can share a slug), and at most 64 characters (the
// engine's limit on an agent type's name): 25 + 2 + 29 + 1 + 6.
export const agentName = (g: Graph, n: AgentNode) => `${slug(g.name).slice(0, 25)}--${slug(n.name).slice(0, 29)}-${n.id.slice(-6)}`
export const agentType = (g: Graph, n: AgentNode) => `agent-graph:${agentName(g, n)}`

export function firstLine(text: string): string {
  return text.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(l => l !== '') ?? ''
}

export const VERDICT_SECTION =
  '## Verdict\n\nEnd your answer with a line that says exactly `VERDICT: pass` if the work meets the bar, or `VERDICT: fail` and what must change.'

export async function systemText(
  g: Graph,
  node: AgentNode,
  instructions: (n: AgentNode) => Promise<string>,
  backend: BackendKind,
  // False when the caller adds the verdict section itself, last (Local puts the context files after the system text).
  withVerdict = true,
): Promise<string> {
  const own = (await instructions(node)).trim()
  const delegates = outgoing(g, node.id, 'delegate')
    .map(e => nodeById(g, e.to))
    .filter((n): n is AgentNode => n !== undefined)
  let text = own
  // Local and Headless agents delegate with the Agent tool: Local's by the plugin's agent type, Headless's by the
  // plain names of their --agents file.
  const byAgentTool = backend !== 'cloud'
  if (delegates.length > 0) {
    const lines = await Promise.all(
      delegates.map(async d => {
        const purpose = d.whenToUse?.trim() || firstLine(await instructions(d)) || 'no description'
        return byAgentTool
          ? `- ${d.name} (subagent_type "${backend === 'headless' ? agentName(g, d) : agentType(g, d)}"): ${purpose}`
          : `- ${d.name}: ${purpose}`
      }),
    )
    const how = byAgentTool
      ? 'Use the Agent tool with one of these agents and no other:'
      : 'Hand work to these agents by name:'
    text = `${own}\n\n## You may delegate to\n\n${how}\n${lines.join('\n')}`
  }
  // An agent a retry arrow leaves is a reviewer: its verdict decides whether the loop goes round again.
  if (withVerdict && retryOut(g, node.id) !== undefined) text = `${text}\n\n${VERDICT_SECTION}`
  return text
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

// A model-chosen file name: keep only a plain basename.
export function safeFileName(name: string): string {
  const base = name.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/\.{2,}/g, '.').replace(/[<>:"|?*]/g, '_').trim()
  return clean === '' || clean === '.' ? 'output' : clean
}

// A path without its trailing separators, except that a root ("/", "C:\") keeps one.
function withoutTrailingSlash(raw: string): string {
  const trimmed = raw.replace(/[\\/]+$/, '')
  return trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? raw.slice(0, trimmed.length + 1) : trimmed
}

// `name` made unique among `taken` by a -2, -3 ... before its extension.
function numbered(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const slash = name.lastIndexOf('/') + 1
  const dot = name.lastIndexOf('.')
  const cut = dot > slash ? dot : name.length
  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, cut)}-${n}${name.slice(cut)}`
    if (!taken.has(candidate)) return candidate
  }
}

// The names a predecessor's files get where the next agent reads them: plain
// names, numbered when two reduce to the same one. The prompt and the mounts both use this.
export function handoffNames(names: string[]): string[] {
  const taken = new Set<string>()
  return names.map(name => {
    const unique = numbered(safeFileName(name), taken)
    taken.add(unique)
    return unique
  })
}

export async function gatherContext(
  paths: string[],
  source: ContextSource,
): Promise<{ files: ContextFile[] } | { error: string }> {
  const files: ContextFile[] = []
  // Files from different folders can share a name; each keeps its own mount name.
  const taken = new Set<string>()
  const add = (path: string, relative: string, text: string) => {
    const unique = numbered(relative, taken)
    taken.add(unique)
    files.push({ path, relative: unique, text })
  }
  for (const raw of paths) {
    const path = withoutTrailingSlash(raw)
    const kind = await source.kind(path)
    if (kind === 'missing') return { error: `Context path not found: ${raw}` }
    if (kind === 'file') {
      add(path, baseName(path), await source.read(path))
      continue
    }
    const folder = baseName(path).replace(/:$/, '') || 'root'
    for (const file of await source.files(path)) {
      add(file, `${folder}/${baseName(file)}`, await source.read(file))
    }
  }
  return { files }
}

const encoder = new TextEncoder()

export const contextSize = (files: ContextFile[]): number =>
  files.reduce((sum, f) => sum + encoder.encode(f.text).length, 0)

// `tail` (a reviewer's verdict section) stays the last thing in the prompt, after the context files.
export const localPrompt = (system: string, files: ContextFile[], tail?: string): string =>
  system + files.map(f => `\n\n## Context: ${f.path}\n\n${f.text}`).join('') + (tail === undefined ? '' : `\n\n${tail}`)

export function localSpec(g: Graph, node: AgentNode, prompt: string, description: string): LocalAgentSpec {
  const delegates = outgoing(g, node.id, 'delegate').length > 0
  const tools = node.tools.length === 0
    ? undefined
    : [...new Set([...node.tools, ...(delegates ? ['Agent'] : []), ...(node.skills.length > 0 ? ['Skill'] : [])])]
  return {
    name: agentName(g, node),
    description: node.whenToUse?.trim() || description || node.name,
    prompt,
    ...(tools !== undefined ? { tools } : {}),
    ...(node.model !== null ? { model: node.model } : {}),
    ...(node.skills.length > 0 ? { skills: node.skills } : {}),
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
