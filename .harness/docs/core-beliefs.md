# Core beliefs

Beliefs are higher-level than golden principles. Beliefs explain *why* the
project exists; principles explain *how* the code is shaped. If a belief
changes, expect the principles to ripple.

## What this codebase is

zca-desktop — solo-dev project on the agent-harness-kit harness.

## Why these constraints exist

1. **Solo developer, no review queue.** Every constraint must pull weight
   without a second pair of eyes. The harness IS the review queue.
2. **Agent-driven development is the default mode.** Code is written by
   Claude Code with a human in the loop, not the other way around. Patterns
   that humans tolerate but agents abuse (vague names, "just one more flag",
   lazy `any` / `Dict[str, Any]`) are out.
3. **Time-to-mistake-fix matters more than time-to-write.** A mistake that
   surfaces in the PostToolUse hook costs ~30 seconds. The same mistake in
   a code review costs minutes. The same mistake in production costs hours.
   Every constraint is timed against this gradient.

## What we're optimizing for

- Throughput per dev-hour at constant quality.
- Refactor blast radius — changes should stay within one domain.
- Decisional consistency — two consecutive sessions should produce the same
  shape of solution to the same problem.

## What we're NOT optimizing for

- Multi-team coordination, RFC queues, or governance.
- Frontier-grade test coverage. Agent-written unit tests are a liability;
  feature-level tests are the floor.
- Maximum flexibility. The harness is opinionated on purpose.

---

_Edit this file when the project's purpose changes — not when you change a
library or a layer name. For those, write an ADR._
