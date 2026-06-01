---
name: eval-rubric-author
description: Use this skill when adding or changing harness eval tasks. Writes deterministic checks first, then optional rubric dimensions with JSON output, so evals grade outcome, process, style, and efficiency without becoming vague prompt feedback.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(npm run harness:eval:*), Bash(npm run check:eval-tasks:*), Bash(node .harness/scripts/eval-runner-v2.mjs:*), Bash(node .harness/scripts/check-eval-tasks.mjs:*)
---

# Eval Rubric Author

## When to use

- Adding a new eval or regression task.
- A task passes even though the agent behavior was bad.
- A model-assisted rubric is needed for process/style judgment after deterministic checks pass.
- The user asks for "rubric", "eval task", "hidden check", or "judge schema".

## Steps

1. Define the behavior being protected in one sentence.
2. Add deterministic outcome checks first: `expected.acceptanceChecks`,
   files changed, command output, JSON shape, hidden check, or structural rule.
   Use concrete, non-destructive commands only; keep required files as
   repo-relative local paths.
3. Add rubric dimensions only for what deterministic checks cannot judge:
   - `outcome`
   - `process`
   - `style`
   - `efficiency`
   A rubric alone must not be the task's only truth signal.
4. Require machine-readable judge output with `passed`, `score`, `reason`, and `evidence`.
5. Add at least one negative fixture or failure example.
6. Run `npm run check:eval-tasks` (kit repo) or `npm run harness:eval:check`
   (installed repo) before running the narrow eval.
7. Run the narrow eval and inspect the JSONL, not just the exit code.

## Rubric JSON shape

```json
{
  "dimension": "process",
  "passed": true,
  "score": 0.9,
  "reason": "The agent inspected the target module before editing.",
  "evidence": ["transcript:tool_call:inspect-module"]
}
```

## Eval task deterministic check shape

```json
{
  "expected": {
    "acceptanceChecks": [
      {
        "id": "checkout-coupon-e2e",
        "command": "npm run test:e2e -- checkout-coupon",
        "timeoutMs": 120000
      }
    ]
  }
}
```

Legacy `expected.acceptanceCheck` is accepted by the runner for real
`claude-cli` runs, but new tasks should use `acceptanceChecks` so each proof
has a stable id.

## Output contract

```markdown
### Eval rubric
**Task:** <task id>
**Deterministic checks:** <list>
**Rubric dimensions:** <list>
**Negative fixture:** <path or n/a>
**Verified:** <command and result>
```

## Anti-patterns

- Do not use a model judge for file existence, command success, or JSON schema checks.
- Do not create a rubric that can pass without evidence.
- Do not update a failing task's expected answer to match bad behavior.
