---
name: review-this-pr
description: Use this skill to run a deterministic review of the current branch against its base — git diff base...HEAD, structural-test, baseline-monotonic check, and a markdown summary that lists each violating file with its layer rule. Replaces the "ask the agent to review the diff" pattern, which routinely misses cross-file drift.
allowed-tools: Read, Bash(git diff:*, git log:*, git merge-base:*, node .kiro/skills/review-this-pr/scripts/pr-review-driver.mjs:*)
suggested-turns: 6
isolation: worktree
---

## When to invoke

- Before opening a PR (or before `gh pr create`).
- After a refactor where multiple files moved between layers.
- When CI lights up red and you want a fast local repro.

## Steps

1. **Identify base.**
   ```
   BASE=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)
   ```
2. **Run driver.**
   ```
   node .kiro/skills/review-this-pr/scripts/pr-review-driver.mjs --base "$BASE"
   ```
   Driver:
   - Collects `git diff --name-only $BASE..HEAD`.
   - Runs structural-test (workspace-wide for ts/py, file-scoped fallback).
   - Diffs `.harness/structural-baseline.json` between $BASE and HEAD —
     monotonic violation (baseline grew) is a hard fail.
   - Reads each changed file's layer mapping via .harness/config.json.
3. **Read the report.** Output is markdown to stdout (or `--out report.md`).
   Sections: Summary, Layer-map of changed files, Structural-test results,
   Baseline delta, Per-reviewer hand-off (architecture, security, performance,
   reliability).
4. **Address each FAIL.** Re-run the driver until all sections are PASS.
5. **Hand-off to reviewers.** If isolated review is needed, invoke
   `/architecture-reviewer` / `/security-reviewer` etc. with the report as
   context.

## Output contract (driver JSON tail)

```
{
  "base": "<sha>",
  "changed_files": <N>,
  "violations": <M>,
  "baseline_delta": <K>,
  "passed": <bool>
}
```

## Anti-patterns

- Don't skip the structural-test "because the build passes" — the build
  catches type errors; structural-test catches layer-rule violations that
  TypeScript happily accepts.
- Don't paper over a baseline-delta with `git checkout HEAD~1 -- .harness/`
  — the monotonic guard exists *because* that paper-over is the agent's
  first instinct.
