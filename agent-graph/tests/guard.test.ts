import { expect } from 'claude-code/testing'
import { test } from './kit'

import { ownSpawn } from '../hooks/guard'

test('the mod answers only for its own starts of its own card agents', async () => {
  expect(ownSpawn('agent-graph', { subagent_type: 'agent-graph:software-factory-v2--design-ee515d', prompt: 'p' })).toBe(true)
  // Another plugin, or the model's own call, is left to the permission mode.
  expect(ownSpawn('other-plugin', { subagent_type: 'agent-graph:software-factory-v2--design-ee515d' })).toBe(false)
  expect(ownSpawn('engine', { subagent_type: 'agent-graph:software-factory-v2--design-ee515d' })).toBe(false)
  // The mod starting any other agent type is not covered either.
  expect(ownSpawn('agent-graph', { subagent_type: 'general-purpose' })).toBe(false)
  expect(ownSpawn('agent-graph', { prompt: 'p' })).toBe(false)
  expect(ownSpawn('agent-graph', null)).toBe(false)
  expect(ownSpawn('agent-graph', undefined)).toBe(false)
})

test('the permission check of an Agent call raised by someone else goes on to the permission mode', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const r = await $.tool.check({ tool: 'Agent', input: { subagent_type: 'agent-graph:flow--researcher-a1', prompt: 'p', description: 'd' } })
  expect(r.decision).toBe('ask')
})
