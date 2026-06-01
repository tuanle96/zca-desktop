# Trace Quality

Every task trace should be useful to the next agent. Trace quality is scored by
`.harness/scripts/harness-state.mjs trace-quality`.

## Tiers

| Score | Tier | Minimum fields |
| --- | --- | --- |
| 1 | Minimal | `task_summary` with at least 10 characters and `outcome`. |
| 2 | Standard | Minimal plus `agent`, `actions_taken`, `files_read`, `files_changed`, and either `errors` or `harness_friction`. |
| 3 | Detailed | Standard plus `decisions_made`, `errors`, `harness_friction`, and either `duration_seconds` or `token_estimate`. |

## Lane Requirements

| Lane | Required tier |
| --- | --- |
| Tiny | Minimal |
| Normal | Standard |
| High-risk | Detailed |

## Friction

Populate `harness_friction` when:

- A rule or source of truth was missing.
- Validation was unclear, unavailable, or too expensive.
- Docs, task contracts, durable state, or story packets contradicted each other.
- The task revealed repeated manual work that should become a script, template,
  hook, or checklist.
- A failure could not be attributed to a harness component.

Good friction is concrete:

```text
No story mapped this API behavior to proof, so I created the task contract and
recorded the missing validation command as backlog item #12.
```

Weak friction is vague:

```text
docs confusing
```

## Commands

```bash
node .harness/scripts/harness-state.mjs trace \
  --summary="Completed export API validation" \
  --outcome=completed \
  --lane=normal \
  --agent=codex \
  --actions="read task contract,patched service,ran unit test" \
  --read=".harness/task-contracts/export-api.json,src/export.ts" \
  --changed="src/export.ts,tests/export.test.ts" \
  --errors=none \
  --friction=none

node .harness/scripts/harness-state.mjs trace-quality --strict
node .harness/scripts/harness-state.mjs query friction
```
