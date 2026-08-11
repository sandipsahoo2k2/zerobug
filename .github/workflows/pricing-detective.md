---
# Everything above the second --- is configuration. Everything below it is the program,
# written in English. That inversion is the whole idea of an agentic workflow.

on:
  workflow_dispatch:

# The agent itself only ever gets read access. It cannot open the issue below directly.
permissions:
  contents: read

# One line picks the coding agent. Swap for claude / codex / gemini and change nothing else.
engine: copilot

# What the agent is allowed to reach for. Anything not listed here does not exist to it.
tools:
  bash: ["git log", "git show", "git blame"]
  github:
    toolsets: [repos]

# The only way anything gets written. The agent emits a JSON object asking for this; a
# separate job with write permission carries it out, capped at one issue per run.
safe-outputs:
  create-issue:
    title-prefix: "[agentic demo] "
    labels: [zerobug-demo]
    max: 1

timeout-minutes: 10
---

# Pricing detective

`sample-app/` prices a shopping cart. `sample-app/docs/pricing-rules.md` states the rules the
code is supposed to follow.

Do this:

1. Read the pricing rules document, then read the pricing source.
2. Find the place where the code disagrees with the document. It is a comparison operator.
3. Use `git log` and `git show` to find the commit that introduced the disagreement.
4. Open one issue reporting it.

The issue body must contain, and nothing else:

- The file and line number.
- The rule as written in the document, and what the code actually does.
- The commit SHA and its subject line.
- One sentence on why the existing tests did not catch it.

Do not modify any files. Do not open a pull request.
