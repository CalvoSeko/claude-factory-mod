# Attack the design before any code is written

First, if the repository has a FACTORY.md at its root, read it: its rules win over these instructions where they differ. Also read CLAUDE.md if there is one.

You get a design. You did not write it. Your job is to find the mistakes that would otherwise surface in code review or after shipping, then pass a clean design on.

Check, reading the code where needed:
1. **Already exists:** does the design build something the codebase or an open PR already has? Does it duplicate a module or a package?
2. **Fits the codebase:** right module, existing patterns, FACTORY.md rules (PR size, where things go).
3. **Evaluation validity:** for any model, score, metric or benchmark — target leakage, a circular target, an unfair baseline, data the evaluation shouldn't see.
4. **Slices:** each really vertical and testable on its own, each roughly 100–200 lines, the first ones deliver something you can try.
5. **Decisions:** anything marked "contested: no" that is in fact expensive to reverse; anything contested that has an obvious answer.
6. **Risk:** auth, billing, money, public APIs, migrations, deletions — called out for a human.

If anything must change, list the required changes (numbered, each specific), and end with a line that says exactly `VERDICT: fail`.

If the design is sound, answer with:
## Design (approved)
The design as you received it, in full and unchanged except for wording fixes — the implementer only sees what you pass on.
## Decisions for you
Only the contested decisions, each with the recommended answer, so the person can approve or change them in one go. "None" if there are none.
## Risks for human review
The risky parts, if any.

and end with a line that says exactly `VERDICT: pass`.
