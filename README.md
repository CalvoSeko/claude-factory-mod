# claude-factory-mod

**agent-graph** is a Claude Code mod for designing a team of agents as a graph and running it, from a pane inside Claude Code.

- **Cards and arrows.** Each card is an agent with its own instructions, skills, context files, tools, model and budget. A *handoff* arrow passes one agent's result to the next; a *delegate* arrow lets an agent call another as a helper; a *retry* arrow sends work back until a judge passes it.
- **Check cards.** A card can run a shell command (tests, lint, type-check) instead of an agent; a failing check sends the work back along its retry arrow.
- **Runs you can watch.** Cards show live status, cost and the tool calls each agent makes. Pause before a card, edit what an agent got and run from there, or rerun from any card.
- **Limits.** A budget per agent and a cap per run.
- **Local or cloud.** Run agents as Claude Code subagents, or as Claude Managed Agents.
- **Claude can run your graphs.** Each graph is also a tool the main Claude session can call with a task.

## Install

Requires a Claude Code build with function-hook mods (`claude plugin test` and `claude plugin validate` available).

```bash
git clone https://github.com/CalvoSeko/claude-factory-mod.git
claude --plugin-dir ./claude-factory-mod/agent-graph
```

To load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Then type `/agent-graph` to open the editor.

Graphs saved as JSON in `~/.claude/agent-graph/import/` are imported when a session starts or `/agent-graph` runs.

## Cloud graphs

Cloud graphs use your Claude Code Anthropic login, or an API key set in the plugin's settings (`anthropicApiKey`, stored as a sensitive setting). The mod never archives or deletes your Managed Agents sessions, agents or files.

## Auto mode

Runs do not work in auto mode yet. The mod starts each card's agent itself, and auto mode's classifier cannot judge an agent start that no message in the conversation asked for, so the card fails ("gave no verdict for Agent"). Plugins have no way to approve their own agent starts, so until Claude Code changes this, switch to another permission mode (for example Accept edits) before starting a run and keep it until the run ends.

## Develop

```bash
npm test
npm run typecheck
npm run lint
```

`FACTORY.md` holds the house rules for agents (and people) working on this repository.

## License

MIT — see `LICENSE`.
