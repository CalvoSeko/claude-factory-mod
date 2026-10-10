import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  activityRun, completions, guard, importGraphs, libraryOf, meterStep, onCanvas, paneClosed, refreshIndex, refreshSkills, registerGraphTools, settings, startRun, togglePane,
  TOOL_PREFIX, toolName, trackSpawn, trackToolCall, trackTurnEnd, type Host,
} from './actions'
import type { CanvasPost } from './grid'
import { bandButton, drawPane, type PaneParts } from './pane'
import { EMPTY_UI, type Slots } from './state'

// The four values of Slots (state.ts): the engine reads the atoms a module uses from
// consts of that module's own file.
const indexSlot = atom({ plugin: 'agent-graph', key: 'index' } as const, [] as Slots['index'])
const graphSlot = atom({ plugin: 'agent-graph', key: 'graph' } as const, null as Slots['graph'])
const uiSlot = atom({ plugin: 'agent-graph', key: 'ui' } as const, EMPTY_UI)
const runSlot = atom({ plugin: 'agent-graph', key: 'run' } as const, null as Slots['run'])

// The engine follows `$` only into functions declared in this file, so the
// actions (in actions.ts) get this object of closures over it instead of `$`.
function hostOf($: EngineInterface): Host {
  return {
    // $.env.get wants a literal name, so each variable the actions read is spelled out.
    env: { get: name => (name === 'USERPROFILE' ? $.env.get('USERPROFILE') : name === 'HOME' ? $.env.get('HOME') : $.env.get('OS')) },
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key) },
    fs: {
      exists: path => $.fs.exists(path),
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      list: path => $.fs.list(path),
    },
    process: { run: (argv, options) => $.process.run(argv, options), spawn: request => $.process.spawn(request) },
    tool: { register: spec => $.tool.register(spec), call: input => $.tool.call(input as never) },
    ui: { open: args => $.ui.open(args), close: args => $.ui.close(args), toast: (text, options) => $.ui.toast(text, options) },
    session: { authorize: () => $.session.authorize() },
    http: { fetch: (url, init) => $.http.fetch(url, init) },
    clock: { after: (ms, run) => $.clock.after(ms, run), now: () => $.clock.now() },
    agent: { register: spec => $.agent.register(spec), spawn: args => $.agent.spawn(args) },
    prompt: { submit: args => $.prompt.submit(args), fill: args => $.prompt.fill(args) },
    model: { complete: (request, options) => $.model.complete(request, options) },
    // The state library wants atoms written in this file, so each of the four (state.ts) is spelled out.
    read: (slot =>
      slot === 'index' ? read($, indexSlot)
      : slot === 'graph' ? read($, graphSlot)
      : slot === 'ui' ? read($, uiSlot)
      : read($, runSlot)) as Host['read'],
    update: ((slot: keyof Slots, change: never) =>
      slot === 'index' ? update($, indexSlot, change)
      : slot === 'graph' ? update($, graphSlot, change)
      : slot === 'ui' ? update($, uiSlot, change)
      : update($, runSlot, change)) as unknown as Host['update'],
  }
}

export const register: Register = (on, options) => {
  settings.anthropicApiKey = typeof options['anthropicApiKey'] === 'string' ? options['anthropicApiKey'] : undefined
  settings.workspaceId = typeof options['workspaceId'] === 'string' ? options['workspaceId'] : undefined

  on('session.start', async ($, e, next) => {
    // A failure here must not keep the session start from going on.
    try {
      const host = hostOf($)
      await $.command.register({ name: 'agent-graph', description: 'Open the agent graph editor' })
      try {
        await importGraphs(host)
      } catch {
        // A file that cannot be imported waits for the next try.
      }
      await refreshIndex(host)
      await registerGraphTools(host)
      await refreshSkills(host)
    } catch {
      // The pane and its tools come back on the next session start.
    }
    return next(e)
  })

  on('command.run', { command: 'agent-graph' }, async $ => {
    const host = hostOf($)
    // Graphs saved to the import folder since the session started join before the pane opens.
    if ((await importGraphs(host).catch(() => 0)) > 0) {
      await refreshIndex(host)
      await registerGraphTools(host)
    }
    await togglePane(host, true)
    return { text: 'Agent Graph opened.' }
  })

  // The matcher is a literal (PANE_ID in state.ts) so validate can list it.
  on('ui.close', { id: 'agent-graph' }, async ($, e, next) => {
    await paneClosed(hostOf($))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
    const host = hostOf($)
    const others = await next(e)
    const parts = $.ui.resolve(e)
    const { Box } = parts
    const button = await bandButton(host, parts)
    return others ? <Box flexDirection="row" columnGap={2} alignItems="center" flexWrap="wrap">{others}{button}</Box> : button
  })

  on('ui.render', { component: 'Pane', requestId: 'agent-graph' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const host = hostOf($)
    // The resolved table may carry an Svg on every surface; only the desktop draws one,
    // so the pane is told so by the part being absent elsewhere.
    const parts: PaneParts = $.ui.resolve(e)
    return drawPane(host, e.surface === 'desktop' ? parts : { ...parts, Svg: undefined }, e.props)
  })

  on('ui.message', { element: 'canvas' }, async ($, e, next) => {
    // The canvas batches every event of a frame (one post per frame at most).
    const events = (e.data as Partial<CanvasPost> | null | undefined)?.events
    const host = hostOf($)
    if (Array.isArray(events)) for (const event of events) await onCanvas(host, event)
    return next(e)
  })

  // Outermost, so the guard's denial below is what this hook sees come back (and records as denied).
  // An agent outside the run's tracker gets next(e) and nothing else.
  on('tool.call', ($, e, next) =>
    trackToolCall(activityRun(), e, async () => {
      const tool = String(e.tool)
      if (!tool.startsWith(TOOL_PREFIX)) return next(e)
      const host = hostOf($)
      const library = await libraryOf(host)
      let graph
      for (const entry of await library.index()) {
        const g = await library.load(entry.id)
        if (g !== undefined && `mcp__agent-graph__${toolName(g)}` === tool) graph = g
      }
      if (graph === undefined) return { result: 'This agent graph no longer exists.' } as never
      const task = String((e as unknown as { task?: unknown }).task ?? '')
      const reason = await startRun(host, graph, task, 'tool')
      return { result: reason ?? `Started agent graph "${graph.name}". Its result will arrive as a message when it finishes.` } as never
    }),
  )

  on('tool.call', { tool: 'Agent' }, ($, e, next) => {
    const why = guard.check(e.agentId, e.subagent_type)
    return why === undefined ? next(e) : { deny: why }
  })

  // A spawn under an agent of the run nests the child's calls under the parent's delegate call.
  on('agent.spawn', ($, e, next) => trackSpawn(activityRun(), e, () => next(e)))

  // The price of each model request of a Local agent of the run goes into its meter. Anything else only passes.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    meterStep(activityRun(), e.agentId, r)
    return r
  })

  on('turn.complete', ($, e, next) => {
    trackTurnEnd(activityRun(), e)
    if (e.agentId !== undefined) {
      completions.complete({
        agentId: e.agentId,
        answer: e.answer,
        reason: e.reason,
        ...(e.reason === 'refusal' ? { refusal: e.refusal.explanation ?? e.refusal.category ?? undefined } : {}),
      })
    }
    return next(e)
  })
}
