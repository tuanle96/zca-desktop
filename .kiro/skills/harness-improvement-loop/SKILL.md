---
name: harness-improvement-loop
description: Use this skill after a trace-backed agent failure or repeated harness friction. Turns the failure into a ranked harness change, records a prediction, applies the smallest prevention, and reruns the relevant eval/regression gate. This is the agent-harness-kit AHE-lite loop.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(git diff:*), Bash(npm run harness:eval:*), Bash(node .harness/scripts/improvement-bundle.mjs:*), Bash(node .harness/scripts/record-failure.mjs:*), Bash(node .harness/scripts/check-failure-records.mjs:*), Bash(node .harness/scripts/harness-report.mjs:*), Bash(node .harness/scripts/regression-runner.mjs:*)
---

# Harness Improvement Loop

## When to use

- `/trace-analyzer` found a durable harness failure.
- A skill, hook, agent, or eval needs to change because the same mistake can recur.
- The user asks to "make the harness learn from this", "AHE-lite", or "prevent this next time".

## Steps

1. Read the trace analysis and name the smallest prevention target.
2. Gather deterministic signals before deciding. Run the runtime-agnostic
   improvement bundle:

   ```bash
   node .harness/scripts/improvement-bundle.mjs --window 14
   ```

   Treat `taxonomy_classification`, `suggested_records`, and `nextSteps` as
   the machine-readable starting point. If no signal appears, use the user's
   failure report as evidence and record that evidence path explicitly.
3. Read `.harness/failures/taxonomy.json`. If no failure record exists yet,
   run the relevant suggested `record-failure.mjs` command from the bundle, or
   create one with `.harness/scripts/record-failure.mjs`. It writes
   `.harness/failures/records/<id>.json`, emits promotion `nextSteps`, and
   validates the record.
4. Write a prediction record before editing:
   `.harness/improvements/<YYYYMMDD-HHMM>-<slug>.json`
5. Include these fields:
   - `failureClass`
   - `preventionTarget`
   - `failureRecordPath`
   - `expectedMetric`
   - `expectedDirection`
   - `baselineEvidence`
   - `verificationCommand`
6. Apply the smallest change in one place: skill, hook, subagent, deterministic script, eval task, permission policy, structural rule, or docs.
7. Run the matching verification command. Prefer the narrow eval first, then a broader regression run if the change touches shared harness behavior.
8. Run `.harness/scripts/check-failure-records.mjs`.
9. Run `.harness/scripts/harness-report.mjs --json --fail-on=fail --review-promotion=fail`
   and follow any `repairCommands` or `nextSteps` it emits.
10. Append the observed result to the prediction record and promote the failure
   record with `.harness/scripts/record-failure.mjs --update=<id>
   --status=applied|verified ...`. Do not hand-edit promotion state unless the
   helper is unavailable.

## Prediction record shape

```json
{
  "failureClass": "context-miss",
  "preventionTarget": "skill",
  "failureRecordPath": ".harness/failures/records/20260527-context-miss.json",
  "expectedMetric": "task pass rate",
  "expectedDirection": "increase",
  "baselineEvidence": ".harness/eval/results/latest.jsonl",
  "verificationCommand": "npm run harness:eval -- --quick --transport=mock",
  "observedResult": null
}
```

## Output contract

```markdown
### Harness improvement
**Failure class:** <class>
**Signal bundle:** <bundle command or evidence path>
**Changed:** <file list>
**Prediction:** <metric direction>
**Verified:** <command and result>
**Remaining risk:** <known gap or none>
```

## Anti-patterns

- Do not change a broad prompt when a deterministic script or eval can prevent the issue.
- Do not mark the improvement successful without recording observed results.
- Do not bundle unrelated harness improvements into one loop.
