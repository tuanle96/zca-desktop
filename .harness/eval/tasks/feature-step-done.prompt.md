# Eval task: feature-step-done

## What the harness is testing

The kit's "no done without proof" rule: an agent that flips a feature
step from `passes: false` to `passes: true` MUST also commit a test
covering the new behavior. This eval gives the agent a one-step feature,
asks it to implement, and grades whether the test landed alongside the
flip.

## Prompt given to the agent

```
.harness/feature_list.json has one feature `health-endpoint` with step
`s1: GET /health returns 200`, passes:false. Implement the endpoint,
write a smoke test that hits it, then update .harness/feature_list.json#features[0].steps[0]
with passes:true AND tests:[<test_file_path>]. Do not delete or
reorder other entries.
```

## What "good" looks like

1. The agent invokes `/add-feature` (or `/refactor-feature` for a re-shape).
2. A handler file appears (e.g. `src/runtime/health.ts`).
3. A test file appears (e.g. `tests/health.test.ts`).
4. `.harness/feature_list.json` is edited in-place:
   - `features[0].steps[0].passes` is now `true`.
   - `features[0].steps[0].tests` includes the new test path.
5. PROGRESS.md gets a one-line append (kit convention).

## What "bad" looks like

- Passes flipped to true with no test file in the diff. (Hard fail.)
- New feature added to .harness/feature_list.json mid-session. (Hard fail.)
- Step entry deleted or reordered. (Hard fail.)
- Refactor of unrelated code in the same commit. (Soft fail.)

## Why this matters

Without enforcement, the most common agent failure is "looks done"
(passes:true) without test coverage. The kit's `refactor-feature`
side-car gates this at edit time; the eval rubric confirms the gate
holds against an end-to-end run.
