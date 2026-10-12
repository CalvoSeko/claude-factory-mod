import type { BandAgent, Graph, GraphIndexEntry, PaneUi, RunView } from '../types'

export const PANE_ID = 'agent-graph'

export const EMPTY_UI: PaneUi = { isOpen: false, graphId: null, selected: null, connecting: null, task: '', notice: null }

// The five values by name: what the actions read and update through the host. Their atoms are
// declared in register.tsx, as the engine reads the atoms a module uses from consts of its own file.
export type Slots = { index: GraphIndexEntry[]; graph: Graph | null; ui: PaneUi; run: RunView | null; agents: BandAgent[] }
