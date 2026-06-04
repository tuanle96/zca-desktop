---
name: add-feature
description: Use this skill whenever the user asks to add, implement, or build a new feature, capability, endpoint, page, command, or anything user-visible. Enforces the Anthropic two-fold harness pattern — read .harness/feature_list.json, pick exactly one feature, implement incrementally, run the structural test on every save, and never declare "done" without updating the JSON. Always invoke this skill instead of writing new feature code freehand.
allowed-tools: Read, Edit, Write, Bash(npm run:*), Bash(pytest:*), Bash(ruff:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Glob, Grep
suggested-turns: 25
---

## Steps

1. **Read `.harness/feature_list.json`.** Confirm the feature exists and `passes:
   false`. If the user described a feature not in the list, **stop** and route
   the request through `/feature-intake` first.

   **Required before /add-feature:**
   - Tiny: `/feature-intake` → add to feature_list.json → `/add-feature`
   - Normal: `/feature-intake` → `/create-story` → add to feature_list.json → `/add-feature`
   - High-risk: `/feature-intake` → `/add-adr` (if arch) → `/create-story` → add to feature_list.json → `/add-feature`

   **Never skip `/feature-intake`** - it prevents "wrong direction" sessions.
2. **Read `.harness/docs/architecture.md`** for the affected domain. Identify which
   layers will change.
3. **Run `/inspect-module`** on each affected module. Do this even if you
   think you know the area — verify, don't assume.
4. **Plan first.** Write a one-paragraph plan to `.harness/PLAN.md` *before
   any code change*. (Anthropic Claude 4 prompt-guide pattern.)
5. **Implement smallest first.** Make the smallest change that turns one
   `steps[]` item from failing → passing.
6. **Run the structural test.** `npm run harness:check`.
   If it fails, fix the violation before continuing — never disable the test.
7. **Smoke test.** Run the relevant smoke test from `.harness/scripts/dev-up.sh`.
8. **Write or update the evidence bundle** referenced by the feature/story.
   Default path: `.harness/evidence/<feature_id>.json`. It must satisfy
   `.harness/schemas/evidence-bundle.schema.json` and include the structural
   command, smoke/test command, changed files, a concrete `diffSummary`, and
   any required reviewer decisions. Required reviewer decisions must include
   `reviewDecision` inline or a JSON artifact under
   `.harness/reviews/<feature_id>/<reviewer>.json`.
9. **Update `.harness/feature_list.json` ONLY** by changing the `passes` field of one
   item after the evidence bundle proves the feature. Never delete or rewrite
   items. (Anthropic JSON-over-Markdown rule: "the model is less likely to
   inappropriately change or overwrite JSON files compared to Markdown files.")
10. **Append to PROGRESS.** One line in `.harness/PROGRESS.md`:
   `YYYY-MM-DD HH:MM | <feature_id> | done`.
11. **Stop at commit-ready.** Do not run `git commit` from this skill. The
   default permission policy intentionally denies `git commit*`; leave the
   final commit to the user or a release/ship workflow with explicit approval.

## Failure modes to avoid (each line below corresponds to a real observed failure)

- Don't claim a feature is done without running the smoke test.
- Don't mark `passes: true` if the structural test is failing.
- Don't mark `passes: true` without an evidence bundle for the exact feature.
- Don't add a new feature to `.harness/feature_list.json` mid-session without
  first routing through `/feature-intake`.
- Don't refactor unrelated code in the same commit.
- Don't run `git commit`; this skill produces commit-ready evidence, not the
  commit itself.

## Output contract

After implementation, summarize:

```
### Feature: <id>
### Files changed: <list>
### Structural test: PASS|FAIL
### Smoke test: PASS|FAIL
### Evidence bundle: .harness/evidence/<feature_id>.json
### Review decision artifacts: .harness/reviews/<feature_id>/<reviewer>.json (if required)
### Reviewer subagents to invoke: architecture-reviewer, security-reviewer (if auth/IO touched), reliability-reviewer (if retries/timeouts touched)
```
