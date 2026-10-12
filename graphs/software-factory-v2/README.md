# Software factory v2

A graph that turns a feature request into a reviewed, tested pull request, following the `FACTORY.md` of the repository it runs in.

```mermaid
flowchart LR
  Recon[Repo Recon] --> Design --> Critic[Design Critic]
  Critic -. retry .-> Design
  Critic --> Build[Build Orchestrator ⏸]
  Build --> Tests{{Tests}}
  Tests -. retry .-> Build
  Tests --> Fixes[Review Fixes] --> Reviewer
  Reviewer -. retry .-> Fixes
  Reviewer --> DoD{{Definition of Done}} --> PR[PR Writer] --> Ship[Ship ⏸] --> Retro
```

- **Repo Recon** finds what already exists, the branch state, and the commands to test, type-check and lint.
- **Design** proposes every decision. **Design Critic** sends the design back until it holds, so only the contested decisions reach you.
- **Build Orchestrator** pauses for you, then hands the design's slices to builders. Logic, data and test slices go to **Implementer**; screens go to **UI Implementer**. Builders whose files don't overlap work in parallel, and independent slices that would touch the same files get their own worktrees.
- **Tests** sends failures back to the builders.
- **Reviewer** starts three **Lens Reviewers** (correctness, design and maintainability, tests) and merges their findings. **Review Fixes** applies the required ones.
- **Definition of Done** runs the tests, lint, type check and e2e.
- **PR Writer** writes the PR description and updates `HOW-IT-WORKS.md`.
- **Ship** pauses for you, then commits, pushes and opens the PR. It never merges.
- **Retro** writes suggested improvements to the agents' environment to `.factory/retro.md`.
- **Codebase Scout** (haiku) answers "where is X" for Design, Build Orchestrator, Implementer and Reviewer.

Backend: Headless, so each card runs as its own `claude -p --permission-mode auto` process. Run cap: $120.

## Skills it uses

Install these first; a card whose skill is missing runs without it.

| Skill | Source | Cards |
|---|---|---|
| `domain-modeling`, `codebase-design`, `tdd`, `diagnosing-bugs`, `retro` | [mattpocock/skills](https://github.com/mattpocock/skills) | Repo Recon, Design, Design Critic, Implementer, Reviewer, Lens Reviewer, Retro |
| `ponytail` | [dietrichgebert/ponytail](https://github.com/dietrichgebert/ponytail) | Design, Implementer, UI Implementer, Review Fixes, Reviewer, Lens Reviewer |
| `impeccable` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | UI Implementer |

## Install

From the root of this repository, copy the instructions into the graph's own folder first, then the graph into the import folder:

```bash
mkdir -p ~/.claude/agent-graph/g_2fcd5ec984 ~/.claude/agent-graph/import
cp graphs/software-factory-v2/instructions/*.md ~/.claude/agent-graph/g_2fcd5ec984/
cp graphs/software-factory-v2/graph.json ~/.claude/agent-graph/import/software-factory-v2.json
```

Then type `/agent-graph`. The graph is imported **untrusted**: press Run to review every card's tools, model, budget and check commands, then **Trust and run**. Run it from inside the repository you want changed, with the feature request as the task.
