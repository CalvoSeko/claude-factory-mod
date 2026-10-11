# FACTORY.md — house rules for agents working on this repository

Every card of a Software factory graph reads this file first; its rules win over the cards' own instructions.

## Branches and shipping
- Integration branch: `main`. Work on a feature branch; never merge, force-push or delete branches.

## Commands (Definition of done)
- Tests: `npm test` (= `claude plugin test agent-graph`; about a minute; every test gets 20 s)
- Type-check: `npm run typecheck` (= `npx -y -p typescript@5 tsc -p agent-graph`; needs the types the engine writes to `agent-graph/.claude-plugin/types/` once the mod has loaded)
- Lint: `npm run lint` (= `claude plugin validate agent-graph`; the "no author" warning is expected)

## Mod rules (each is load-bearing; read the code around a change before writing it)
- The engine's `$` and state atoms never cross files: actions take a `Host` adapter built by `hostOf($)` in `agent-graph/hooks/register.tsx`. A new engine call is added to `Host` (actions.ts) and to `hostOf`.
- Render hooks never write state. `exclusive()` never nests. Each hook has a 10 s budget; long work starts with `host.clock.after(0, …)`.
- `agent-graph/hooks/canvas.tsx` is a Client module: type-only imports, `surface.elements` only, no `$`.
- The mod never archives or deletes Managed Agents resources (sessions, threads, agents, files), thread archive included.
- Tests import `test` from `./kit` and only `expect`/`mock`/types from `claude-code/testing`. The last tests of `tests/canvas-events.test.tsx`, `tests/last-run.test.tsx` and `tests/canvas.test.tsx` must stay last.
- Glyphs are never wide emoji; cards are 26×5 cells with a 22-cell inner width — status lines must fit.
- Types live in `agent-graph/types/index.d.ts`; engine API types in `agent-graph/.claude-plugin/types/claude-code/index.d.ts` (grep it; it is large).
- Never commit secrets: the Anthropic API key is a sensitive plugin setting and stays out of code, tests and logs.
- Prefer the simplest change that works; follow the patterns of neighbouring code; comment density like the surrounding code.

## Environment
- On Windows, write multi-line files with the Write/Edit tools, never shell heredocs or echo.
- Never start an interactive interpreter or REPL (`python`, `python -` with empty input, `node`) without a script or `-c`/`-e`: in the background it can loop on errors and fill the disk.
- Several sessions may run tests at the same time; a timeout under load is not a failure of your change — re-run once before investigating.

## Writing
- Plain language, no jargon; lead with the answer.
