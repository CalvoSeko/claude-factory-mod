import type { AgentNode, Edge, Graph, GraphIndexEntry } from '../types'
import { isCap } from './cost'
import {
  DEFAULT_BUDGET_USD, DEFAULT_CHECK_TIMEOUT_MIN, DEFAULT_RETRIES, DEFAULT_RUN_CAP_USD, emptyGraph, INSTRUCTIONS_TEMPLATE, isCheck,
  MAX_BUDGET_USD, MAX_CHECK_TIMEOUT_MIN, MAX_RETRIES, MAX_RUN_CAP_USD, newId, upgradeLayout, withoutNode,
} from './model'

export type KeyValue = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export type TextFiles = {
  read(path: string): Promise<string | undefined>
  // A change is for one graph: refused (a toast, nothing done) unless the path is inside <root>/<graphId>/.
  write(graphId: string, path: string, text: string): Promise<void>
  remove(graphId: string, path: string): Promise<void>
  // The graph's whole folder, <root>/<graphId>, in one process.
  removeDir(graphId: string): Promise<void>
}

export type Library = ReturnType<typeof createLibrary>

const INDEX_KEY = 'graphs'
const graphKey = (id: string) => `graph:${id}`

export { INSTRUCTIONS_TEMPLATE }

export function createLibrary(store: KeyValue, files: TextFiles, root: string) {
  async function index(): Promise<GraphIndexEntry[]> {
    return ((await store.get(INDEX_KEY)) as GraphIndexEntry[] | undefined) ?? []
  }

  async function load(id: string): Promise<Graph | undefined> {
    const graph = (await store.get(graphKey(id))) as Graph | undefined
    return graph === undefined ? undefined : upgradeLayout(graph)
  }

  async function save(graph: Graph): Promise<void> {
    await store.set(graphKey(graph.id), graph)
    const list = (await index()).filter(e => e.id !== graph.id)
    list.push({ id: graph.id, name: graph.name })
    list.sort((a, b) => a.name.localeCompare(b.name))
    await store.set(INDEX_KEY, list)
  }

  async function isTaken(name: string, exceptId?: string): Promise<boolean> {
    const key = name.trim().toLowerCase()
    return (await index()).some(e => e.id !== exceptId && e.name.toLowerCase() === key)
  }

  async function create(name: string): Promise<Graph> {
    const base = name.trim() || 'New graph'
    let candidate = base
    for (let n = 2; await isTaken(candidate); n++) candidate = `${base} ${n}`
    const graph = emptyGraph(candidate)
    await save(graph)
    return graph
  }

  async function rename(graph: Graph, name: string): Promise<Graph | string> {
    if (name.trim() === '') return 'A graph needs a name.'
    if (await isTaken(name, graph.id)) return `A graph called "${name.trim()}" already exists.`
    const renamed = { ...graph, name: name.trim() }
    await save(renamed)
    return renamed
  }

  // The graph is gone from the library first (whoever loads it meanwhile finds nothing), then its
  // instructions files, unless the caller removes the whole folder itself.
  async function remove(graph: Graph, options: { files?: boolean } = {}): Promise<void> {
    await store.set(INDEX_KEY, (await index()).filter(e => e.id !== graph.id))
    await store.delete(graphKey(graph.id))
    if (options.files === false) return
    for (const n of graph.nodes) if (!isCheck(n)) await files.remove(graph.id, n.instructionsFile)
  }

  async function addNode(graph: Graph, name: string, x: number, y: number): Promise<Graph> {
    const node = agentNode(root, graph.id, name, x, y)
    await files.write(graph.id, node.instructionsFile, INSTRUCTIONS_TEMPLATE(name))
    return { ...graph, nodes: [...graph.nodes, node] }
  }

  async function removeNode(graph: Graph, id: string): Promise<Graph> {
    const node = graph.nodes.find(n => n.id === id)
    // A check card has no instructions file.
    if (node !== undefined && !isCheck(node)) await files.remove(graph.id, node.instructionsFile)
    return withoutNode(graph, id)
  }

  async function instructions(node: AgentNode): Promise<string> {
    return isCheck(node) ? '' : ((await files.read(node.instructionsFile)) ?? '')
  }

  // A graph made outside the pane joins under its own id; one already in the library is left alone (undefined),
  // and a name already taken gets a number. Its agent cards read instructions only from its own folder, its cloud
  // links are dropped (they would reuse or overwrite a cloud agent of the person's), and it is saved untrusted.
  async function importGraph(graph: Graph): Promise<Graph | undefined> {
    if ((await index()).some(e => e.id === graph.id)) return undefined
    const base = graph.name.trim() || 'Imported graph'
    let name = base
    for (let n = 2; await isTaken(name); n++) name = `${base} ${n}`
    const nodes = graph.nodes.map(({ cloud: _dropped, ...n }) => ({ ...n, instructionsFile: isCheck(n) ? '' : `${root}/${graph.id}/${n.id}.md` }))
    const imported = upgradeLayout({ ...graph, name, nodes, trusted: false })
    await save(imported)
    return imported
  }

  return { index, load, save, create, rename, remove, addNode, removeNode, instructions, importGraph }
}

// A new agent card whose instructions file is <root>/<graphId>/<id>.md (addNode writes the template there).
export function agentNode(root: string, graphId: string, name: string, x: number, y: number): AgentNode {
  const id = newId('n')
  return {
    id, name, x, y, instructionsFile: `${root}/${graphId}/${id}.md`,
    skills: [], contextFiles: [], tools: [], model: null, budgetUsd: DEFAULT_BUDGET_USD,
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const EDGE_KINDS: ReadonlySet<string> = new Set(['handoff', 'delegate', 'retry'])

// Graph, node and edge ids: letters, digits, _ and -, and never a Windows device name (CON, NUL, COM1 …).
export const ID = /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[A-Za-z0-9_-]+$/i
// A path segment the file system opens as written: no leading dot (never `.` or `..`), no spaces, nothing Win32 trims.
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/

// Whether `path` (with `\` read as `/`) is `<root>/<graphId>/` plus one or more plain segments, for a graph id that is an ID.
export function inGraphFolder(root: string, graphId: string, path: string): boolean {
  const folder = `${root.replace(/\\/g, '/')}/${graphId}/`
  const plain = path.replace(/\\/g, '/')
  return ID.test(graphId) && plain.startsWith(folder) && plain.slice(folder.length).split('/').every(s => SEGMENT.test(s))
}

// The limits an import and edit_graph both keep: an import replaces a value outside them, edit_graph refuses it.
export const isBudget = (usd: unknown): usd is number => isCap(usd) && usd <= MAX_BUDGET_USD
export const isRunCap = (usd: unknown): usd is number => isCap(usd) && usd <= MAX_RUN_CAP_USD
export const isRetries = (r: unknown): r is number => typeof r === 'number' && Number.isInteger(r) && r >= 0 && r <= MAX_RETRIES
export const isTimeout = (t: unknown): t is number => typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= MAX_CHECK_TIMEOUT_MIN
// A list of strings: an empty tools list means every tool, so a bad value must not become one.
export const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')
const minutes = (t: unknown) =>
  typeof t === 'number' && Number.isFinite(t) ? Math.min(Math.max(Math.round(t), 1), MAX_CHECK_TIMEOUT_MIN) : DEFAULT_CHECK_TIMEOUT_MIN

// What an import file holds, checked enough that the pane can draw it and validation can name its problems, with
// its ids safe to use in paths and its limits clamped; a string says what is wrong.
export function asGraph(value: unknown): Graph | string {
  if (!isRecord(value)) return 'not a graph object.'
  if (typeof value['id'] !== 'string' || !ID.test(value['id'])) return 'its id is missing or has characters other than letters, digits, _ and -.'
  if (typeof value['name'] !== 'string') return 'its name is missing.'
  if (value['backend'] !== 'local' && value['backend'] !== 'headless' && value['backend'] !== 'cloud') return 'its backend must be "local", "headless" or "cloud".'
  const nodes = value['nodes']
  const edges = value['edges']
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return 'it needs nodes and edges lists.'
  for (const n of nodes) {
    if (!isRecord(n) || typeof n['id'] !== 'string' || typeof n['name'] !== 'string' || typeof n['x'] !== 'number' || typeof n['y'] !== 'number' || typeof n['instructionsFile'] !== 'string') {
      return 'every node needs an id, a name, x, y and an instructionsFile.'
    }
    if (!ID.test(n['id'])) return 'every node id may only have letters, digits, _ and -.'
    const check = n['check']
    if (check !== undefined && !(isRecord(check) && typeof check['command'] === 'string')) return 'every check card needs a command.'
    if (![n['tools'], n['skills'], n['contextFiles']].every(v => v === undefined || isTextList(v))) return "every node's tools, skills and contextFiles must be lists of text."
    if (n['whenToUse'] !== undefined && typeof n['whenToUse'] !== 'string') return "every node's whenToUse must be text."
  }
  for (const e of edges) {
    if (!isRecord(e) || typeof e['id'] !== 'string' || typeof e['from'] !== 'string' || typeof e['to'] !== 'string' || !EDGE_KINDS.has(String(e['kind']))) {
      return 'every edge needs an id, from, to and a kind of handoff, delegate or retry.'
    }
    if (!ID.test(e['id'])) return 'every edge id may only have letters, digits, _ and -.'
  }
  const node = (n: Record<string, unknown>): AgentNode => {
    const card = { skills: [], contextFiles: [], tools: [], model: null, ...(n as Partial<AgentNode>) } as AgentNode
    return {
      ...card,
      budgetUsd: isBudget(card.budgetUsd) ? card.budgetUsd : DEFAULT_BUDGET_USD,
      ...(card.check === undefined ? {} : { check: { ...card.check, timeoutMin: minutes(card.check.timeoutMin) } }),
    }
  }
  const edge = (e: Edge): Edge => (e.retries === undefined ? e : { ...e, retries: isRetries(e.retries) ? e.retries : DEFAULT_RETRIES })
  return {
    ...(value as unknown as Graph),
    description: typeof value['description'] === 'string' ? value['description'] : '',
    nodes: (nodes as Record<string, unknown>[]).map(node),
    edges: (edges as Edge[]).map(edge),
    runCapUsd: isRunCap(value['runCapUsd']) ? value['runCapUsd'] : DEFAULT_RUN_CAP_USD,
  }
}
