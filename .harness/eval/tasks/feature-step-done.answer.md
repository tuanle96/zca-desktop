# Golden answer: feature-step-done

This file is read by `feature-step-done.mjs` rubric as a reference for
what an acceptable agent run looks like. The rubric does not require
byte-exact match — it checks structural properties (file count, JSON
shape) rather than identical content.

## Files expected in the agent's diff (representative)

- `src/runtime/health.ts` (or equivalent path for the project's stack)
- `tests/health.test.ts` (or equivalent test path)
- `.harness/feature_list.json` (modified in place)
- `.harness/PROGRESS.md` (appended)

## .harness/feature_list.json shape after the agent's edit

```json
{
  "features": [
    {
      "id": "health-endpoint",
      "title": "GET /health returns 200",
      "passes": true,
      "steps": [
        {
          "id": "s1",
          "passes": true,
          "tests": ["tests/health.test.ts"]
        }
      ]
    }
  ]
}
```

Key invariants the rubric checks:

1. `features[0].steps[0].passes === true`
2. `features[0].steps[0].tests` is a non-empty array
3. At least one path in `tests` exists in the agent's file diff
4. `features.length` is unchanged from setup (no new features mid-session)

## Transcript shape expected

The transcript should include:

- A call to `/add-feature` (or equivalent) early in the run.
- At least one Write/Edit on the handler file.
- At least one Write/Edit on a test file matching the `tests[]` array.
- An Edit on `.harness/feature_list.json` flipping `passes: true`.

The rubric does not require exact tool-call order — only that all four
events appear in the transcript.
