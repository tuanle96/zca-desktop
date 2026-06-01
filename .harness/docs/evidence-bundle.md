# Evidence bundles

An evidence bundle is the machine-readable proof that a task is done. It
connects the task contract to the exact commands, artifacts, changed files,
and reviewer decisions that justify changing `.harness/feature_list.json`
from `passes: false` to `passes: true`.

## Paths

- Task contracts: `.harness/task-contracts/<task_id>.json`
- Evidence bundles: `.harness/evidence/<task_id>.json`
- Review decisions: `.harness/reviews/<task_id>/<reviewer>.json`
- Task contract schema: `.harness/schemas/task-contract.schema.json`
- Evidence schema: `.harness/schemas/evidence-bundle.schema.json`
- Review decision schema: `.harness/schemas/review-decision.schema.json`

## Minimal Evidence Bundle

```json
{
  "schemaVersion": 1,
  "taskId": "feature.health-endpoint",
  "featureId": "health-endpoint",
  "status": "pass",
  "createdAt": "2026-05-27T00:00:00.000Z",
  "diffSummary": "Added the health endpoint runtime and service slice without changing unrelated routing.",
  "changedFiles": [
    "src/runtime/health.ts",
    "src/service/health.ts"
  ],
  "checks": [
    {
      "name": "structural",
      "command": "npm run harness:check",
      "status": "pass",
      "summary": "0 new violations"
    },
    {
      "name": "tests",
      "command": "npm test -- health",
      "acceptanceId": "health-response",
      "status": "pass",
      "summary": "targeted health endpoint tests passed"
    },
    {
      "name": "smoke",
      "command": "curl -i http://localhost:3000/health",
      "acceptanceId": "health-response",
      "status": "pass",
      "summary": "HTTP 200 with status ok"
    }
  ],
  "reviewers": [
    {
      "name": "architecture-reviewer",
      "decision": "not-required"
    }
  ],
  "knownRisks": []
}
```

## Rules

- Do not mark a feature `passes: true` without an evidence bundle for the
  same task or feature id.
- Evidence `taskId` and optional `featureId` must be stable lowercase ids.
- `updatedAt`, when present, must be an ISO date-time greater than or equal to
  `createdAt`.
- Passing evidence must include a concrete `diffSummary` that explains what
  changed and why the patch stayed within scope. Placeholders such as `TBD`,
  `TODO`, `N/A`, `fill me`, or `replace me` are rejected.
- Feature `storyPath`, `taskContractPath`, and `evidencePath`, plus task
  contract `evidencePath`, must be repo-local paths. The task contract
  directories in `.harness/config.json#taskContracts` must also stay inside the
  project root.
- The Stop hook runs `.harness/scripts/task-evidence-check.mjs` and blocks
  when the current diff changes a feature to `passes: true` without valid
  task/evidence proof.
- By default, `.harness/config.json#taskContracts.stopActiveEvidence` is
  `on-claim`: if the latest assistant message claims the active task is done,
  the Stop hook also requires passing evidence and a matching `passes: true`
  feature-list update. Set it to `always` for stricter unattended runs or
  `off` when using the checker only as a release/readiness gate.
- Prefer deterministic command output over prose. If a check is manual, point
  at an artifact such as a screenshot, log, trace, or captured response.
- Passing checks must carry concrete commands. Placeholders such as `TBD`,
  `TODO`, `N/A`, `fill me`, or `replace me` cannot be marked `status: "pass"`.
- Check names must be stable lowercase ids and unique within the evidence
  bundle. Use names such as `tests.unit` and `tests.e2e` when multiple checks
  belong to the same gate family.
- Passing checks must include a concrete `summary` of the result so the bundle
  records what the command proved, not only that a command string exists.
- Attested checks may include `exitCode`, `cwd`, `startedAt`, `finishedAt`,
  `gitHead`, `workingTreeHash`, `stdoutHash`, `stderrHash`, `stdoutPath`,
  `stderrPath`, and `artifactPaths`. Generate these with:
  `node .harness/scripts/evidence-run.mjs --task <task_id> -- npm test`.
- `node .harness/scripts/task-evidence-check.mjs --verify-hashes` verifies
  that stdout/stderr sidecar files still match their recorded hashes.
- `node .harness/scripts/task-evidence-check.mjs --replay-plan --json`
  returns the concrete proof commands that can be rerun. Replay-plan mode
  rejects placeholder or risky proof commands.
- In `--strict` mode, passing evidence for `riskTier: "high-risk"` task
  contracts must include attestation fields on each passing check.
- Evidence gates match check names/commands on token boundaries, not raw
  substrings. For example, `contest` does not satisfy the `tests` gate.
- If a passing check lists an `artifact`, repo-local artifact paths must exist
  and stay inside the project root. External artifact URLs are allowed and are
  not existence-checked locally.
- Every acceptance criterion in the task contract must use a stable lowercase
  id that is unique within the contract, define concrete verification before
  done, and be proven by the evidence bundle with a passing check that matches
  `verification.command` or `verification.artifact`. For manual-only
  verification, `acceptanceId` must reference a task-contract acceptance id and
  be paired with a concrete artifact such as a screenshot, log, trace, or
  captured response.
- Task contract `scope` must be structured (`summary`, optional `goals` and
  `nonGoals` arrays), `doneRequires` must not contain duplicate gates, and
  `acceptance[].verification` must be an object with string `command`,
  `artifact`, or `manual` fields.
- If the task contract declares `scope.allowedLayers`, every `changedFiles`
  entry under a configured source root must stay inside one of those layers.
  Docs and other files outside `.harness/config.json#domains` source roots are
  allowed, but unlayered files inside a source root are treated as scope drift.
- `changedFiles` must be unique after path normalization, so `src/x.ts` and
  `./src/x.ts` cannot both appear in the same evidence bundle.
- When a feature is newly changed to `passes: true`, `changedFiles` must also
  cover every current git-diff file under configured source roots plus
  important technical/config files such as package manifests, lockfiles,
  build/test configs, Docker files, CI workflows, runtime settings, and env
  samples. This makes the evidence bundle line up with the real patch instead
  of a hand-written subset.
- Harness proof artifacts such as `.harness/evidence/*`,
  `.harness/task-contracts/*`, `.harness/reviews/*`, `.harness/state/*`,
  `.harness/failures/records/*`, `.harness/feature_list.json`, and
  `.harness/PROGRESS.md` are excluded from current-diff coverage because they
  are the evidence trail itself. Docs and other non-source files outside
  configured roots are ignored.
- `changedFiles` and review `checkedFiles` must be repo-local paths. URLs and
  paths that resolve outside the project root are rejected.
- Local artifacts referenced by passing checks must exist, be readable, and be
  non-empty. If the artifact path ends in `.json`, it must parse as JSON.
- A reviewer decision is required when the task contract lists that reviewer
  in `requiredReviewers`.
- Evidence reviewer names must be stable lowercase ids and unique within the
  bundle. Review decision artifacts must be repo-local JSON paths.
- `requiredReviewers` and the `review` done gate are coupled: non-empty
  `requiredReviewers` requires `doneRequires` to include `review`, and a
  `review` done gate must name at least one required reviewer. This prevents
  empty review gates from passing by accident.
- Required reviewers must provide a structured review decision, either inline
  in `reviewDecision` or as a JSON artifact at `.harness/reviews/<task_id>/<reviewer>.json`.
- A `pass` review decision must list non-empty `checkedFiles`; for required
  reviewers, at least one checked file must overlap the evidence bundle's
  `changedFiles`. This prevents a reviewer pass from becoming detached prose.
- A `pass` review decision must also include non-empty `checkedInvariants`,
  `diffCoverage`, numeric `confidence`, empty `unreviewedRiskAreas`, and
  `resolvedFindings` when prior blocking findings were rechecked. The
  dedicated review coverage gate validates these fields against task scope,
  changed files, required reviewers, and risk areas.
- Across all required reviewer `pass` decisions, `checkedFiles` must cover
  every evidence `changedFiles` entry under configured source roots plus
  important technical/config files such as package manifests, lockfiles,
  build/test configs, Docker files, CI workflows, runtime settings, and env
  samples. Harness proof artifacts and docs outside source roots remain
  excluded.
- A required reviewer `pass` decision must include `taskId` matching the task
  contract id and `featureId` matching the evidence feature id. If either id
  is unknown, the reviewer decision should be `needs-human` rather than
  `pass`.
- When `.harness/config.json#domains` defines source roots, the combined
  `checkedFiles` from required passing reviewers must cover every changed file
  under those source roots. Review coverage can be split across reviewers.
- All JSON review artifacts under `.harness/reviews/` must match
  `.harness/schemas/review-decision.schema.json`; the evidence checker validates
  them even before an evidence bundle references them.
- `harness-report.mjs` summarizes `.harness/reviews/**.json` as review decision
  health, including pass proof gaps, unresolved `block` or `needs-human`
  decisions, placeholder findings, unsafe paths, and whether actionable review
  blockers have been promoted into review-sourced failure records. Use
  `--fail-on=fail --review-promotion=fail` in release automation when
  malformed review decisions or unpromoted actionable blockers should block the
  run. The report emits `promotion.repairCommands`; run the recorder command to
  turn unresolved blockers into failure records, then rerun the failure-record
  checker.
- A `pass` review decision cannot include any finding with `blocking: true`.
- A `block` review decision must include at least one finding and at least one
  finding with `blocking: true`. A `needs-human` review decision must include
  at least one finding explaining what proof, artifact, or human decision is
  missing.
- Review decision `summary`, finding `evidence`, and finding `fix` must be
  concrete, not placeholders such as `TBD`, `TODO`, `N/A`, `fill me`, or
  `replace me`. Finding `file` paths, when present, must be repo-local.
- If a reviewer lists `requiredGates`, each gate must be one of `structural`,
  `lint`, `tests`, `smoke`, or `ui`, and the evidence bundle must include
  matching passing checks.
- Passing `ui` evidence must come from real browser validation. `verify-ui
  --mock` is report-generation smoke only and is rejected as done proof.
- A passing `ui` check must include an `artifact`. When the command uses
  `verify-ui.mjs`, the artifact must be a repo-local JSON summary with
  `passed: true`, `evidenceKind: "browser"`, `evidenceUsable: true`, and at
  least one repo-local screenshot path that exists. Its `checks` array must
  include passing `page-load`, `screenshot`, `console-errors`, and
  `network-failures` entries. Screenshot files must be non-empty; `.png`
  screenshots must have a PNG signature.
- A `partial` or `blocked` evidence bundle is useful for handoff, but it is
  not proof of done.
- `knownRisks` is not a scratchpad. Each entry must be a structured object
  with `id`, `severity`, `description`, `disposition`, and `owner`.
- Passing evidence cannot contain `knownRisks` with `disposition: "open"`.
  Remaining risks must be either `mitigated` with a concrete `mitigation`, or
  `accepted` with `acceptedBy`, `acceptanceReason`, and `mitigation`.
- Accepted `critical` or `high` risks must include `acceptedUntil` so the
  acceptance has an expiry instead of becoming permanent hidden debt.
- Any accepted risk with `acceptedUntil` in the past is treated as expired and
  is not valid passing evidence.

## Required Reviewer Example

```json
{
  "name": "architecture-reviewer",
  "decision": "pass",
  "artifact": ".harness/reviews/feature.health-endpoint/architecture-reviewer.json"
}
```

## Known Risk Example

```json
{
  "id": "manual-rollout",
  "severity": "medium",
  "description": "The first rollout still needs an operator to watch dashboard metrics.",
  "disposition": "accepted",
  "owner": "release-owner",
  "acceptedBy": "product-owner",
  "acceptanceReason": "The change is behind a feature flag and MVP accepts a watched rollout.",
  "mitigation": "Rollback is the feature flag disable command captured in the release runbook."
}
```

The referenced JSON artifact must match `.harness/schemas/review-decision.schema.json`:

```json
{
  "schemaVersion": 1,
  "reviewer": "architecture-reviewer",
  "taskId": "feature.health-endpoint",
  "featureId": "health-endpoint",
  "decision": "pass",
  "createdAt": "2026-05-27T00:00:00.000Z",
  "checkedFiles": ["src/runtime/health.ts"],
  "checkedInvariants": ["layering"],
  "diffCoverage": {
    "changedFiles": ["src/runtime/health.ts"],
    "reviewedFiles": ["src/runtime/health.ts"],
    "uncoveredFiles": [],
    "coverage": 1
  },
  "confidence": 0.9,
  "unreviewedRiskAreas": [],
  "resolvedFindings": [],
  "requiredGates": ["structural"],
  "findings": [],
  "summary": "Layering review passed for the changed files."
}
```
