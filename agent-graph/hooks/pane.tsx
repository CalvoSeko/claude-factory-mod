import type { Elements, EngineInterface, RenderElement } from 'claude-code'

import type { ActivityItem, AgentNode, EdgeKind, Graph, RunSummary, RunView, TestCase } from '../types'
import {
  acceptLatest, addAgent, addCheck, cachedInstructions, cachedLastRun, cachedRunIndex, cachedSkills, cachedTests, cancelConnect, compareTest, confirmEdge, continueAgent, continueAll,
  deleteGraph, deleteSelected, deleteTest, describeGraph, editInstructions, editLastInput, editMustHold, editPausedInput, hasInputReady, insertResult, isBusy, latestRun,
  loadInstructions, loadLastRun, loadRunIndex, loadTests, minutes, newGraph, openGraph, openRun, patchNode, pausedPrompt, removeEdge, renameGraph, retypeEdge, runAllTests,
  runFromNode, runFromPane, runTest, runWithInput, saveAsTest, saveOutputs, saveTranscript, selectNode, setBackend, setCheckCommand, setCheckTimeout, setMustHold, setRetries,
  setRunCap, setTask, startConnect, stepRun, stopRun,
  toggleAllCalls, toggleAllRuns, toggleCall, toggleInputMore, toggleLastRunMore, togglePane, toggleTimeline, useRunTask, type Host, type LastRun,
} from './actions'
import { ANTHROPIC_SKILLS } from './cloud/sync'
import { cardsOf, clockTime, drawEdges, edgesOf, GLYPH, ROW_RATIO, SVG_LIMIT, timelineOf, timelineSpan, VEC_UNIT, vectorBaseSvg, vectorGlowSvg, type CanvasProps, type EdgeView, type TimelineCell } from './grid'
import { capText, isCap, runSpend, usdText } from './cost'
import { staleOf } from './records'
import { ALL_DISABLED, connect, DEFAULT_RETRIES, isCheck, MODEL_CHOICES, NO_AGENTS, nextKind, NODE_H, NODE_W, nodeById, outgoing, problemsFor, TOOL_CHOICES, validate, warningsOf, withoutDisabled, type Problem } from './model'

// What `host.ui.resolve(e)` answers for the band; register.tsx resolves it (the
// engine refuses `host` handed across files) and passes the parts in.
export type BandParts = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Button' | 'Text'>

export async function bandButton(host: Host, { Box, Button, Text }: BandParts): Promise<RenderElement> {
  const ui = await host.read('ui')
  const run = await host.read('run')
  // Delegate helpers (called by another agent) are not steps of the run.
  const steps = run === null ? [] : Object.values(run.nodes).filter(v => v.calledBy === undefined)
  const total = steps.length
  const finished = steps.filter(v => v.status !== 'waiting' && v.status !== 'paused' && v.status !== 'running').length
  return (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      <Button key="agent-graph" hotkey="g" label={ui.isOpen ? 'Close graph' : '⧉ Agent Graph'} onPress={() => togglePane(host)} />
      {run?.isRunning === true ? <Text dimColor>◐ {run.graphName} {finished}/{total}</Text> : null}
    </Box>
  )
}

// What `$.ui.resolve(e)` answers for the pane, and the two props it reads;
// register.tsx resolves them (the engine refuses `$` handed across files).
export type PaneParts = Pick<Elements['terminal' | 'desktop'], 'Box' | 'Text' | 'Button' | 'Input' | 'Select' | 'Client' | 'Markdown' | 'Link'> & { Svg?: Elements['desktop']['Svg'] | undefined }
export type PaneProps = { bodyColumns: number; scroll: { bodyRows: number } }

const INSPECTOR_WIDTH = 38
const RED = '#d4453b'
const ORANGE = '#d97757'
const GREEN = '#5aa469'
// A delegate call's colour: the delegate arrows' blue.
const DELEGATE_BLUE = '#7c8db5'
// The newest calls an Activity list shows before Show all.
const CALLS_SHOWN = 30
// An input, result or error shows up to this many characters.
const CALL_TEXT_MAX = 2048
const CALL_GLYPH = { running: { glyph: '●', color: ORANGE }, ok: { glyph: '✓', color: GREEN }, failed: { glyph: '✗', color: RED }, denied: { glyph: '⊘', color: undefined } } as const
// Cuts at `max` characters (code points: a pair of UTF-16 units is never cut in half) and marks the cut.
const clip = (text: string, max: number) => {
  if (text.length <= max) return text
  // Past 2 * max units there are more than max characters for sure, so the rest need not be counted.
  const chars = Array.from(text.slice(0, max * 2 + 2))
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

// The timeline's label column (a name is cut to it, with a space after) and the narrowest bar.
const TIMELINE_LABEL_MAX = 16
const TIMELINE_MIN_WIDTH = 10

// Equal neighbouring cells as one run of characters: [text, colour, dim].
function timelineRuns(cells: TimelineCell[]): { text: string; color: string | undefined; dim: boolean }[] {
  const runs: { text: string; color: string | undefined; dim: boolean }[] = []
  for (const cell of cells) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === cell.color && last.dim === cell.dim) last.text += cell.ch
    else runs.push({ text: cell.ch, color: cell.color, dim: cell.dim })
  }
  return runs
}

const LAST_RUN_INPUT_LINES = 3
const LAST_RUN_OUTPUT_LINES = 10
const LAST_RUN_OUTPUT_CHARS = 1500
const RUNS_SHOWN = 5
const PAUSED_INPUT_LINES = 12
const PAUSED_INPUT_CHARS = 1500
const PAUSED_INPUT_MAX = 4000
// The engine refuses a Client whose props serialize to over 100000 characters (and draws its own then); leave room for its wrapper.
const CANVAS_PROPS_LIMIT = 90000
// Below this many arrows the props cannot get near the limit, so they are not measured.
const MEASURED_ARROWS = 100

// From here's plan ("Reuses … · runs …", "Runs …") is information, not an error.
const isPlan = (notice: string) => notice.startsWith('Reuses ') || notice.startsWith('Runs ') || notice.startsWith('Uses your input for ')

// The first `count` lines of a text.
const firstLines = (text: string, count: number) => text.split('\n').slice(0, count).join('\n')

// One line for a saved run in the history list.
function runLabel(s: RunSummary): string {
  const origin = s.mode === 'from-here' ? `from ${s.fromName ?? 'here'}` : s.mode === 'tool' ? 'by Claude' : s.mode === 'test' ? `test: ${s.testName ?? ''}` : 'full run'
  return `${clockTime(s.at)} · ${s.ending === 'over-cap' ? 'over cap' : s.ending} · ${usdText(s.costUsd, s.costEstimated)} · ${origin} · "${s.taskLine}"`
}

// How a test's last result reads in its row.
const VERDICT = { pass: '✓ pass', fail: '✗ fail', ungraded: "? couldn't grade" } as const

// The row of a test: name, verdict, the reason clipped so the row fits `columns`, and when it was graded.
// A reason over several lines reads as one; an empty one is left out.
function testRow(t: TestCase, columns: number): string {
  if (t.last === undefined) return `${t.name} · not run`
  const head = `${t.name} · ${VERDICT[t.last.verdict]}`
  const tail = ` · ${clockTime(t.last.at)}`
  const reason = t.last.reason.replace(/\s+/g, ' ').trim()
  if (reason === '') return `${head}${tail}`
  return `${head} · ${clip(reason, Math.max(10, columns - head.length - 3 - tail.length - 1))}${tail}`
}

export async function drawPane(host: Host, parts: PaneParts, props: PaneProps): Promise<RenderElement> {
  const { Box, Text, Button, Input, Select, Client, Markdown, Link } = parts
  const g = await host.read('graph')
  const ui = await host.read('ui')
  const index = await host.read('index')
  const run = await host.read('run')
  if (g === null) return <Text dimColor>Loading the graph…</Text>

  // A run passes over disabled agents, so problems and warnings are about the graph it would use.
  const runnable = withoutDisabled(g)
  // With nothing left to run because every agent is disabled, say so rather than ask for an agent.
  const problems = validate(runnable).map(p => (g.nodes.length > 0 && p.message === NO_AGENTS ? { ...p, message: ALL_DISABLED } : p))
  const view: RunView | null = run !== null && run.graphId === g.id ? run : null
  const isRunning = view?.isRunning === true
  // A batch of tests counts as a run, also between two of its tests (while one is graded), and so does a run
  // of another graph (one paused there would otherwise have no Stop).
  const busy = isRunning || isBusy()
  // While a run of a graph with a cap goes: what it has cost against the cap (orange from 80%).
  // (the cap is the one the run enforces, which it read as it started; the graph's may have changed since)
  const runCap = view?.capUsd
  const spend = isRunning && view !== null && isCap(runCap) ? runSpend(view.nodes) : undefined
  const capLine = spend === undefined || runCap === undefined
    ? null
    : <Text key="run-cap-spent" {...(spend.usd >= runCap * 0.8 ? { color: ORANGE } : { dimColor: true })}>{capText(spend, runCap)}</Text>
  // Never narrower than the widest card, so no card is cut off at the right.
  const cols = Math.max(NODE_W + 4, props.bodyColumns - INSPECTOR_WIDTH - 2, ...g.nodes.map(n => n.x + NODE_W + 1))
  // Room for the tip under the lowest card.
  const rows = Math.max(10, props.scroll.bodyRows - 10, ...g.nodes.map(n => n.y + NODE_H + 2))
  // Tips read the instructions cache; a miss is read once, then cached.
  await Promise.all(g.nodes.filter(n => !isCheck(n) && cachedInstructions(n.instructionsFile) === undefined).map(n => loadInstructions(host, n)))
  // After the instructions are cached, so the starter-template check sees them.
  const warnings = warningsOf(runnable, n => cachedInstructions(n.instructionsFile))
  // Saved outputs that no longer match: the index is read once, then cached.
  const runIndex = cachedRunIndex(g.id) ?? (await loadRunIndex(host, g.id))
  const tests = cachedTests(g.id) ?? (await loadTests(host, g.id))
  const fullRun = runIndex.runs.find(r => r.mode === 'full' && r.costUsd > 0)
  const fullCost = fullRun?.costUsd
  const stale = staleOf(g, runIndex, ui.task, n => cachedInstructions(n.instructionsFile))
  // When the run on show was made, for the line above a past run.
  const viewedAt = view?.runId === undefined ? undefined : runIndex.runs.find(s => s.id === view.runId)?.at
  // Only the desktop has the Svg element: its arrows are vectors under the canvas. With so many arrows that
  // even the base without its dots is too big for it, the arrows are characters, as in the terminal.
  const vectorEdges = parts.Svg === undefined ? undefined : edgesOf(g, view, true)
  const base = vectorEdges === undefined ? undefined : vectorBaseSvg(g, vectorEdges, { cols, rows })
  const drawnAt = await host.clock.now()
  const cards = cardsOf(g, {
    selected: ui.selected, connecting: ui.connecting, run: view, problems, warnings, stale, now: drawnAt,
    instructions: n => cachedInstructions(n.instructionsFile) ?? '',
  })
  const canvasFor = (isVector: boolean, edges: EdgeView[]): CanvasProps => ({
    cardW: NODE_W,
    cardH: NODE_H,
    // The vector layer replaces the characters: the canvas then needs only the row count.
    layer: isVector ? Array.from({ length: rows }, () => []) : drawEdges(g, { cols, rows }),
    edges,
    cards,
    drawnAt,
    isRunning,
    vector: isVector,
    rowRatio: ROW_RATIO,
    connecting: ui.connecting !== null,
  })
  let vector = vectorEdges !== undefined && base !== undefined && base.length <= SVG_LIMIT
  let canvas = canvasFor(vector, vector && vectorEdges !== undefined ? vectorEdges : edgesOf(g, view))
  // Each vector arrow carries its sampled path, so a large graph can push the props over what the engine
  // accepts; the same arrows as characters are far smaller.
  if (vector && canvas.edges.length > MEASURED_ARROWS && JSON.stringify(canvas).length > CANVAS_PROPS_LIMIT) {
    vector = false
    canvas = canvasFor(false, edgesOf(g, view))
  }
  const glow = vector ? vectorGlowSvg(canvas.edges, ui.focus, { cols, rows }) : null
  const selected = ui.selected !== null ? nodeById(g, ui.selected) : undefined

  const listField = (title: string, items: string[], empty: string, onRemove: (item: string) => void, adder: RenderElement) => (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {items.length === 0 ? <Text dimColor>{empty}</Text> : null}
      {items.map(item => (
        <Box flexDirection="row" columnGap={1}>
          <Text>{clip(item, INSPECTOR_WIDTH - 6)}</Text>
          <Button key={`rm-${title}-${item}`} plain label="×" onPress={() => onRemove(item)} />
        </Box>
      ))}
      {adder}
    </Box>
  )

  // The agent's newest saved entry: how it ended, what it was given and what it made.
  const lastRunSection = (nodeId: string, lastRun: LastRun | undefined, savedAt: number | undefined, isCheckCard = false) => {
    if (lastRun === undefined) {
      return (
        <Box flexDirection="column">
          <Text bold>Last run</Text>
          <Text dimColor>Not run yet</Text>
        </Box>
      )
    }
    const r = lastRun.record
    const ended = r.endedAt ?? savedAt
    const head = [
      'Last run',
      r.status,
      ...(r.startedAt !== undefined && r.endedAt !== undefined ? [minutes(r.endedAt - r.startedAt)] : []),
      ...(r.costUsd !== undefined ? [usdText(r.costUsd, r.costEstimated)] : []),
      ...(r.reusedFrom !== undefined ? [`reused from ${clockTime(r.reusedFrom.at)}`] : ended !== undefined ? [clockTime(ended)] : []),
      ...(r.inputEdited === true ? ['input edited by you'] : []),
    ]
    const isError = r.error !== undefined
    // An input the user edited is shown instead of the handoffs it replaced.
    const editedPrompt = r.inputEdited === true ? r.prompt : undefined
    const body = r.error ?? r.output ?? ''
    // Collapsed: ten lines, and no more characters than that should take (one long paragraph is clipped too).
    const isLong = body.split('\n').length > LAST_RUN_OUTPUT_LINES || body.length > LAST_RUN_OUTPUT_CHARS
    const text = ui.lastRunMore === true ? clip(body, 4000) : clip(firstLines(body, LAST_RUN_OUTPUT_LINES), LAST_RUN_OUTPUT_CHARS)
    return (
      <Box flexDirection="column">
        <Text bold>{head.join(' · ')}</Text>
        {/* Not while a run goes: a paused agent's gate reads the same input file. */}
        {busy || isCheckCard ? null : (
          <Box flexDirection="row" columnGap={1}>
            <Button key="last-input-edit" label="Edit input ↗" onPress={() => editLastInput(host, nodeId)} />
            {hasInputReady(g.id, nodeId) ? <Button key="run-with-input" label="Run from here with this input" onPress={() => runWithInput(host, nodeId)} /> : null}
          </Box>
        )}
        {editedPrompt !== undefined ? (
          <Box flexDirection="column">
            <Text bold>Input (edited):</Text>
            <Text dimColor>{firstLines(editedPrompt, LAST_RUN_INPUT_LINES)}</Text>
          </Box>
        ) : r.inputs.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>Input</Text>
            {r.inputs.map(from => (
              <Box key={`input-${from}`} flexDirection="column">
                <Text>{`From ${lastRun.names[from] ?? from}:`}</Text>
                <Text dimColor>{firstLines(lastRun.outputs[from] ?? '', LAST_RUN_INPUT_LINES) || '(nothing)'}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
        {body !== '' ? (
          <Box flexDirection="column">
            <Text bold>{isError ? 'Error' : 'Output'}</Text>
            {isError ? <Text color={RED}>{text}</Text> : <Text>{text}</Text>}
            {isLong ? <Button key="last-run-more" plain label={ui.lastRunMore === true ? 'Show less' : 'Show all'} onPress={() => toggleLastRunMore(host)} /> : null}
          </Box>
        ) : null}
      </Box>
    )
  }

  // The calls of the agent in the run on show (live, or a past run opened from Runs), newest last: the newest 30, or all.
  // A row is open by `<nodeId>:<itemId>`: item ids repeat across agents (a reused agent's come from another run).
  const activitySection = (nodeId: string, items: ActivityItem[]) => {
    const open = new Set(ui.openCalls ?? [])
    const shown = ui.allCalls === true ? items : items.slice(-CALLS_SHOWN)
    // How long a call took; one still running counts up to now (not in a past run, where it just never ended).
    const took = (item: ActivityItem) => minutes((item.endedAt ?? (isRunning ? drawnAt : item.startedAt)) - item.startedAt)
    const rows = (list: ActivityItem[], level: number): RenderElement[] =>
      list.flatMap(item => {
        const key = `${nodeId}:${item.id}`
        const isOpen = open.has(key)
        const indent = '  '.repeat(level)
        const delegate = item.delegate
        // A call still marked running in a past run never ended: dim, not orange.
        const unfinished = item.status === 'running' && !isRunning
        const mark = delegate !== undefined ? { glyph: '↳', color: item.status === 'failed' ? RED : DELEGATE_BLUE }
          : unfinished ? { glyph: '●', color: undefined } : CALL_GLYPH[item.status]
        const time = ` · ${took(item)}`
        const head = delegate !== undefined ? delegate.name : item.summary === '' ? item.tool : `${item.tool} · ${item.summary}`
        const room = Math.max(8, INSPECTOR_WIDTH - 2 - indent.length - 2 - time.length)
        // Every line of a detail text is indented, not only the first.
        const text = (value: string) => <Box flexDirection="column">{clip(value, CALL_TEXT_MAX).split('\n').map(line => <Text dimColor>{indent}{'  '}{line}</Text>)}</Box>
        const row = (
          <Box key={`act-row-${item.id}`} flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Text color={mark.color} dimColor={mark.color === undefined}>{indent}{mark.glyph}</Text>
              <Button key={`act-${item.id}`} plain label={`${clip(head, room)}${time}`} onPress={() => toggleCall(host, key)} />
            </Box>
            {isOpen && delegate === undefined ? (
              <Box flexDirection="column">
                {item.input !== undefined && item.input !== '' ? <Box flexDirection="column"><Text bold>{indent}{'  '}Input</Text>{text(item.input)}</Box> : null}
                {item.result !== undefined && item.result !== '' ? <Box flexDirection="column"><Text bold>{indent}{'  '}Result</Text>{text(item.result)}</Box> : null}
                {item.error !== undefined && item.error !== '' ? <Box flexDirection="column"><Text bold>{indent}{'  '}Error</Text><Text color={RED}>{indent}{'  '}{clip(item.error, CALL_TEXT_MAX)}</Text></Box> : null}
                {(item.input === undefined || item.input === '') && (item.result === undefined || item.result === '') && (item.error === undefined || item.error === '') ? <Text dimColor>{indent}{'  '}(nothing recorded)</Text> : null}
              </Box>
            ) : null}
          </Box>
        )
        if (!isOpen || delegate === undefined) return [row]
        return [
          row,
          ...(item.error !== undefined && item.error !== '' ? [<Text key={`act-err-${item.id}`} color={RED}>{indent}{'  '}{clip(item.error, CALL_TEXT_MAX)}</Text>] : []),
          ...(delegate.items.length === 0 ? [<Text key={`act-none-${item.id}`} dimColor>{indent}{'  '}(no calls recorded)</Text>] : rows(delegate.items, level + 1)),
        ]
      })
    return (
      <Box flexDirection="column">
        <Text bold>Activity</Text>
        {rows(shown, 0)}
        {items.length > CALLS_SHOWN ? <Button key="all-calls" plain label={ui.allCalls === true ? 'Show fewer' : `Show all (${items.length})`} onPress={() => toggleAllCalls(host)} /> : null}
      </Box>
    )
  }

  const nodeInspector = async (node: AgentNode) => {
    // A check card is a command, not an agent: no instructions, tools, skills, context, model or budget.
    const check = node.check
    // From the actions' module cache: a file is read only on the first draw after a miss.
    const instructions = check !== undefined ? '' : (cachedInstructions(node.instructionsFile) ?? (await loadInstructions(host, node)))
    const skills = [...new Set([...cachedSkills(), ...ANTHROPIC_SKILLS])].filter(s => !node.skills.includes(s)).sort()
    const toolsLeft = TOOL_CHOICES.filter(t => !node.tools.includes(t))
    const nodeRun = view?.nodes[node.id]
    // From here is offered where the cards offer it; on a loop card other than the target it runs from the target.
    const fromHere = cards.find(c => c.id === node.id && c.canRunFrom)
    // Saved entries are read from their record file once, then cached (a missing one too).
    const lastRun = cachedLastRun(g.id, node.id) ?? (await loadLastRun(host, g.id, node.id))
    // Only while the run goes and the agent waits at its gate: a stopped run leaves nothing to continue.
    const waiting = isRunning && nodeRun?.status === 'paused' ? pausedPrompt(node.id) : undefined
    const inputIsLong = waiting !== undefined && (waiting.split('\n').length > PAUSED_INPUT_LINES || waiting.length > PAUSED_INPUT_CHARS)
    // Show all stops at PAUSED_INPUT_MAX characters; the rest is in the file Edit input opens.
    const inputCut = waiting === undefined || ui.inputMore !== true || waiting.length <= PAUSED_INPUT_MAX ? 0 : Array.from(waiting).length - PAUSED_INPUT_MAX
    return (
      <Box flexDirection="column" rowGap={1}>
        {waiting !== undefined ? (
          <Box flexDirection="column">
            <Text bold>{`Paused before ${node.name}`}</Text>
            <Text dimColor>{ui.inputMore === true ? clip(waiting, PAUSED_INPUT_MAX) : clip(firstLines(waiting, PAUSED_INPUT_LINES), PAUSED_INPUT_CHARS)}</Text>
            {inputCut > 0 ? <Text dimColor>{`${inputCut} more characters: Edit input ↗ shows all`}</Text> : null}
            {inputIsLong ? <Button key="input-more" plain label={ui.inputMore === true ? 'Show less' : 'Show all'} onPress={() => toggleInputMore(host)} /> : null}
            <Box flexDirection="row" columnGap={1}>
              {node.check === undefined ? <Button key="input-edit" label="Edit input ↗" onPress={() => editPausedInput(host, node.id)} /> : null}
              <Button key="continue" variant="primary" label="Continue" onPress={() => continueAgent(host, node.id)} />
              {view?.step === true ? <Button key="continue-all" label="Continue all" onPress={() => continueAll(host, node.id)} /> : null}
            </Box>
            {/* Both backends set an agent up with its instructions when the run starts. */}
            {node.check === undefined ? <Text dimColor>Instruction edits apply from the next run.</Text> : null}
          </Box>
        ) : null}
        <Input key={`name-${node.id}`} label="Name" value={node.name} submitLabel="Rename" onSubmit={v => patchNode(host, node.id, { name: v.trim() })} />
        {check !== undefined ? (
          <Input key={`check-cmd-${node.id}`} label="Command" value={check.command} submitLabel="Save" onSubmit={v => setCheckCommand(host, node.id, v)} />
        ) : null}
        {check !== undefined ? (
          <Input key={`check-timeout-${node.id}`} label="Timeout (min)" value={String(check.timeoutMin)} submitLabel="Set" onSubmit={v => setCheckTimeout(host, node.id, v)} />
        ) : null}
        {check === undefined ? (
          <Box flexDirection="column" rowGap={1}>
          <Select
            key={`model-${node.id}`}
            label="Model"
            options={[{ value: '', label: g.backend === 'cloud' ? 'default (opus)' : 'inherit' }, ...MODEL_CHOICES.map(m => ({ value: m }))]}
            value={node.model ?? ''}
            onSelect={v => patchNode(host, node.id, { model: v === '' ? null : v })}
          />
          {listField('Tools', node.tools, 'all (the default set)', t => patchNode(host, node.id, { tools: node.tools.filter(x => x !== t) }),
            toolsLeft.length > 0
              ? <Select key={`add-tool-${node.id}`} label="+ tool" options={toolsLeft.map(t => ({ value: t }))} onSelect={v => patchNode(host, node.id, { tools: [...node.tools, v] })} />
              : <Text dimColor>all added</Text>)}
          {listField('Skills', node.skills, 'none', s => patchNode(host, node.id, { skills: node.skills.filter(x => x !== s) }),
            skills.length > 0
              ? <Select key={`add-skill-${node.id}`} label="+ skill" options={skills.map(s => ({ value: s }))} onSelect={v => patchNode(host, node.id, { skills: [...node.skills, v] })} />
              : <Text dimColor>all added</Text>)}
          {listField('Context', node.contextFiles, 'none', p => patchNode(host, node.id, { contextFiles: node.contextFiles.filter(x => x !== p) }),
            <Input key={`add-ctx-${node.id}`} placeholder="path/to/file-or-folder" submitLabel="Add" onSubmit={v => (v.trim() !== '' && !node.contextFiles.includes(v.trim()) ? patchNode(host, node.id, { contextFiles: [...node.contextFiles, v.trim()] }) : undefined)} />)}
          <Input
            key={`when-${node.id}`}
            label="When to use (shown to agents that delegate to it, and to Claude)"
            value={node.whenToUse ?? ''}
            submitLabel="Save"
            onSubmit={v => patchNode(host, node.id, { whenToUse: v.trim() })}
          />
          </Box>
        ) : null}
        <Button key={`disable-${node.id}`} plain label={node.disabled === true ? 'Enable' : 'Disable'} onPress={() => patchNode(host, node.id, { disabled: node.disabled !== true })} />
        <Button key={`pause-${node.id}`} plain label={`Pause before this agent: ${node.pauseBefore === true ? 'on' : 'off'}`} onPress={() => patchNode(host, node.id, { pauseBefore: node.pauseBefore !== true })} />
        {check === undefined ? (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Text bold>Instructions</Text>
              <Button key={`edit-${node.id}`} label="Edit ↗" onPress={() => editInstructions(host, node)} />
            </Box>
            <Text dimColor>{clip(instructions.split('\n').slice(0, 3).join('\n'), 160) || '(empty)'}</Text>
          </Box>
        ) : null}
        {lastRunSection(node.id, lastRun, runIndex.latest[node.id]?.at, check !== undefined)}
        {check === undefined ? (
          <Input key={`budget-${node.id}`} label="Budget (USD)" value={String(node.budgetUsd)} submitLabel="Set" onSubmit={v => {
            const usd = Number(v)
            return Number.isFinite(usd) && usd > 0 ? patchNode(host, node.id, { budgetUsd: usd }) : undefined
          }} />
        ) : null}
        <Box flexDirection="column">
          <Text bold>Arrows out</Text>
          {outgoing(g, node.id).length === 0 ? <Text dimColor>none: use Connect</Text> : null}
          {outgoing(g, node.id).map(edge => (
            <Box key={`out-${edge.id}`} flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text>{edge.kind === 'retry' ? `↺ ${nodeById(g, edge.to)?.name ?? '?'} · retries ${edge.retries ?? DEFAULT_RETRIES}` : `${edge.kind === 'handoff' ? '━►' : '┄►'} ${nodeById(g, edge.to)?.name ?? '?'}`}</Text>
                <Button key={`kind-${edge.id}`} plain label={edge.kind} onPress={() => retypeEdge(host, edge.id, nextKind(edge.kind))} />
                <Button key={`rm-${edge.id}`} plain label="×" onPress={() => removeEdge(host, edge.id)} />
              </Box>
              {edge.kind === 'retry' ? (
                <Input key={`retries-${edge.id}`} label="Retries" value={String(edge.retries ?? DEFAULT_RETRIES)} submitLabel="Set" onSubmit={v => setRetries(host, edge.id, v)} />
              ) : null}
            </Box>
          ))}
        </Box>
        {problemsFor(problems, node.id).map(p => <Text color={RED}>! {p.message}</Text>)}
        {fromHere !== undefined ? (
          <Button key={`run-from-${node.id}`} plain label={fromHere.runFrom === undefined ? '▶ From here' : `▶ From here (from ${clip(fromHere.runFrom, 18)})`} onPress={() => runFromNode(host, node.id)} />
        ) : null}
        {nodeRun !== undefined ? (
          <Box flexDirection="column">
            <Text bold>{GLYPH[nodeRun.status]} {nodeRun.status}{nodeRun.costUsd !== undefined ? ` · ${usdText(nodeRun.costUsd, nodeRun.costEstimated)}` : ''}</Text>
            {nodeRun.link !== undefined ? <Link href={nodeRun.link} label="Open in Console" /> : null}
            {nodeRun.error !== undefined ? <Text color={RED}>{nodeRun.error}</Text> : null}
            {nodeRun.output !== undefined ? <Markdown text={clip(nodeRun.output, 1500)} /> : null}
          </Box>
        ) : null}
        {nodeRun?.rounds !== undefined && nodeRun.rounds.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>Rounds</Text>
            {nodeRun.rounds.map(r => <Text key={`round-${node.id}-${r.round}`}>{`${r.passed ? '✓' : '✗'} round ${r.round} · ${r.note} · ${clockTime(r.at)}`}</Text>)}
          </Box>
        ) : null}
        {nodeRun?.activity !== undefined && nodeRun.activity.length > 0 ? activitySection(node.id, nodeRun.activity) : null}
      </Box>
    )
  }

  const graphInspector = (graph: Graph) => (
    <Box flexDirection="column" rowGap={1}>
      <Input key={`gname-${graph.id}`} label="Graph name" value={graph.name} submitLabel="Rename" onSubmit={v => renameGraph(host, v)} />
      <Input key={`gdesc-${graph.id}`} label="Description (shown to Claude)" value={graph.description} submitLabel="Save" onSubmit={v => describeGraph(host, v)} />
      <Input key={`run-cap-${graph.id}`} label="Run cap (USD)" value={graph.runCapUsd === undefined ? '' : String(graph.runCapUsd)} submitLabel="Set" onSubmit={v => setRunCap(host, v)} />
      <Text dimColor>Click an agent to edit it. Drag agents to move them; drag a ► to connect.</Text>
      <Button key="delete-graph" plain label="Delete this graph" onPress={() => deleteGraph(host)} />
    </Box>
  )

  // "<agent>: <message>" for a problem that is about an agent (or about an arrow, by the agent it leaves).
  const ownerOf = (p: Problem): string | null => {
    if (p.target.kind === 'node') return nodeById(g, p.target.id) === undefined ? null : p.target.id
    if (p.target.kind === 'edge') {
      const id = p.target.id
      const from = g.edges.find(e => e.id === id)?.from
      return from !== undefined && nodeById(g, from) !== undefined ? from : null
    }
    return null
  }
  const labelOf = (p: Problem): string => {
    const owner = ownerOf(p)
    const name = owner === null ? '' : nodeById(g, owner)?.name.trim() ?? ''
    return name !== '' ? `${name}: ${p.message}` : p.message
  }

  // One bar per agent that has an entry in the run on show (helpers too), as wide as the canvas minus the
  // label column, scaled from the run's first start to its end (to now while it runs). Text only.
  const timelineBlock = (() => {
    if (ui.timeline !== true || view === null) return null
    // An agent with a blank name is still a button to press: it reads as its id.
    const agents = g.nodes.filter(n => view.nodes[n.id] !== undefined).map(n => ({ id: n.id, name: n.name.trim() === '' ? n.id : n.name }))
    if (agents.length === 0) return null
    // Names are cut by code points; the column is as wide as the longest one (and a space).
    const label = Math.min(TIMELINE_LABEL_MAX, Math.max(...agents.map(a => Array.from(a.name).length))) + 1
    const width = Math.max(TIMELINE_MIN_WIDTH, cols - label)
    const rows = timelineOf(view, agents, width, drawnAt)
    const span = timelineSpan(view, drawnAt)
    const end = minutes(span === undefined ? 0 : span.to - span.from)
    const gap = Math.max(0, width - 4 - end.length - 1)
    const footer = `${' '.repeat(label)}0:00${' '.repeat(Math.floor(gap / 2))}…${' '.repeat(gap - Math.floor(gap / 2))}${end}`
    return (
      <Box key="timeline-block" flexDirection="column">
        {rows.map(row => (
          <Box key={`tl-row-${row.id}`} flexDirection="row">
            <Box width={label} flexShrink={0}>
              <Button key={`tl-${row.id}`} plain label={clip(row.name, TIMELINE_LABEL_MAX)} onPress={() => selectNode(host, row.id)} />
            </Box>
            {timelineRuns(row.cells).map((run, i) => <Text key={`tl-bar-${row.id}-${i}`} color={run.color} dimColor={run.dim}>{run.text}</Text>)}
          </Box>
        ))}
        <Text dimColor>{footer}</Text>
      </Box>
    )
  })()

  const c = ui.connecting
  // What an arrow of this kind would add to the problems; the first new one is the reason it is refused.
  const refusal = (from: string, to: string, kind: EdgeKind): string | undefined => {
    const idOf = (p: Problem) => `${p.target.kind}:${p.target.kind === 'node' ? p.target.id : ''}:${p.message}`
    const had = new Set(problems.map(idOf))
    return validate(withoutDisabled(connect(g, from, to, kind))).find(p => !had.has(idOf(p)))?.message
  }
  const kindPicker = c !== null && c.stage === 'kind' ? (
    <Box flexDirection="column" rowGap={1}>
      <Text bold>Connect {nodeById(g, c.from)?.name} → {nodeById(g, c.to)?.name} as:</Text>
      {([['handoff', 'Handoff ━►', 'h'], ['delegate', 'Delegate ┄►', 'd'], ['retry', 'Retry ↺', 't']] as const).map(([kind, label, hotkey]) => {
        const why = refusal(c.from, c.to, kind)
        return why === undefined
          ? <Button key={`as-${kind}`} label={label} hotkey={hotkey} onPress={() => confirmEdge(host, kind)} />
          : <Text dimColor>{label} — {why}</Text>
      })}
      <Button key="cancel-connect" plain label="Cancel" onPress={() => cancelConnect(host)} />
    </Box>
  ) : null
  const hint = c === null ? null : c.stage === 'source' ? 'Click the agent the arrow starts from.' : c.stage === 'target' ? 'Click the agent the arrow points to.' : null
  const inspector = kindPicker ?? (selected !== undefined ? await nodeInspector(selected) : graphInspector(g))

  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" columnGap={1} flexWrap="wrap" alignItems="center">
        <Select
          key="graph"
          options={[...index.map(i => ({ value: i.id, label: i.name })), { value: '__new__', label: '+ New graph' }]}
          value={g.id}
          onSelect={v => (v === '__new__' ? newGraph(host) : openGraph(host, v))}
        />
        <Button key="backend" label={g.backend === 'local' ? 'Local' : 'Cloud'} onPress={() => setBackend(host, g.backend === 'local' ? 'cloud' : 'local')} />
        <Button key="add" label="+ Agent" hotkey="a" onPress={() => addAgent(host)} />
        {g.backend === 'local' ? <Button key="add-check" label="+ Check" onPress={() => addCheck(host)} /> : null}
        <Button key="connect" label={c !== null ? 'Cancel connect' : 'Connect'} hotkey="c" onPress={() => (c !== null ? cancelConnect(host) : startConnect(host))} />
        {ui.selected !== null ? <Button key="delete" label="Delete" onPress={() => deleteSelected(host)} /> : null}
        {busy
          ? <Button key="stop" variant="primary" label="■ Stop" onPress={() => stopRun()} />
          : problems.length === 0
            ? <Button key="run" variant="primary" label="▶ Run" hotkey="r" onPress={() => runFromPane(host)} />
            : <Text dimColor>▶ Run (fix {problems.length} problem{problems.length === 1 ? '' : 's'})</Text>}
        {capLine}
        {!busy && problems.length === 0 ? <Button key="step" label="▷ Step" onPress={() => stepRun(host)} /> : null}
        <Button key="timeline" label="Timeline" onPress={() => toggleTimeline(host)} />
      </Box>
      {problems.length > 0 || warnings.length > 0 ? (
        <Box flexDirection="column">
          {problems.map((p, i) => (
            <Button key={`problem-${i}`} plain label={`! ${labelOf(p)}`} onPress={() => selectNode(host, ownerOf(p))} />
          ))}
          {warnings.map((p, i) => (
            <Button key={`warning-${i}`} plain label={`△ ${labelOf(p)}`} onPress={() => selectNode(host, ownerOf(p))} />
          ))}
        </Box>
      ) : null}
      {hint !== null ? <Text color="#d97757">{hint}</Text> : null}
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Box key="canvas-wrap" position="relative" width={cols} height={rows} flexShrink={0} overflow="hidden">
          {vector && base !== undefined && parts.Svg !== undefined && canvas.edges.length > 0 ? (
            <Box key="vectors-layer" position="absolute" top={0} left={0} width={cols} height={rows}>
              <parts.Svg
                key="vectors"
                source={base}
                alt="Agent graph arrows"
                width={cols * VEC_UNIT}
                height={Math.round(rows * VEC_UNIT * ROW_RATIO)}
                isInteractive={canvas.edges.some(e => e.flow === 'flowing')}
              />
            </Box>
          ) : null}
          {glow !== null && parts.Svg !== undefined ? (
            <Box key="vector-glow-layer" position="absolute" top={0} left={0} width={cols} height={rows}>
              <parts.Svg
                key="vector-glow"
                source={glow}
                alt="Highlighted agent graph arrows"
                width={cols * VEC_UNIT}
                height={Math.round(rows * VEC_UNIT * ROW_RATIO)}
              />
            </Box>
          ) : null}
          <Client key="canvas" module="./canvas.tsx" props={canvas} width={cols} height={rows} />
        </Box>
        <Box flexDirection="column" width={INSPECTOR_WIDTH}>{inspector}</Box>
      </Box>
      {timelineBlock}
      <Input key="task" placeholder="Task for this graph" value={ui.task} submitLabel="Run" onInput={v => setTask(host, v)} onSubmit={async v => { await setTask(host, v); await runFromPane(host) }} />
      {ui.notice === null ? null : isPlan(ui.notice) ? <Text dimColor>{ui.notice}</Text> : <Text color={RED}>{ui.notice}</Text>}
      {view?.isHistoric === true ? (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Text bold>{viewedAt === undefined ? 'Viewing a past run' : `Viewing the run from ${clockTime(viewedAt)}`}</Text>
          <Button key="back-to-latest" label="Back to latest" onPress={() => latestRun(host)} />
          <Button key="use-run-task" label="Use this task" onPress={() => useRunTask(host)} />
        </Box>
      ) : null}
      {view !== null && !isRunning && view.result !== undefined ? (
        <Box flexDirection="column">
          <Text bold>Result</Text>
          <Markdown text={clip(view.result, 4000)} />
          <Box flexDirection="row" columnGap={1}>
            <Button key="insert" label="Insert into prompt" onPress={() => insertResult(host)} />
            {busy ? null : <Button key="save-test" label="Save as test" onPress={() => saveAsTest(host)} />}
            <Button key="save-transcript" label="Save transcript" onPress={() => saveTranscript(host)} />
            {(view.outputs?.length ?? 0) > 0 ? <Button key="save" label={`Save outputs (${view.outputs!.length})`} onPress={() => saveOutputs(host)} /> : null}
          </Box>
        </Box>
      ) : null}
      {runIndex.runs.length > 0 ? (
        <Box flexDirection="column">
          <Text bold>Runs</Text>
          {(ui.allRuns === true ? runIndex.runs : runIndex.runs.slice(0, RUNS_SHOWN)).map(s =>
            // Not clickable while a run is going: opening one would replace the live view.
            busy ? <Text dimColor>{runLabel(s)}</Text> : <Button key={`run-${s.id}`} plain label={runLabel(s)} onPress={() => openRun(host, s.id)} />,
          )}
          {runIndex.runs.length > RUNS_SHOWN ? (
            <Button key="all-runs" plain label={ui.allRuns === true ? 'Show fewer runs' : `Show all runs (${runIndex.runs.length})`} onPress={() => toggleAllRuns(host)} />
          ) : null}
        </Box>
      ) : null}
      {tests.length > 0 ? (
        <Box flexDirection="column">
          <Text bold>Tests</Text>
          {tests.map(t => (
            <Box key={`test-${t.id}`} flexDirection="column">
              <Text>{testRow(t, props.bodyColumns)}</Text>
              {busy ? (
                <Text dimColor>{['Run', 'Must hold ✎', ...(t.last !== undefined ? ['Compare ↗'] : []), ...(t.last?.result ? ['Accept latest'] : []), '✕'].join(' · ')}</Text>
              ) : (
                <Box flexDirection="row" columnGap={1}>
                  <Button key={`test-run-${t.id}`} label="Run" onPress={() => runTest(host, t.id)} />
                  <Button key={`test-hold-${t.id}`} label="Must hold ✎" onPress={() => editMustHold(host, ui.editingTest === t.id ? null : t.id)} />
                  {t.last !== undefined ? <Button key={`test-compare-${t.id}`} label="Compare ↗" onPress={() => compareTest(host, t.id)} /> : null}
                  {t.last?.result ? <Button key={`test-accept-${t.id}`} label="Accept latest" onPress={() => acceptLatest(host, t.id)} /> : null}
                  <Button key={`test-del-${t.id}`} plain label={ui.armedTest === t.id ? '✕ sure?' : '✕'} onPress={() => deleteTest(host, t.id)} />
                </Box>
              )}
              {!busy && ui.editingTest === t.id ? (
                <Input key="test-hold-input" label={`Must hold: ${t.name}`} value={t.mustHold} submitLabel="Save" onSubmit={v => setMustHold(host, t.id, v)} />
              ) : null}
            </Box>
          ))}
          {(() => {
            const label = `Run all tests (${tests.length})${fullCost !== undefined ? ` · about ${usdText(fullCost * tests.length, fullRun?.costEstimated)}` : ''}`
            return busy ? <Text dimColor>{label}</Text> : <Button key="run-tests" label={label} onPress={() => runAllTests(host)} />
          })()}
        </Box>
      ) : null}
    </Box>
  )
}
