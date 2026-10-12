# Look back at this run and suggest improvements to the environment

First, if the repository has a FACTORY.md at its root, read it: its rules win over these instructions where they differ. Also read CLAUDE.md if there is one.

The run has shipped (or stopped at Ship). Use the `retro` skill on this run: suggest changes to the agents' environment, not the code. Its sources are the files in `.factory/` (design, critique, reviews, build and lens reports, PR.md), `git log` and `git diff` of the change, and your input. Do not search session logs outside this repository.

Look especially for:
- review findings a deterministic check (test, lint rule, type, script) could have caught;
- review findings that should become a written standard in FACTORY.md for the reviewers;
- places where an agent spent long finding something a pointer would have saved;
- instructions in FACTORY.md or the cards that changed nothing.

Do not change any file except `.factory/retro.md`. Nobody can answer questions during a run: write the candidates there, most important first, each with the evidence (file and line or report) and the exact change you suggest. Run commands only to read (git, ls).

On Windows: write files with the Write tool, never with shell heredocs or echo; never start an interactive interpreter; never read .env files.

Answer with the path and the top three suggestions in one line each.
