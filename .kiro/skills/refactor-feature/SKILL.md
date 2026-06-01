---
name: refactor-feature
description: Use this skill when restructuring a feature in .harness/feature_list.json — splitting steps, merging steps, renaming, or marking a previously-failing step done. The side-car diffs .harness/feature_list.json#steps before/after and rejects the edit when a step.done transition is not accompanied by a test reference. Forces "no done without proof".
allowed-tools: Read, Edit, Bash(git diff:*, node .kiro/skills/refactor-feature/scripts/feature-diff.mjs:*)
suggested-turns: 6
isolation: worktree
---

## When to invoke

- Re-decomposing a feature (one becomes many, or vice versa).
- Marking `passes: false → true` for a step that was previously WIP.
- Renaming feature ids (this is the dangerous case — the side-car catches
  silent renames that orphan PROGRESS.md references).

## Pre-flight (side-car gate)

Run the diff side-car BEFORE any .harness/feature_list.json edit lands:

```
node .kiro/skills/refactor-feature/scripts/feature-diff.mjs \
  --before-ref HEAD --after-file .harness/feature_list.json
```

Side-car contract:
- Exits 0 + JSON when changes are coherent.
- Exits 2 + JSON with `violations: [...]` when:
  - A step's `passes` flipped `false → true` without a test entry under
    `step.tests` (or `step.testCommit`).
  - A step's `id` changed without a `renamed_from` field (silent rename).
  - A step disappeared without an entry in `step.replaced_by`.

## Steps

1. **Capture before-state.** `git show HEAD:.harness/feature_list.json > /tmp/before.json`
2. **Edit.** Make the refactor in your working copy.
3. **Run the gate.** Side-car compares HEAD vs working copy. Address any
   violation before staging.
4. **Stage + test.** If `passes` flipped true, the test must exist and be
   referenced in `step.tests`.
5. **Commit with a body explaining the refactor.** Use commit trailer
   `Refactor-Feature: <feature_id>` so /review-this-pr can group changes.

## Output contract

```
feature_list refactor: <id>
steps_changed: <N>
done_transitions: <M> (each with a test reference)
renames: <list of id→id>
gate: passed
```

## Anti-patterns

- Don't mark `passes: true` first and "add tests later" — the side-car
  blocks at the boundary on purpose. Flip the bit only AFTER the test
  exists.
- Don't delete a step without `replaced_by` — orphaned PROGRESS.md
  entries get out of sync with the live feature list.
