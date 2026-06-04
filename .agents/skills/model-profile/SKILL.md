---
name: model-profile
description: Use this skill when choosing, upgrading, or comparing models for a harness lane. Runs the same task set across candidate model profiles and reports pass rate, latency, token cost, intervention count, and failure class movement before changing defaults.
allowed-tools: Read, Write, Bash(node .harness/scripts/model-routing-report.mjs:*), Bash(node .harness/scripts/bench-runner.mjs:*), Bash(node .harness/scripts/bench-compare.mjs:*), Bash(node .harness/scripts/regression-runner.mjs:*), Bash(node .harness/scripts/regression-compare.mjs:*)
---

# Model Profile

## When to use

- A model default, reviewer model, or explorer model is being changed.
- A cheaper/faster model is considered for a specific harness lane.
- A benchmark improved or regressed and model behavior is a plausible factor.

## Steps

1. Define the lane being profiled: main implementation, explore, review, eval judge, or regression worker.
2. Run `.harness/scripts/model-routing-report.mjs --json` to inspect current
   lane/model attribution and identify overpowered or underpowered calls.
3. Pick the smallest representative task set that exercises that lane.
4. Run baseline and candidate profiles with the same tasks, prompts, and transport.
5. Compare:
   - pass rate
   - hidden check result
   - latency
   - input/output tokens
   - estimated cost
   - intervention count
   - failure class distribution
6. Recommend a model only for the lane that was measured.

## Output contract

```markdown
### Model profile
**Lane:** <lane>
**Baseline:** <model/profile>
**Candidate:** <model/profile>
**Decision:** keep baseline | switch candidate | rerun with broader set
**Evidence:** pass rate, cost, latency, interventions
**Scope:** <where this recommendation applies>
```

## Anti-patterns

- Do not generalize from one lane to all agents.
- Do not compare models with different task sets.
- Do not change defaults without a benchmark artifact.
