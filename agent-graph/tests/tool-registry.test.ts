import { expect } from 'claude-code/testing'
import type { ToolSpec } from 'claude-code'
import { test } from './kit'

import { registerEditorTools, type Host } from '../hooks/actions'
import { createToolRegistry, retiredSpec, staleRunTools, type ListedTool } from '../hooks/tools'

// An engine that records every spec it is sent; `fail` makes the next send reject.
const engine = () => {
  const sent: ToolSpec[] = []
  const e = {
    sent,
    fail: false,
    register: async (spec: ToolSpec) => {
      if (e.fail) {
        e.fail = false
        throw new Error('reconnect failed')
      }
      sent.push(spec)
    },
  }
  return e
}

const spec = (name: string, description = 'Runs it.'): ToolSpec => ({ name, description, inputSchema: { type: 'object', properties: {} } })
const PREFIX = 'mcp__agent-graph__run_'
const listed = (short: string, description = 'Runs it.'): ListedTool => ({ name: `mcp__agent-graph__${short}`, description })

test('the same spec sent twice reaches the engine once', async () => {
  const e = engine()
  const registry = createToolRegistry()
  await registry.register(e, spec('run_a'))
  await registry.register(e, spec('run_a'))
  expect(e.sent.map(s => s.name)).toEqual(['run_a'])
})

test('a changed description is sent again', async () => {
  const e = engine()
  const registry = createToolRegistry()
  await registry.register(e, spec('run_a', 'Old.'))
  await registry.register(e, spec('run_a', 'New.'))
  expect(e.sent.map(s => s.description)).toEqual(['Old.', 'New.'])
})

test('a rejected send is not remembered: the next one is sent', async () => {
  const e = engine()
  const registry = createToolRegistry()
  e.fail = true
  await expect(registry.register(e, spec('run_a'))).rejects.toThrow('reconnect failed')
  expect(registry.stateOf('run_a')).toBeUndefined()
  await registry.register(e, spec('run_a'))
  expect(e.sent.map(s => s.name)).toEqual(['run_a'])
})

test('the state of a name is what was last sent under it: live, retired, or nothing', async () => {
  const e = engine()
  const registry = createToolRegistry()
  expect(registry.stateOf('run_a')).toBeUndefined()
  await registry.register(e, spec('run_a'))
  expect(registry.stateOf('run_a')).toBe('live')
  expect(registry.liveNames()).toEqual(['run_a'])
  await registry.register(e, retiredSpec('run_a', 'the agent graph "A" was deleted.'))
  expect(registry.stateOf('run_a')).toBe('retired')
  expect(registry.liveNames()).toEqual([])
})

test('a retired spec is a deferred note with no input that says not to call it', () => {
  expect(retiredSpec('run_a', 'the agent graph "A" was renamed.')).toEqual({
    name: 'run_a',
    description: 'Retired: the agent graph "A" was renamed. Do not call this tool.',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: true,
  })
})

test('the sweep retires listed live run tools no graph wants, and leaves retired, other and wanted tools', () => {
  const registry = createToolRegistry()
  const list = [
    listed('run_gone_123456'),
    listed('run_old_654321', 'Retired: the agent graph "Old" was deleted. Do not call this tool.'),
    listed('read_graph'),
    listed('run_kept_111111'),
  ]
  expect(staleRunTools(list, new Set(['run_kept_111111']), PREFIX, registry)).toEqual(['run_gone_123456'])
})

test('the sweep also retires a run tool this instance sent live that is not listed and not wanted', async () => {
  const registry = createToolRegistry()
  await registry.register(engine(), spec('run_mine_222222'))
  await registry.register(engine(), spec('edit_graph'))
  expect(staleRunTools([], new Set(), PREFIX, registry)).toEqual(['run_mine_222222'])
})

test('the sweep leaves a name this instance last sent retired, even when the list still shows it live', async () => {
  const registry = createToolRegistry()
  await registry.register(engine(), retiredSpec('run_gone_123456', 'the agent graph "Gone" was deleted.'))
  expect(staleRunTools([listed('run_gone_123456')], new Set(), PREFIX, registry)).toEqual([])
})

test('when the list failed, the sweep still retires the live run tools this instance sent that no graph wants', async () => {
  const registry = createToolRegistry()
  await registry.register(engine(), spec('run_mine_222222'))
  await registry.register(engine(), spec('run_kept_111111'))
  expect(staleRunTools(undefined, new Set(['run_kept_111111']), PREFIX, registry)).toEqual(['run_mine_222222'])
})

// The editor tools' registry is module memory (this file's instance sends each once), so this is the file's only test of them.
test('a read_graph that cannot be registered does not keep edit_graph from being registered, and is reported', async () => {
  const e = engine()
  e.fail = true
  const failures = await registerEditorTools({ tool: e } as unknown as Host)
  expect(failures).toEqual(['reconnect failed'])
  expect(e.sent.map(s => s.name)).toEqual(['edit_graph'])
})
