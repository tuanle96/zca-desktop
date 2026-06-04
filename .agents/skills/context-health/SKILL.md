---
name: context-health
description: Inspect context usage, token budget, compaction history, and overflow risk. Use when sessions get long, before large changes, after compaction, or when cost/context drift is suspected.
allowed-tools: Read, Bash(node .kiro/skills/context-health/context-health.mjs:*)
suggested-turns: 4
---

# Context Health

Shows session context pressure using telemetry, compaction snapshots, and budget settings.

## Usage

```bash
/context-health
/context-health --last=7d
node .agents/skills/context-health/context-health.mjs --last=30d
```

## Output

- Provider token totals and average input/output ratio
- Highest-token sessions
- Compaction snapshot summary
- Budget status from `.harness/config.json.contextManagement`
- Recommendations before overflow
