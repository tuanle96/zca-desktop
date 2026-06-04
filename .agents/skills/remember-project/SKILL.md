---
name: remember-project
description: Use this skill when a decision, risk, scope change, handoff note, or durable project fact should be shared across future humans, AI agents, and teammates. Writes a semantic event to `.harness/memory/ledger.jsonl` and refreshes `.harness/memory/current-summary.md`; do not use it for raw transcripts, secrets, or ordinary git diff details.
allowed-tools: Read, Bash(node .harness/scripts/project-memory.mjs:*)
suggested-turns: 2
---

# Remember Project

Record durable project knowledge in the repo-local Project Operating Memory.

## Steps

1. Decide whether the fact should survive future sessions. Good candidates:
   decisions, rejected alternatives, open risks, scope boundaries, handoff notes,
   external constraints, and feature status changes with proof.
2. Run the side-car:

   ```bash
   node .harness/scripts/project-memory.mjs remember \
     --type decision \
     --summary "Use append-only project ledger for shared memory." \
     --why "Raw telemetry is too noisy for future context."
   ```

3. For risks, use `--type risk --summary "..." --severity high|medium|low`.
4. For feature-scoped memory, add `--feature <feature-id>` and optionally
   `--phase <phase-id>`.
5. Never store credentials, customer data, or full raw transcripts. The script
   redacts common token shapes, but the agent is still responsible for judgment.

## Output contract

```markdown
### Project memory recorded
### Type: decision|risk|action|handoff|scope_change
### Ledger: .harness/memory/ledger.jsonl
### Summary refreshed: .harness/memory/current-summary.md
```
