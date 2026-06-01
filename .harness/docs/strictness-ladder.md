# Strictness Ladder

The harness has five adoption tiers:

| Tier | Use when | Readiness behavior |
| --- | --- | --- |
| `starter` | New solo project | Warn-first gates for low-friction adoption. |
| `standard` | Active solo project | Task evidence, review coverage, structure, and permission drift are enforced. |
| `strict` | Serious repo | Adds high-risk isolation, policy packs, operational state, bypass review, and release report gates. |
| `release` | Package or production release | Adds evals, adversarial probes, trace corpus, failure records, orchestration contracts, and runtime parity as release gates. |
| `team` | Multi-developer repo | Requires the release surface plus team governance signals such as policy packs, state, model routing, and PR annotations. |

Change tier without hand-editing readiness gates:

```bash
node .harness/scripts/strictness.mjs show
node .harness/scripts/strictness.mjs plan --tier=strict
node .harness/scripts/strictness.mjs set strict
node .harness/scripts/harness-readiness.mjs --list
```

`readiness.compileFromStrictness: true` tells the readiness runner to compile
the effective gate list from `strictness.tier`. Unknown repo-local gates stay
additive so project policy checks are not dropped by a tier change. Existing
repos can keep the raw `readiness.gates` list by leaving
`compileFromStrictness` unset or false.
