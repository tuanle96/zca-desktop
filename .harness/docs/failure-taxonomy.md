# Failure taxonomy

Every recurring agent failure should become a durable harness change. Use
`.harness/failures/taxonomy.json` for the class list and write records under
`.harness/failures/records/<id>.json` using
`.harness/schemas/failure-record.schema.json`.

When telemetry or bypass logs exist, start with the deterministic improvement
bundle before hand-classifying the incident:
`.harness/scripts/improvement-bundle.mjs`. The bundle emits
`taxonomy_classification`, `suggested_records`, and `nextSteps`, which should
feed the failure record and promotion workflow.

Prefer `.harness/scripts/record-failure.mjs` over hand-writing JSON. It reads
the taxonomy, fills the default prevention target and a concrete
`proposedPrevention` template, writes the record, and runs
`.harness/scripts/check-failure-records.mjs`. Run the checker again before
promoting a failure record to `applied` or `verified`.
The recorder emits `nextSteps` in JSON output and concise text guidance for the
current promotion state: proposed records show the apply command template,
applied records show the verified-promotion template, and all states include
the checker/report commands to rerun before claiming the loop is closed.

Review decisions can enter the same loop without manual transcription. Run
`.harness/scripts/record-review-failures.mjs` after a review fanout to convert
`block` and `needs-human` artifacts in `.harness/reviews/` into proposed
records with `source=review` and evidence pointing at the original review JSON.
Pass review decisions are ignored; existing generated records are skipped unless
`--force` is used.
The recorder also emits `nextSteps` in JSON output and concise text guidance:
inspect the generated records, implement the prevention artifact, promote each
record with `record-failure.mjs --update`, then rerun the failure checker and
strict harness report.
The harness report also checks this linkage: unresolved actionable review
artifacts are counted as promoted when a review-sourced failure record points at
that artifact, and unpromoted blockers are surfaced as review promotion
attention. Release readiness runs the report with `--review-promotion=fail`, so
an actionable `block` or `needs-human` review must be recorded, promoted, or
resolved before the release gate passes. The JSON report includes
`promotion.repairCommands`, and readiness prints those commands when the report
gate fails so an agent has an explicit next action instead of only a red gate.
The package CLI wraps the same mechanics when the installed project can run
`npx agent-harness-kit`:

```bash
npx agent-harness-kit failure propose --from-review .harness/reviews/<task>/<reviewer>.json
npx agent-harness-kit failure promote <recordId> --verification-command "node .harness/scripts/check-failure-records.mjs"
npx agent-harness-kit failure verify <recordId>
```

## Loop

1. Observe a failure from trace, eval, hook, review, CI, or user report.
2. Classify exactly one primary class from the taxonomy.
3. Pick the smallest prevention target: docs, skill, hook, subagent/reviewer
   update, script, structural rule, eval task, permission policy, or project
   code.
   The taxonomy declares a `preferredPrevention` for each class; if a record
   uses a different `preventionTarget`, it must include
   `preventionJustification` explaining why the preferred target is not the
   right durable fix.
4. Create the record:

```bash
node .harness/scripts/record-failure.mjs \
  --class=false-done \
  --symptom="Agent marked a feature passes=true without test output." \
  --evidence=.harness/eval/results/latest.jsonl \
  --source=session-trace
```

Or ingest unresolved review decisions:

```bash
node .harness/scripts/record-review-failures.mjs
```

5. Apply the generated `proposedPrevention.path` artifact.
6. Verify with a deterministic command or eval.
7. Promote the record from `proposed` to `applied` or `verified`.

Local evidence paths must exist and stay inside the project root. When a record
is proposed, applied, or verified, `proposedPrevention.path`, `summary`, and
`verificationCommand` must be concrete. When promoted to `applied` or
`verified`, `proposedPrevention.path` must also be a repo-local artifact that
exists, and `proposedPrevention.verificationCommand` must name the deterministic
command or eval that will prove the prevention.
External URLs belong in `links`; they are not valid prevention artifact paths.
Verified records must also include `observedResult`; verification commands must
be concrete, not placeholders such as `TBD`, `TODO`, or `N/A`.
The prevention artifact path must also match the selected `preventionTarget`:
eval tasks belong under `.harness/eval/tasks` or `.harness/regression/tasks`,
skills under `.claude/skills` or `.agents/skills`, scripts under
`.harness/scripts`, permission policy fixes under `.harness/permissions.json`
or task contracts, and so on. Use `project-code` only when the prevention is a
real product-code fix rather than a harness rule.
Those path conventions live in
`.harness/scripts/_lib/failure-policy.mjs`; update that helper instead of
duplicating prevention-target matchers in new commands.
The taxonomy `recordSchemaPath` and `recordsDir`, plus any `--records-dir`
override passed to the recorder/checker, must also stay inside the project root
so the learning loop cannot read from or write to an unrelated checkout.
`check-failure-records.mjs` also rejects prevention target drift unless the
record explains it with `preventionJustification`. Proposed records are not a
backlog. When `maxProposedAgeDays` is set in `.harness/failures/taxonomy.json`
or `.harness/config.json`, the checker fails records that stay `proposed`
beyond that limit; promote them to `applied`/`verified`, reject them, or refresh
the observation with new evidence.

## Record Example

```json
{
  "schemaVersion": 1,
  "id": "20260527-false-done-no-evidence",
  "observedAt": "2026-05-27T00:00:00.000Z",
  "source": "session-trace",
  "primaryClass": "false-done",
  "symptom": "Agent marked a feature passes=true without test output.",
  "evidence": [".harness/eval/results/latest.jsonl"],
  "preventionTarget": "script",
  "proposedPrevention": {
    "path": ".harness/scripts/task-evidence-check.mjs",
    "summary": "Block passes=true changes without task/evidence proof.",
    "verificationCommand": "npm run check:task-evidence"
  },
  "promotionStatus": "verified",
  "observedResult": "Gate blocks the missing evidence case.",
  "links": []
}
```
