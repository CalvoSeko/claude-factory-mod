import type { ToolSpec } from 'claude-code'

export type ToolEngine = { register(spec: ToolSpec): Promise<unknown> }
export type ListedTool = { name: string; description: string }

const RETIRED = 'Retired:'

// The deferred note that replaces a tool the engine cannot unregister.
export const retiredSpec = (name: string, why: string): ToolSpec => ({
  name,
  description: `${RETIRED} ${why} Do not call this tool.`,
  inputSchema: { type: 'object', properties: {} },
  isDeferred: true,
})

export type ToolRegistry = {
  // Sends the spec unless the same spec (JSON) is the last one sent under its name; a rejected send is not remembered.
  register(engine: ToolEngine, spec: ToolSpec): Promise<void>
  // What this instance last sent under the name: a live spec, a retired one, or nothing.
  stateOf(name: string): 'live' | 'retired' | undefined
  // Every name this instance last sent live.
  liveNames(): string[]
}

// Each register is an MCP reconnect, so an unchanged spec is not sent again. Module memory: a fresh
// instance (every reload) sends everything once.
export function createToolRegistry(): ToolRegistry {
  const sent = new Map<string, ToolSpec>()
  const stateOf = (name: string) => {
    const spec = sent.get(name)
    return spec === undefined ? undefined : spec.description.startsWith(RETIRED) ? 'retired' : 'live'
  }
  return {
    async register(engine, spec) {
      const last = sent.get(spec.name)
      if (last !== undefined && JSON.stringify(last) === JSON.stringify(spec)) return
      await engine.register(spec)
      sent.set(spec.name, spec)
    },
    stateOf,
    liveNames: () => [...sent.keys()].filter(name => stateOf(name) === 'live'),
  }
}

// Short names of run tools to retire: those listed by the engine under `runPrefix` (TOOL_PREFIX, the full
// `mcp__agent-graph__run_`) with a description not starting "Retired:", plus the registry's live names starting `run_`,
// minus `wanted` (short names) and minus names the registry last sent retired. `listed` undefined = the list failed.
export function staleRunTools(listed: readonly ListedTool[] | undefined, wanted: ReadonlySet<string>, runPrefix: string, registry: ToolRegistry): string[] {
  const listedLive = (listed ?? [])
    .filter(t => t.name.startsWith(runPrefix) && !t.description.startsWith(RETIRED))
    .map(t => `run_${t.name.slice(runPrefix.length)}`)
  const names = new Set([...listedLive, ...registry.liveNames().filter(name => name.startsWith('run_'))])
  return [...names].filter(name => !wanted.has(name) && registry.stateOf(name) !== 'retired')
}
