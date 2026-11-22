---
name: feat-verify
description: "Gather the evidence that a FEAT's acceptance criteria pass, without changing code"
disable-model-invocation: true
argument-hint: "<FEAT number, e.g. 12>"
---

FEAT-$ARGUMENTS is reported implemented. Gather the evidence without changing code.

Load `AGENTS.md`, `docs/feature-specs.md §FEAT-$ARGUMENTS`, the kick-off plan, and the test output. Read code only as far as the evidence needs.

1. For each acceptance criterion, give the evidence that it passes: a test name and file, or a manual probe and its output.
2. Flag each criterion you couldn't verify, and why.
3. Run what you can of the FEAT's manual verification and gate check, and name the steps that need the user (production, a phone, a real email, the real model adapter).
4. Note any drift from the kick-off plan and its reason.
5. Propose one commit message in the project's style, starting from the one in the Definition of done.

Don't tick any box or mark the FEAT complete. The user verifies and ticks.
