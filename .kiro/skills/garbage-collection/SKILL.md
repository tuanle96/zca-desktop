---
name: garbage-collection
description: Use this skill on Fridays, before tagging a release, or when the user mentions "cleanup", "tech debt", "AI slop", "GC", or "garbage collection". Runs the deterministic linters, structural tests, and doc-drift scans, then proposes the top-3 highest-leverage cleanups (with risk/cost/benefit) — does NOT auto-merge. This is the solo-dev shrunk version of OpenAI's Friday garbage-collection ritual.
allowed-tools: Read, Glob, Grep, Bash(npm run:*), Bash(pytest:*), Bash(ruff:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(gh pr create:*), Bash(node .kiro/skills/garbage-collection/scripts/gc-classify.mjs:*)
suggested-turns: 15
---

## Steps

1. **Capture baseline.** Run the full suite and save the output:
   - `npm run harness:check`
   - `npm run lint -- --format json`
   - Save to `.harness/gc-<date>.json`.
2. **Classify violations.** For each finding:
   - **Layer violation** → fix.
   - **Duplicate utility** (same function body in 2+ places) → propose
     extraction to `src/shared/`.
   - **Dead import** → remove.
   - **Doc drift** (a path in `.harness/docs/architecture.md` no longer exists) →
     invoke `doc-drift-scan` skill.
   - **Hand-rolled helper** matching a shared utility → propose replacement.
3. **Score** each candidate fix on three 1–5 dimensions via the side-car
   script (replaces the previous LLM-scored turn — deterministic and
   auditable):

   ```bash
   node .kiro/skills/garbage-collection/scripts/gc-classify.mjs \
     --baseline .harness/gc-<date>.json \
     --history  .harness/gc-history.json
   ```

   The script applies the mechanical rubric: `risk = 1 + ceil(touched/3)`,
   `cost = 1 + ceil(lines/30)`, `benefit = recurrenceCount(class)`. Read
   the JSON `candidates[]` sorted by `(benefit desc, cost asc, risk asc)`.
4. **Propose ONLY the top 3** cleanups (solo-dev cap; OpenAI does dozens, you
   do 3). Open them as separate PRs with `gh pr create --label gc --draft`.
5. **Append a row** to `.harness/gc-history.json`:
   `{ "date": "...", "violations_found": N, "fixes_opened": M, "total_tokens": K }`.
6. **Stop.** Do not merge anything. Human review required at solo scale.

## Output contract

```
### GC run: <date>
### Violations found: <N>
### Top 3 fixes proposed:
1. <slug> — risk:<1-5> cost:<1-5> benefit:<1-5> — PR #<n>
2. ...
3. ...
### Fixes deferred (not in top 3): <count>
```

## Anti-patterns

- Don't open more than 3 PRs in one run. The cap is a feature, not a bug.
- Don't auto-merge — the entire point of solo-scale GC is human review.
- Don't suppress findings that score low; record them in
  `.harness/gc-history.json` so trends surface over time.
