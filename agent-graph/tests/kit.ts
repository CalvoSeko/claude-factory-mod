import { test as kitTest, type TestRest } from 'claude-code/testing'

// The pane tests drive whole runs and take seconds each; on a busy machine the kit's 5 s default is too
// tight, so every test here gets 20 s unless it says otherwise.
const TIMEOUT_MS = 20_000

export const test = (name: string, ...rest: TestRest): void =>
  rest.length === 1 ? kitTest(name, { timeoutMs: TIMEOUT_MS }, rest[0]) : kitTest(name, { timeoutMs: TIMEOUT_MS, ...rest[0] }, rest[1])
