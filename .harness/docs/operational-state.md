# Operational State

The harness keeps human-readable policy in docs and durable task operations in
SQLite. The local database is `.harness/state/harness.db`; it is runtime state,
not source code. The committed schema is `.harness/state/schema.sql`.

Use the repo-local CLI:

```bash
node .harness/scripts/harness-state.mjs init
node .harness/scripts/harness-state.mjs intake --type=change_request --summary="Add export flow" --lane=normal
node .harness/scripts/harness-state.mjs trace --summary="Implemented export flow" --outcome=completed --lane=normal --agent=codex --actions="read docs,patched service,ran tests" --read=".harness/docs/context-rules.md,src/export.ts" --changed="src/export.ts,tests/export.test.ts" --friction=none
node .harness/scripts/harness-state.mjs session-worktree record --session-id=export-001 --task=export-flow --branch=agent/export-flow --source-root="$PWD" --worktree="../.agent-worktrees/app-export-flow"
node .harness/scripts/harness-state.mjs query stats
node .harness/scripts/harness-state.mjs query session-worktrees
node .harness/scripts/harness-state.mjs trace-quality --strict
node .harness/scripts/harness-state.mjs doctor
node .harness/scripts/harness-state.mjs migrate --dry-run
node .harness/scripts/harness-state.mjs export --redact > state-export.json
node .harness/scripts/harness-state.mjs prune --older-than=30d --dry-run
node .harness/scripts/harness-state.mjs explain <runId>
```

## Tables

- `intake`: request classification, risk lane, affected docs, and optional story.
- `story`: work packets and unit/integration/e2e/platform proof flags.
- `decision_record`: durable decisions plus optional verification commands.
- `backlog`: harness improvement proposals with predicted and actual outcome.
- `trace`: task execution records, files read/changed, decisions, errors,
  friction, and computed trace quality.
- `session_worktree`: prepared isolated worktrees keyed by session id, with task
  id, branch, source root, manifest path, active-task env, and lifecycle status.
- `state_migration`: applied operational-state schema migration ledger.

## Governance Commands

- `doctor`: checks sqlite availability, schema presence, database integrity,
  expected tables, migration state, and trace-quality status.
- `migrate --dry-run`: reports pending state migrations without writing.
- `migrate`: initializes or upgrades the local state database to the current
  schema version.
- `export --redact`: prints JSON with secrets and local paths redacted by
  default; use unredacted exports only for local debugging.
- `prune --older-than=30d`: removes old traces/intakes and closed operational
  rows according to the configured retention window.
- `explain <runId>`: shows matching trace, story, intake, decision, backlog, and
  session-worktree records for a run/task/session identifier.

## Rules

- Initialize the database before recording operational state.
- Do not hand-edit `harness.db`; use `harness-state.mjs`.
- Keep exports redacted before sharing them in issues, PRs, or support threads.
- If a task exposes missing proof, stale docs, repeated manual work, or a
  confusing rule, record `harness_friction` in the trace and add a backlog item
  when the fix is outside the current task.
- Readiness validates schema presence, migration health, database integrity, and
  trace quality. It does not require a database to already exist in a fresh
  install.
