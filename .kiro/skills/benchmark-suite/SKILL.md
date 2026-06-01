---
name: benchmark-suite
description: Run Mini SWE-bench style harness regression tasks and A/B comparisons to measure harness improvement objectively.
allowed-tools: Read, Bash(node .harness/scripts/bench-runner.mjs:*), Bash(node .harness/scripts/bench-compare.mjs:*)
suggested-turns: 6
---

# Benchmark Suite

Use this when evaluating whether a harness change improved or regressed behavior.

## Commands

```bash
node .harness/scripts/bench-runner.mjs --variant=current
node .harness/scripts/bench-runner.mjs --variant=candidate
node .harness/scripts/bench-compare.mjs
```

## Output contract

```markdown
### Benchmark Suite
### Tasks: <n>
### Pass rate: <percent>
### Avg score: <score>
### A/B delta: <delta or n/a>
```
