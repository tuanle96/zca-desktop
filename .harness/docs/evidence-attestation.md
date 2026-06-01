# Evidence Attestation

Passing evidence must be inspectable after the agent stops. For normal work this
means concrete commands and artifacts; for high-risk or strict release work it
also means command attestations with sidecar hashes.

## Capture Command Evidence

Use `evidence-run.mjs` when a command should become replayable evidence:

```bash
node .harness/scripts/evidence-run.mjs --task <taskId> --name tests --append -- npm test
```

The runner records command text, exit code, cwd, timestamps, git head, working
tree hash, stdout/stderr sidecar paths, stdout/stderr hashes, and artifact
paths under `.harness/evidence/<taskId>/checks/`.

## Verify Attestations

```bash
node .harness/scripts/task-evidence-check.mjs --strict --verify-hashes --replay-plan
node .harness/scripts/check-evidence-attestation.mjs --strict
```

`--verify-hashes` fails if a stdout/stderr sidecar no longer matches the hash in
the evidence bundle. `--replay-plan` emits concrete safe commands that can be
rerun. The attestation checker is wired into strict readiness and requires
passing evidence to carry complete command proof.

## UI Evidence

Passing UI checks must point at a repo-local `verify-ui` JSON summary. The
summary must be real browser evidence, include core checks, include at least one
screenshot path, identify the route, list assertions, and include a DOM snapshot
or summary hash. Screenshots must exist and valid PNG screenshots must have a
PNG signature.

Mock UI reports are useful for smoke-testing report generation only. They set
`evidenceKind: "mock"` and `evidenceUsable: false`, so they cannot satisfy
passing task evidence.
