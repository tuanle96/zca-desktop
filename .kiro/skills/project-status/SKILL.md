---
name: project-status
description: Use this skill when the user asks for project status, roadmap, MVP phase, scope, checklist, risks, handoff, harness control-plane health, or a project-management report. Renders project state, memory, orchestration, and session isolation into a self-contained HTML dashboard.
allowed-tools: Read, Bash(node .harness/scripts/project-status-report.mjs:*), Bash(node .harness/scripts/project-memory.mjs:*)
suggested-turns: 3
---

# Project Status

Render the repo-local project management state, shared memory ledger, and
harness control-plane health into a human-readable status report.

## Steps

1. Refresh the memory summary if needed:

   ```bash
   node .harness/scripts/project-memory.mjs summarize
   ```

2. Generate the HTML dashboard:

   ```bash
   node .harness/scripts/project-status-report.mjs
   ```

   Default output: `.harness/project/status.html`. The dashboard includes
   orchestration contracts/runs and session-isolation signals when those
   artifacts exist.

3. If a teammate handoff artifact is needed, export the portable JSON packet:

   ```bash
   node .harness/scripts/project-memory.mjs export
   ```

   Default output: `.harness/project/handoff.json`.

## Output contract

```markdown
### Project status report
### HTML: .harness/project/status.html
### Handoff: .harness/project/handoff.json (if exported)
### Current phase: <phase-id>
### Open risks: <count>
### Orchestration status: <pass|warn|fail>
### Session isolation status: <pass|warn|fail>
```
