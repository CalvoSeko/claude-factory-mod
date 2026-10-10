export type EdgeKind = 'handoff' | 'delegate' | 'retry'
export type BackendKind = 'local' | 'cloud'
export type CloudRef = { agentId: string; version: number; hash: string }

export type AgentNode = {
  id: string
  name: string
  x: number
  y: number
  instructionsFile: string
  skills: string[]
  contextFiles: string[]
  tools: string[]
  model: string | null
  budgetUsd: number
  // When another agent should call this one; shown to its delegators in place of the first instructions line.
  whenToUse?: string
  // Left out of runs: its predecessors hand off straight to its successors.
  disabled?: boolean
  // The run pauses before this agent so the person can read and edit what it is about to receive.
  pauseBefore?: boolean
  // Set: the card is a check card (a shell command that passes or fails), not an agent; its instructionsFile is ''.
  check?: CheckSpec
  cloud?: CloudRef
}

// timeoutMin: 1-60, default 10.
export type CheckSpec = { command: string; timeoutMin: number }

// retries: 'retry' arrows only, 1-10, default 3.
export type Edge = { id: string; from: string; to: string; kind: EdgeKind; retries?: number }

// One judgement of a retry loop: what the card a retry arrow leaves decided in a round.
export type RoundEntry = { round: number; passed: boolean; note: string; at: number }

export type Graph = {
  id: string
  name: string
  description: string
  backend: BackendKind
  nodes: AgentNode[]
  edges: Edge[]
  runCapUsd?: number  // a dollar cap per run: the run is stopped when its cost reaches it
  layout?: 2  // 2: positions are for the 26×5 cards
}

export type GraphIndexEntry = { id: string; name: string }

export type NodeStatus = 'waiting' | 'paused' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'
export type OutputFile = { id: string; name: string; fromNode: string }
export type CallStatus = 'running' | 'ok' | 'failed' | 'denied'
export type ActivityItem = {
  id: string                 // unique within the run
  tool: string               // 'Bash', 'Read', 'mcp__x__y', 'Agent', or the delegate's name
  summary: string            // one line, at most 80 characters
  status: CallStatus
  startedAt: number
  endedAt?: number
  input?: string             // at most 2048 characters (JSON or text), dropped when over the per-agent budget
  result?: string            // at most 2048 characters
  error?: string
  delegate?: { nodeId?: string; name: string; items: ActivityItem[] }   // a call to another agent
}

export type NodeRunView = {
  status: NodeStatus
  output?: string
  error?: string
  link?: string
  costUsd?: number
  // The cost is an estimate (Local agents are priced from a list, not billed).
  costEstimated?: boolean
  startedAt?: number
  endedAt?: number
  // Set when this entry was reused from a saved run instead of run.
  reusedFrom?: { runId: string; at: number }
  // The agent got an input the person edited (or supplied); `prompt` is then the exact text it got.
  inputEdited?: boolean
  prompt?: string
  // What the agent called, in order (its delegate calls nest their own calls).
  activity?: ActivityItem[]
  // Summary of the innermost call that is running now.
  current?: string
  // A delegate helper while it is called: the id of the agent that called it.
  calledBy?: string
  // 1-based, set on every agent of a retry loop once the loop has run twice.
  round?: number
  // On the card a retry arrow leaves: its judgement of each round.
  rounds?: RoundEntry[]
}
export type RunView = {
  graphId: string
  graphName: string
  isRunning: boolean
  nodes: Record<string, NodeRunView>
  task?: string
  result?: string
  outputs?: OutputFile[]
  // Set on a view loaded from a saved record.
  runId?: string
  isHistoric?: boolean
  // Step mode: the run paused before every agent.
  step?: boolean
  // The run cap this run enforces (the graph's cap as the run started), for the toolbar.
  capUsd?: number
}

export type NodeRecord = {
  status: NodeStatus                // as the run ended: done | failed | cancelled | skipped
  inputs: string[]                  // handoff predecessors it received input from (ids)
  output?: string
  error?: string
  files: OutputFile[]
  costUsd?: number
  costEstimated?: boolean
  startedAt?: number
  endedAt?: number
  fingerprint: string               // computed when the run started
  reusedFrom?: { runId: string; at: number }  // set when this entry was reused, not run
  inputEdited?: boolean             // the agent got an input the person edited
  prompt?: string                   // the exact text it got; stored only when edited
  activity?: ActivityItem[]         // what the agent called
  calledBy?: string                 // a delegate helper's entry: the agent that called it
  round?: number                    // as NodeRunView.round
  rounds?: RoundEntry[]             // as NodeRunView.rounds
}

export type RunRecord = {
  id: string
  graphId: string
  graphName: string
  task: string
  mode: 'full' | 'from-here' | 'tool' | 'test'
  fromNode?: string                 // mode 'from-here': the clicked agent
  testId?: string                   // mode 'test': the test that was run
  startedAt: number
  endedAt: number
  ending: 'finished' | 'stopped' | 'failed' | 'over-cap'
  graph: { nodes: Omit<AgentNode, 'x' | 'y'>[]; edges: Edge[] }  // as it ran (after disable-rewiring)
  nodes: Record<string, NodeRecord>
  result: string
  outputs: OutputFile[]
}

export type RunSummary = {
  id: string; at: number; ending: RunRecord['ending']; mode: RunRecord['mode']
  fromName?: string; taskLine: string; costUsd: number
  costEstimated?: boolean                               // some of the counted cost is an estimate
  testName?: string                                     // mode 'test'
}

// Per graph, in the plugin store: the list for drawing, and each agent's newest saved entry.
export type RunIndex = {
  runs: RunSummary[]                                    // newest first
  // producedAt: when the output was made (a reused entry keeps its first run's time); absent in entries saved before it existed.
  latest: Record<string, { runId: string; at: number; producedAt?: number; fingerprint: string; task: string; status: NodeStatus }>
}

export type Connecting =
  | { stage: 'source' }
  | { stage: 'target'; from: string }
  | { stage: 'kind'; from: string; to: string }

export type PaneUi = {
  isOpen: boolean
  graphId: string | null
  selected: string | null
  connecting: Connecting | null
  task: string
  notice: string | null
  // What the canvas has under the pointer or picked: an arrow, a card, or neither; the vector layer highlights it.
  focus?: { edge: string | null; card: string | null }
  // The inspector's last-run text shows in full, and the run history lists every kept run.
  lastRunMore?: boolean
  // The paused agent's input shows in full.
  inputMore?: boolean
  allRuns?: boolean
  // The Activity rows of the inspector that are open (item ids), and whether it lists every call, not the newest 30.
  openCalls?: string[]
  allCalls?: boolean
  // The run timeline shows under the canvas.
  timeline?: boolean
  // The test whose "must hold" notes are being edited, and the test whose delete is waiting for a second press.
  editingTest?: string | null
  armedTest?: string | null
}

// A saved run turned into a test: re-run against the current graph and graded against the accepted result.
export type TestCase = {
  id: string
  name: string                      // first non-empty line of the task, clipped to 40
  task: string
  expected: string                  // the accepted result text
  mustHold: string                  // the person's notes, may be ''
  createdAt: number
  fromRun: string
  last?: { verdict: 'pass' | 'fail' | 'ungraded'; reason: string; runId: string; at: number; result: string }
}

declare module 'claude-code' {
  interface PluginState {
    'agent-graph': { index: GraphIndexEntry[]; graph: Graph | null; ui: PaneUi; run: RunView | null }
  }
}
