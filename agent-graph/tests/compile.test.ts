import { expect } from 'claude-code/testing'
import { test } from './kit'

import type { AgentNode, Graph } from '../types'
import {
  agentName, agentType, contextSize, gatherContext, localPrompt, localSpec, safeFileName, sha256Hex, systemText, type ContextSource,
} from '../hooks/compile'
import { connect } from '../hooks/model'

const node = (id: string, name: string, over: Partial<AgentNode> = {}): AgentNode => ({
  id, name, x: 0, y: 0, instructionsFile: `${id}.md`, skills: [], contextFiles: [], tools: [], model: null, budgetUsd: 2, ...over,
})
const base: Graph = {
  id: 'g', name: 'Research Flow', description: '', backend: 'local',
  nodes: [node('a', 'Lead'), node('b', 'Reader')], edges: [],
}
const texts: Record<string, string> = { 'a.md': 'You lead.\nPlan first.', 'b.md': '# Reads sources\nCarefully.' }
const instructions = async (n: AgentNode) => texts[n.instructionsFile] ?? ''

test('agent types are namespaced by graph and node', async () => {
  expect(agentType(base, base.nodes[0]!)).toBe('agent-graph:research-flow--lead-a')
})

test('agent names stay unique when node names share a slug, and fit 64 characters', async () => {
  const g: Graph = { ...base, nodes: [node('n_aaaaaa1111', 'A/B'), node('n_bbbbbb2222', 'A B')] }
  expect(agentName(g, g.nodes[0]!)).not.toBe(agentName(g, g.nodes[1]!))
  const long: Graph = { ...base, name: 'x'.repeat(80) }
  const name = agentName(long, node('n_cccccc3333', 'y'.repeat(80)))
  expect(name.length <= 64, name).toBe(true)
  expect(name.endsWith('-cc3333')).toBe(true)
})

test('system text lists delegates with their first line', async () => {
  const g = connect(base, 'a', 'b', 'delegate')
  const local = await systemText(g, g.nodes[0]!, instructions, 'local')
  expect(local).toContain('You lead.')
  expect(local).toContain('## You may delegate to')
  expect(local).toContain('- Reader (subagent_type "agent-graph:research-flow--reader-b"): Reads sources')
  const cloud = await systemText(g, g.nodes[0]!, instructions, 'cloud')
  expect(cloud).toContain('- Reader: Reads sources')
  expect(await systemText(g, g.nodes[1]!, instructions, 'local')).toBe('# Reads sources\nCarefully.')
})

test('context gathering reads files and one level of folders, and reports missing paths', async () => {
  const fs: Record<string, string> = { 'spec.md': 'S', 'docs/a.md': 'A', 'docs/b.md': 'B' }
  const source: ContextSource = {
    kind: async p => (p === 'docs' ? 'dir' : fs[p] !== undefined ? 'file' : 'missing'),
    read: async p => fs[p] ?? '',
    files: async d => Object.keys(fs).filter(p => p.startsWith(`${d}/`)),
  }
  const gathered = await gatherContext(['spec.md', 'docs'], source)
  expect('files' in gathered ? gathered.files.map(f => f.relative) : []).toEqual(['spec.md', 'docs/a.md', 'docs/b.md'])
  expect(await gatherContext(['nope.md'], source)).toEqual({ error: 'Context path not found: nope.md' })
})

test('local prompt and spec include context, delegation and skills', async () => {
  const g = connect(base, 'a', 'b', 'delegate')
  const lead = { ...g.nodes[0]!, tools: ['Read'], skills: ['tdd'], model: 'sonnet' }
  const prompt = localPrompt('SYS', [{ path: 'spec.md', relative: 'spec.md', text: 'S' }])
  expect(prompt).toBe('SYS\n\n## Context: spec.md\n\nS')
  expect(contextSize([{ path: 'x', relative: 'x', text: 'héllo' }])).toBe(6)
  expect(localSpec(g, lead, prompt, 'Lead desc')).toEqual({
    name: 'research-flow--lead-a', description: 'Lead desc', prompt,
    tools: ['Read', 'Agent', 'Skill'], model: 'sonnet', skills: ['tdd'],
  })
  expect(localSpec(g, g.nodes[1]!, 'P', '')).toEqual({ name: 'research-flow--reader-b', description: 'Reader', prompt: 'P' })
})

test('sha256Hex hashes text', async () => {
  expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('a delegate is described by its when-to-use, else its first instructions line', async () => {
  const withUse: Graph = connect({ ...base, nodes: [base.nodes[0]!, node('b', 'Reader', { whenToUse: ' Call me to read sources ' })] }, 'a', 'b', 'delegate')
  expect(await systemText(withUse, withUse.nodes[0]!, instructions, 'local')).toContain('"agent-graph:research-flow--reader-b"): Call me to read sources')
  expect(await systemText(withUse, withUse.nodes[0]!, instructions, 'cloud')).toContain('- Reader: Call me to read sources')
  const blank: Graph = connect({ ...base, nodes: [base.nodes[0]!, node('b', 'Reader', { whenToUse: '  ' })] }, 'a', 'b', 'delegate')
  expect(await systemText(blank, blank.nodes[0]!, instructions, 'cloud')).toContain('- Reader: Reads sources')
  expect(localSpec(base, node('b', 'Reader', { whenToUse: 'Use me' }), 'p', 'Reads sources').description).toBe('Use me')
  expect(localSpec(base, node('b', 'Reader'), 'p', 'Reads sources').description).toBe('Reads sources')
})

test('context files that share a name get a numbered mount name', async () => {
  const fs: Record<string, string> = { 'a/spec.md': '1', 'b/spec.md': '2', 'c/spec.md': '3', 'a/spec-2.md': '4', 'x/docs/n.txt': '5', 'y/docs/n.txt': '6' }
  const source: ContextSource = {
    kind: async p => (p === 'x/docs' || p === 'y/docs' ? 'dir' : fs[p] !== undefined ? 'file' : 'missing'),
    read: async p => fs[p] ?? '',
    files: async d => Object.keys(fs).filter(p => p.startsWith(`${d}/`)),
  }
  const gathered = await gatherContext(['a/spec.md', 'b/spec.md', 'c/spec.md', 'a/spec-2.md', 'x/docs', 'y/docs'], source)
  const files = 'files' in gathered ? gathered.files : []
  expect(files.map(f => f.relative)).toEqual(['spec.md', 'spec-2.md', 'spec-3.md', 'spec-2-2.md', 'docs/n.txt', 'docs/n-2.txt'])
  expect(files.map(f => f.text)).toEqual(['1', '2', '3', '4', '5', '6'])
})

test('a root folder keeps its separator and is not turned into an empty path', async () => {
  const asked: string[] = []
  const source: ContextSource = {
    kind: async p => { asked.push(p); return 'dir' },
    read: async () => '',
    files: async () => [],
  }
  await gatherContext(['/', 'C:/', 'C:\\', 'docs/', 'docs\\'], source)
  expect(asked).toEqual(['/', 'C:/', 'C:\\', 'docs', 'docs'])
})

test('safeFileName keeps a plain basename', async () => {
  expect(safeFileName('../../etc/passwd')).toBe('passwd')
  expect(safeFileName('')).toBe('output')
})

const VERDICT = '## Verdict\n\nEnd your answer with a line that says exactly `VERDICT: pass` if the work meets the bar, or `VERDICT: fail` and what must change.'

test('an agent with a retry arrow out gets the verdict section last, and others do not', async () => {
  const g = connect(connect(base, 'a', 'b', 'handoff'), 'b', 'a', 'retry')
  expect(await systemText(g, g.nodes[1]!, instructions, 'local')).toBe(`# Reads sources\nCarefully.\n\n${VERDICT}`)
  expect(await systemText(g, g.nodes[0]!, instructions, 'local')).toBe('You lead.\nPlan first.')
  expect(await systemText(base, base.nodes[1]!, instructions, 'local')).not.toContain('## Verdict')
})

test('the verdict section comes after the delegate section', async () => {
  const g: Graph = { ...base, nodes: [...base.nodes, node('c', 'Helper')] }
  const wired = connect(connect(connect(g, 'a', 'b', 'handoff'), 'b', 'c', 'delegate'), 'b', 'a', 'retry')
  const text = await systemText(wired, wired.nodes[1]!, instructions, 'local')
  expect(text.indexOf('## You may delegate to')).toBeGreaterThan(0)
  expect(text.endsWith(`\n\n${VERDICT}`)).toBe(true)
  expect(text.indexOf('## Verdict')).toBeGreaterThan(text.indexOf('## You may delegate to'))
})
