---
name: investigate-bug
description: "Investigate a bug — check the gotchas, form a hypothesis, propose an experiment before fixing"
disable-model-invocation: true
argument-hint: "<one-line bug description, with repro steps if known>"
---

Bug: $ARGUMENTS

Treat the repro and suspected surface as unknown unless the description gives them.

Grep `docs/gotchas.md` for the error text first. Then load `AGENTS.md`, the DECs for the surface in `docs/design-decisions.md`, the newest `docs/session-notes.md` entry, and the failing code. Read `docs/feature-specs.md` only to re-check acceptance criteria (the feature has shipped), and leave out `docs/plan.md`.

Don't fix yet. Propose:

1. The smallest set of files to read to confirm or refute your hypothesis.
2. Your hypothesis in one sentence, plus one alternative you haven't ruled out.
3. The cheapest experiment whose result would falsify it.
4. Whether the bug suggests a DEC needs revisiting (yes or no, and which).

Wait for the user's go before changing code. Once the fix lands, say whether the cause earns a `docs/gotchas.md` entry, a guard, or a comment where it bites, and add it in the same commit.
