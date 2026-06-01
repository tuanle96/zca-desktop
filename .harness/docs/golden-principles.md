# Golden principles

These are invariants that must hold across the codebase. Each one traces to a
specific past failure or a deliberate trade-off. **Every line here must be
mechanically enforceable** — if it can't be, it doesn't belong here; promote
it to a structural test or demote it to a comment in the affected file.

The garbage-collection ritual (`/garbage-collection`) diffs the codebase
against this file weekly.

## 1. Forward-only layer dependencies

`types → config → store → zalo → session → command`  (Rust core; UI = SvelteKit `src/`)

Why: prevents circular imports, makes refactors local, mirrors OpenAI's Codex
codebase rule.
Enforced by: structural test (`.harness/config.json` `domains[].layers`). The
TypeScript adapter also blocks `src/runtime/` files from importing `src/ui/`,
keeping runtime code independent from presentation code.

For TypeScript projects, `.harness/config.json#structuralTest.rules` also
blocks two common agent shortcuts by default: raw `process.env` /
`import.meta.env` outside the config layer, and UI imports of repository or
database-client modules.

## 2. Validate at boundaries; trust internals

External input (HTTP body, CLI arg, file content) is parsed into a typed
object at the runtime boundary. Internal code assumes the type holds.

Why: removes "defensive" type checks scattered across services that hide
bugs.
Enforced by: code review + `security-reviewer` subagent.

## 3. Shared utilities live in `src/shared/`

Before adding a helper to a module, search `src/shared/` for an existing one.
If you write a duplicate, the garbage-collection skill will surface it.

Why: a real recurring failure mode in agent-generated code is duplicated
helpers. OpenAI's Codex team explicitly tracks this.
Enforced by: `garbage-collection` skill (duplicate-utility scan).

## 4. Tests are end-to-end through one feature

A test exercises one entry from `.harness/feature_list.json` end-to-end. We don't
write isolated unit tests for inner helpers unless a bug repro demands one.

Why: agent-generated unit tests mock everything and verify nothing.
Enforced by: code review.

## 5. Bounded retries and timeouts on every external call

Every `fetch`/`httpx`/`requests` call has an explicit timeout. Every retry
loop has both `maxAttempts` and a deadline. No `while True:` in production
code.

Why: agents love infinite retries.
Enforced by: `reliability-reviewer` subagent.

## 6. JSON beats Markdown for state the agent updates

`.harness/feature_list.json`, `.harness/installed.json`, structural-baseline — all
JSON. Anthropic's long-running-agent guide: "the model is less likely to
inappropriately change or overwrite JSON files compared to Markdown files."

Why: the agent treats Markdown as freely-editable prose.
Enforced by: file format choice.

## 7. Every agent failure becomes a permanent prevention

When the agent does something wrong, the response is **not** to add a "be
careful about X" line to CLAUDE.md. It is to:

- add context to `.harness/docs/`, OR
- add a structural test rule, OR
- add a hook, OR
- add a skill.

Why: Mitchell Hashimoto's discipline. CLAUDE.md is a table of contents — it
won't be re-read on every action.
Enforced by: `/propose-harness-improvement` skill.

## 8. CLAUDE.md is bounded — at most 200 instructions

CLAUDE.md is loaded into context every session. Beyond ~150-200 instructions
(HumanLayer measurement) agents stop following it reliably; verbose
CLAUDE.md silently degrades behavior. Promote details to `.harness/docs/` or use
`@-imports` to load context on demand.

Why: closes principle 7's loop — without a hard cap, "every failure becomes
a CLAUDE.md line" is the path of least resistance and CLAUDE.md grows
unbounded until the agent ignores it.
Enforced by: Stop hook (`.harness/scripts/precompletion-checklist.sh`) counts
bullets and numbered items in `CLAUDE.md` against
`.harness/config.json` `claudeMd.maxInstructions` (default 200) and blocks
the stop on overflow.

## 9. Baselines are decreasing-only

`.harness/structural-baseline.json` lists existing violations the codebase
inherits when a new structural rule is introduced. New code must not add to
this file — fixes only REMOVE entries.

Why: a growing baseline silently masks structural-test failures. Without
this guard, the path of least resistance for a violation is "append it to
the baseline," which defeats the rule. PMD's baseline pattern works only
because it's enforced as monotonic.
Enforced by: pre-push hook (`.harness/scripts/pre-push.sh`) and readiness
gate (`.harness/scripts/check-structural-baseline.mjs`) compare
`.harness/structural-baseline.json` length to its HEAD version and block
growth. The checker also validates that the baseline is a unique array of
violation keys, and `harness-report` surfaces any remaining entries as debt.

## 10. Reviewer subagent triggers are mechanical, not self-judged

`architecture-reviewer` runs when changes span ≥2 layers in a single
domain. The decision is made by counting layers off
`.harness/config.json` `domains[].layers` against the changed-file set —
not by the agent guessing whether its diff "touches multiple layers".

Why: self-judged triggers fail open on borderline cases. The agent that
just shipped a layer-spanning change is the one least equipped to notice
it. Mechanical counting closes that gap.
Enforced by: Stop hook (`.harness/scripts/precompletion-checklist.sh`) emits a
`multi-layer-review` failure when `git` reveals ≥2 touched layers in any
domain. The agent reads the recommendation, invokes
`architecture-reviewer` (or documents why review is unnecessary), and the
loop guard (`stop_hook_active`) lets the next stop succeed.

## 11. HTML for human deliverables, Markdown for agent files

Files an agent reads-and-edits (`CLAUDE.md`, `.claude/skills/*/SKILL.md`,
`.claude/agents/*.md`, `.harness/docs/architecture.md`, `.harness/docs/adr/*.md`, ADR notes,
inline review output) stay as Markdown. Files a HUMAN reads-and-decides
(audit reports, analyses, plans, decision docs, next-actions reviews,
status snapshots) ship as self-contained HTML, written by the
`/deliver-html` skill against the shared dark-theme CSS.

Why: a 700-line Markdown deliverable forces the human to scroll, miss the
conclusion, and ask the agent to clarify — a wasted turn that costs more
tokens than the HTML overhead it was meant to avoid. HTML deliverables are
"read once, decide once." Markdown has no visual hierarchy strong enough to
support decision-grade reading at length.
Enforced by:

- `/deliver-html` skill triggers on user intent ("analyze", "audit",
  "review", "phân tích", "báo cáo", "plan", "proposal", "decision doc",
  "next actions") and writes `<slug>.html` at repo root.
- Stop hook nudge: when the prompt matches those keywords and the session
  produced only `.md` files at repo root, the agent is reminded to invoke
  `/deliver-html`. Non-blocking.
- ADR-0002 documents the trade-off (token cost +30-50% on the rendered
  output, paid back by saving ≥1 clarification turn).

Counter-rules — when Markdown is still correct:

- `README.md`, `CHANGELOG.md` — npm/GitHub renders them; human installs/diffs.
- Stdout from `/review-this-pr`, `/garbage-collection`, structural reports —
  agent consumes the output.
- Short summaries (< 30 lines) — answer inline, no file.

---

_Add new principles via `/structural-test-author`, which forces you to
codify the enforcement mechanism alongside the rule._
