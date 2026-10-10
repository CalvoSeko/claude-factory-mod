import type { Graph, RunIndex, RunRecord } from '../types'
import type { KeyValue, TextFiles } from './library'
import { withRecord } from './records'

const indexKey = (graphId: string) => `runs:${graphId}`

// Run records: one JSON file per run, and an index (the list for drawing and each
// agent's newest entry) under the plugin store key `runs:<graphId>`.
export function createRunStore(store: KeyValue, files: TextFiles, root: string) {
  const fileOf = (graphId: string, runId: string) => `${root}/${graphId}/runs/${runId}.json`

  async function index(graphId: string): Promise<RunIndex> {
    const saved = (await store.get(indexKey(graphId))) as RunIndex | undefined
    return saved === undefined ? { runs: [], latest: {} } : saved
  }

  // Latest entries of agents the graph no longer has are forgotten, so a run that only
  // they named can be retired.
  const onlyAgentsOf = (latest: RunIndex['latest'], g: Graph): RunIndex['latest'] => {
    const live = new Set(g.nodes.map(n => n.id))
    return Object.fromEntries(Object.entries(latest).filter(([id]) => live.has(id)))
  }

  async function write(record: RunRecord, g: Graph): Promise<void> {
    const before = await index(record.graphId)
    await files.write(fileOf(record.graphId, record.id), JSON.stringify(record))
    const saved = withRecord({ runs: before.runs, latest: onlyAgentsOf(before.latest, g) }, record)
    try {
      await store.set(indexKey(record.graphId), { runs: saved.index.runs, latest: onlyAgentsOf(saved.index.latest, g) })
    } catch (error) {
      // No index entry names the file: it would stay for good.
      await files.remove(fileOf(record.graphId, record.id))
      throw error
    }
    for (const id of saved.dropped) await files.remove(fileOf(record.graphId, id))
  }

  async function read(graphId: string, runId: string): Promise<RunRecord | undefined> {
    const text = await files.read(fileOf(graphId, runId))
    if (text === undefined) return undefined
    try {
      const parsed = JSON.parse(text) as RunRecord | null
      return typeof parsed === 'object' && parsed !== null && typeof parsed.nodes === 'object' && parsed.nodes !== null ? parsed : undefined
    } catch {
      return undefined
    }
  }

  // Forgets one run: its file, its summary and any newest entries that name it.
  async function drop(graphId: string, runId: string): Promise<void> {
    const before = await index(graphId)
    await store.set(indexKey(graphId), {
      runs: before.runs.filter(s => s.id !== runId),
      latest: Object.fromEntries(Object.entries(before.latest).filter(([, l]) => l.runId !== runId)),
    })
    await files.remove(fileOf(graphId, runId))
  }

  // Forgets the graph's runs. The record files sit in the graph's own folder, which deleteGraph removes
  // in one process (a process per record would not fit the hook's time).
  async function removeGraph(graphId: string): Promise<void> {
    await store.delete(indexKey(graphId))
  }

  return { index, write, read, drop, removeGraph, fileOf }
}

export type RunStore = ReturnType<typeof createRunStore>
