import type { AgentNode, Graph, GraphIndexEntry } from '../types'
import { DEFAULT_BUDGET_USD, emptyGraph, INSTRUCTIONS_TEMPLATE, isCheck, newId, upgradeLayout, withoutNode } from './model'

export type KeyValue = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export type TextFiles = {
  read(path: string): Promise<string | undefined>
  write(path: string, text: string): Promise<void>
  remove(path: string): Promise<void>
  // A folder and everything in it, in one process.
  removeDir(path: string): Promise<void>
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
    for (const n of graph.nodes) if (!isCheck(n)) await files.remove(n.instructionsFile)
  }

  async function addNode(graph: Graph, name: string, x: number, y: number): Promise<Graph> {
    const id = newId('n')
    const instructionsFile = `${root}/${graph.id}/${id}.md`
    await files.write(instructionsFile, INSTRUCTIONS_TEMPLATE(name))
    const node: AgentNode = {
      id, name, x, y, instructionsFile,
      skills: [], contextFiles: [], tools: [], model: null, budgetUsd: DEFAULT_BUDGET_USD,
    }
    return { ...graph, nodes: [...graph.nodes, node] }
  }

  async function removeNode(graph: Graph, id: string): Promise<Graph> {
    const node = graph.nodes.find(n => n.id === id)
    // A check card has no instructions file.
    if (node !== undefined && !isCheck(node)) await files.remove(node.instructionsFile)
    return withoutNode(graph, id)
  }

  async function instructions(node: AgentNode): Promise<string> {
    return isCheck(node) ? '' : ((await files.read(node.instructionsFile)) ?? '')
  }

  // A graph made outside the pane joins under its own id; one already in the library is left alone (undefined),
  // and a name already taken gets a number.
  async function importGraph(graph: Graph): Promise<Graph | undefined> {
    if ((await index()).some(e => e.id === graph.id)) return undefined
    const base = graph.name.trim() || 'Imported graph'
    let name = base
    for (let n = 2; await isTaken(name); n++) name = `${base} ${n}`
    const imported = upgradeLayout({ ...graph, name })
    await save(imported)
    return imported
  }

  return { index, load, save, create, rename, remove, addNode, removeNode, instructions, importGraph }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const EDGE_KINDS = new Set(['handoff', 'delegate', 'retry'])

// What an import file holds, checked enough that the pane can draw it and validation can name its problems;
// a string says what is wrong.
export function asGraph(value: unknown): Graph | string {
  if (!isRecord(value)) return 'not a graph object.'
  if (typeof value['id'] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value['id'])) return 'its id is missing or has characters other than letters, digits, _ and -.'
  if (typeof value['name'] !== 'string') return 'its name is missing.'
  if (value['backend'] !== 'local' && value['backend'] !== 'headless' && value['backend'] !== 'cloud') return 'its backend must be "local", "headless" or "cloud".'
  const nodes = value['nodes']
  const edges = value['edges']
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return 'it needs nodes and edges lists.'
  for (const n of nodes) {
    if (!isRecord(n) || typeof n['id'] !== 'string' || typeof n['name'] !== 'string' || typeof n['x'] !== 'number' || typeof n['y'] !== 'number' || typeof n['instructionsFile'] !== 'string') {
      return 'every node needs an id, a name, x, y and an instructionsFile.'
    }
  }
  for (const e of edges) {
    if (!isRecord(e) || typeof e['id'] !== 'string' || typeof e['from'] !== 'string' || typeof e['to'] !== 'string' || !EDGE_KINDS.has(String(e['kind']))) {
      return 'every edge needs an id, from, to and a kind of handoff, delegate or retry.'
    }
  }
  const node = (n: Record<string, unknown>): AgentNode => ({
    skills: [], contextFiles: [], tools: [], model: null, budgetUsd: DEFAULT_BUDGET_USD,
    ...(n as Partial<AgentNode>),
  } as AgentNode)
  return {
    ...(value as unknown as Graph),
    description: typeof value['description'] === 'string' ? value['description'] : '',
    nodes: (nodes as Record<string, unknown>[]).map(node),
  }
}
