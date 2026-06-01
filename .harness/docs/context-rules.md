# Context Rules

Context is selected by task phase and risk lane. The goal is not to read more;
it is to put the right source of truth in context before the agent changes
state.

## Intake

| Source | Tiny | Normal | High-risk |
| --- | --- | --- | --- |
| `CLAUDE.md` or `AGENTS.md` | Must | Must | Must |
| `.harness/feature_list.json` | Must | Must | Must |
| `.harness/docs/templates/feature-intake-flow.md` | Must | Must | Must |
| `.harness/scripts/harness-state.mjs query matrix` | Should | Must | Must |
| `.harness/docs/architecture.md` | Skip | Should | Must |
| Relevant `.harness/docs/stories/*` | Skip if unrelated | Must if present | Must |
| Relevant `.harness/docs/adr/*` | Skip | Should for architecture/API changes | Must |

## Planning

| Source | Tiny | Normal | High-risk |
| --- | --- | --- | --- |
| Files to edit | Must | Must | Must |
| Adjacent files with same pattern | Should | Must | Must |
| `.harness/task-contracts/<id>.json` | Must | Must | Must |
| `.harness/docs/evidence-bundle.md` | Should | Must | Must |
| `.harness/docs/permission-model.md` | Skip | Should for task permissions | Must |
| `.harness/docs/operational-state.md` | Skip | Should | Must for state/process changes |

## Implementation

| Source | Tiny | Normal | High-risk |
| --- | --- | --- | --- |
| Files being changed | Must | Must | Must |
| Product docs or accepted story | Skip if copy-only | Must if behavior changes | Must |
| Structural config and architecture docs | Skip | Should | Must |
| Provider/API/security docs | Skip | Should if touched | Must |
| Historical traces | Skip | Skip unless friction repeats | Should when failure attribution matters |

## Validation

| Source | Tiny | Normal | High-risk |
| --- | --- | --- | --- |
| Task acceptance criteria | Should | Must | Must |
| Evidence bundle | Must | Must | Must |
| Validation command docs | Should | Must | Must |
| Reviewer artifacts | Skip unless required | Should if required | Must |
| `.harness/scripts/harness-state.mjs trace-quality --strict` | Should | Must | Must |

## Trace

| Source | Tiny | Normal | High-risk |
| --- | --- | --- | --- |
| `git status --short` | Must | Must | Must |
| Validation output | Should | Must | Must |
| `.harness/docs/trace-quality.md` | Should | Must | Must |
| `.harness/scripts/harness-state.mjs query friction` | Skip | Should if friction occurred | Must if friction/failure occurred |

## Retrieval Triggers

| Trigger | Action |
| --- | --- |
| Task changes public API, auth, authorization, data, audit, or external provider behavior | Treat as high-risk unless the user explicitly narrows scope. Read ADRs, story, permissions, and reviewer requirements before editing. |
| Task changes harness policy, risk classification, validation requirements, or source-of-truth hierarchy | Read operational-state, trace-quality, context-rules, architecture, and ADR docs. Pause if direction is ambiguous. |
| Task changes SQLite state, traces, or operational records | Read `.harness/docs/operational-state.md`, `.harness/state/schema.sql`, and the current query output first. |
| Task discovers repeated confusion, stale docs, missing proof, or recurring manual steps | Record `harness_friction` and add a backlog item when the fix is out of scope. |
| Final response is being prepared | Re-check validation evidence, changed files, and trace quality before claiming completion. |

## Budget Guidance

| Lane | Target Harness Context | Shape |
| --- | --- | --- |
| Tiny | About 2K tokens | Entrypoint, intake rule, exact files, proof path. |
| Normal | About 5K tokens | Intake, task contract, relevant story/docs, validation, trace rule. |
| High-risk | About 10K tokens | Full source hierarchy, ADRs, permissions, reviewers, validation, trace/friction rules. |

Use targeted `rg` searches before bulk reading. Stop reading unrelated history
once the lane, affected files, and proof path are clear.
