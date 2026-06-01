---
name: regression-benchmark
description: Run Tier 2 real-world-style regression benchmarks with isolated workspaces, hidden checks, A/B comparison, cost/time metrics, and HTML dashboard reporting.
allowed-tools: Read, Grep, Glob, LS, Bash(node .harness/scripts/regression-runner.mjs:*), Bash(node .harness/scripts/regression-compare.mjs:*), Bash(node .harness/scripts/regression-report.mjs:*)
suggested-turns: 8
---

# Regression Benchmark

Tier 2 benchmark suite for agent-harness-kit.

## Commands

```bash
node scripts/regression-runner.mjs --transport=mock --variant=current
node scripts/regression-runner.mjs --transport=claude-cli --variant=current --limit=5
node scripts/regression-runner.mjs --transport=claude-cli --variant=current --sessions=3 --quality-threshold=0.9 --decay-threshold=0.1
node scripts/regression-runner.mjs --transport=claude-cli --variant=candidate
node scripts/regression-compare.mjs
node scripts/regression-report.mjs
```

## What it measures

- Pass rate by regression task.
- Failure class distribution.
- Cost per run and tokens per run.
- Permission/intervention count.
- Files changed and hidden checks.
- Multi-session pass distribution, flaky tasks, and quality decay.
- A/B deltas across variants.
