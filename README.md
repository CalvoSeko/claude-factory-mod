# claude-factory-mod

**agent-graph** is a Claude Code mod for designing a team of agents as a graph and running it, from a pane inside Claude Code.

- **Cards and arrows.** Each card is an agent with its own instructions, skills, context files, tools, model and budget. A *handoff* arrow passes one agent's result to the next; a *delegate* arrow lets an agent call another as a helper; a *retry* arrow sends work back until a judge passes it.
- **Check cards.** A card can run a shell command (tests, lint, type-check) instead of an agent; a failing check sends the work back along its retry arrow.
- **Runs you can watch.** Cards show live status, cost and the tool calls each agent makes. Pause before a card, edit what an agent got and run from there, or rerun from any card.
- **A band above the prompt.** During a run it shows which agents are working, which wait for you and which come next, and it lists the session's own subagents at work.
- **Your skills, linked or not.** Skills installed as links (as `npx skills` installs them) count when they lead to a folder inside your home folder.
- **Limits.** A budget per agent and a cap per run.
- **Retries after temporary failures.** An agent stopped by a usage limit, an overload (429/529), a network or a server error is started again after 30 s, 2 min, then 5 min (or the stated reset time), up to 3 times.
- **Local, Headless or Cloud.** Run agents as Claude Code subagents of your session, as their own headless Claude Code processes, or as Claude Managed Agents.
- **Claude can run your graphs.** Each graph is also a tool the main Claude session can call with a task.
- **Claude can read and edit your graphs.** `read_graph` shows a graph's cards, instructions and arrows; `edit_graph` applies a batch of changes as one undo step. Your permission rules decide whether an edit asks first, and adding or changing a check card's shell command always asks.

## Install

Requires a Claude Code build with function-hook mods (`claude plugin test` and `claude plugin validate` available).

```bash
git clone https://github.com/CalvoSeko/claude-factory-mod.git
claude --plugin-dir ./claude-factory-mod/agent-graph
```

To load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Then type `/agent-graph` to open the editor.

Graphs saved as JSON in `~/.claude/agent-graph/import/` are imported when a session starts or `/agent-graph` runs.

**Example graph:** [`graphs/software-factory-v2`](graphs/software-factory-v2/) turns a feature request into a reviewed, tested pull request. Its README has the install steps.

## Shared graphs

A graph runs agents and shell commands on your machine with your permissions. An imported graph therefore starts **untrusted**: it gets no tool, Claude cannot read, edit or run it, and pressing Run first shows everything it would do (each check command, each card's tools, model, budget and context files, its helpers and description). It runs only after you press **Trust and run**. Imports are also checked and clamped (ids, budgets, retries, run cap), and the mod only ever writes or deletes files inside the graph's own folder. Only trust graphs from people you trust. See `HOW-IT-WORKS.md` ("Shared graphs").

## Cloud graphs

Cloud graphs use your Claude Code Anthropic login, or an API key set in the plugin's settings (`anthropicApiKey`, stored as a sensitive setting). The mod never archives or deletes your Managed Agents sessions, agents or files.

## Auto mode

Use a **Headless** graph (toolbar button: Local → Headless → Cloud). Each card runs as its own `claude -p --permission-mode auto` process with the card's instructions, tools, model and budget, so auto mode judges every action against the card's own prompt. Card processes do not load agent-graph, do not reach your session, and are not saved to your resume list. Because those prompts are the graph author's, auto mode is not a safety boundary against a graph you have not reviewed, and card processes inherit your environment variables.

**Local** graphs do not work in auto mode: the mod starts each card's agent itself, auto mode's classifier cannot judge an agent start that no message asked for ("gave no verdict for Agent"), and plugins cannot approve their own agent starts. Run Local graphs in another permission mode (for example Accept edits).

## Develop

```bash
npm test
npm run typecheck
npm run lint
```

`FACTORY.md` holds the house rules for agents (and people) working on this repository.

## License

MIT — see `LICENSE`.
