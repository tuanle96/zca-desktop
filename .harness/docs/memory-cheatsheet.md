# Project memory cheat sheet

The kit ships a repo-local Project Operating Memory:

- `.harness/memory/ledger.jsonl` — append-only semantic memory events.
- `.harness/memory/current-summary.md` — compact summary injected by
  `SessionStart`.
- `.harness/project/state.json` — phases, MVP scope, checklists, risks,
  decisions, and feature rollups.

Claude Code may also maintain tool-local memory under
`~/.claude/projects/<repo-slug>/memory/`. Treat that as personal/tool context.
The `.harness/` memory is the project/team source of truth because it lives in
the repo, can be reviewed, and can be handed off.

## The event types

| Type | When to write | Half-life | Example |
| --- | --- | --- | --- |
| **decision** | A choice future agents should not rediscover | weeks to months | "Use append-only ledger, not raw telemetry, for shared memory." |
| **risk** | A blocker or release concern that must stay visible | days to weeks | "Search flow lacks browser proof on mobile." |
| **scope_change** | In/out scope changes for the active phase or MVP | days to months | "Billing is out of MVP." |
| **feature_created** | A story/feature enters the project plan | until shipped | "`feature-7` created with story packet." |
| **feature_status_change** | A feature moves state with proof | until shipped | "`feature-7` passes with integration test X." |
| **handoff** | Context another human/agent needs to continue | days to weeks | "Next owner should start from failing test Y." |
| **external_reference** | Pointer to issue, dashboard, PR, or runbook | until moved | "Linear project INGEST tracks pipeline bugs." |

## What's actually worth saving

Save when **all three** apply:

1. **Non-obvious from the code.** If `git log` or reading the file shows
   it, the memory is dead weight.
2. **Survives across sessions.** Today's in-progress task is not memory —
   it's a task list.
3. **Decision-shaping.** A future-you (or future-Claude) would behave
   differently knowing it.

Trigger words from the user that mean "save this":

- "remember that …"
- "next time, do X / don't do X"
- "this is how we always do it"
- "the reason is …"

Use the skill:

```bash
node .harness/scripts/project-memory.mjs remember \
  --type decision \
  --summary "Use SQLite only after the MVP ships." \
  --why "The current JSONL state is enough and easier to review."
```

## What's NOT worth saving

- Raw code patterns, file paths, architecture diagrams — re-read the code.
- Git history, "who changed X last week" — `git log` is authoritative.
- Today's debug recipe — the fix lives in the commit; the commit message
  has the context.
- A list of files you just edited — the diff has it.
- Anything documented in `CLAUDE.md` — it's already loaded.
- Credentials, API keys, customer data, or pasted secrets.

Reject the request even if the user explicitly asks. Bigger memory is
*not* better memory — every dead entry is noise the next session will
have to scan past.

## Working with what's there

- `SessionStart` reads the project memory summary and injects only the compact
  current state: phase, open risks, latest decision, and recent semantic events.
- `/remember-project` records durable decisions, risks, scope changes, and
  handoff notes.
- `/project-status` renders `.harness/project/status.html` so humans can scan
  project state, orchestration health, and session isolation without reading
  raw JSONL.
- `node .harness/scripts/project-memory.mjs export` writes a portable
  `.harness/project/handoff.json` for teammate handoff.
- If memory turns out wrong or stale, append a correcting decision or risk
  closure. Do not edit old ledger rows unless you are removing sensitive data.

## Privacy and scope

- Project memory lives under `.harness/` and can be versioned or handed off.
- The script redacts common token/key shapes, but the agent remains responsible
  for not storing secrets.
- Use `AHK_DISABLE_MEMORY=1` to disable memory writes for sensitive sessions.

## Related kit features

- `.harness/telemetry.jsonl` is raw observability for skills, provider calls,
  and sessions.
- `.harness/PROGRESS.md` is a human-readable session log.
- `.harness/memory/ledger.jsonl` is curated shared memory.
- `.harness/project/state.json` is the project-management state.

Memory != telemetry. Telemetry is raw evidence. Memory is curated knowledge that
changes what the next human or agent should do.
