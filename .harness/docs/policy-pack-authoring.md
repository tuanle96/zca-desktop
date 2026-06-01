# Policy Pack Authoring

Policy packs package stack-specific governance defaults so projects can adopt
useful rules without hand-copying local harness configuration.

## Layout

```text
.harness/policy-packs/<pack-id>/
  pack.json
  fitness-rules/
    <rule-id>.json
```

Third-party packs can live outside `.harness` and be validated with
`--packs-dir`, but every referenced file must stay inside that pack directory.
Symlinks, scripts, unsupported file types, and unreferenced rule files are
blocked by the validator and publish planner.

## Manifest

`pack.json` must match `.harness/schemas/policy-pack.schema.json` and include:

- `stacks`: language/framework targets the pack is meant for.
- `strictnessDefault`: the default adoption tier.
- `structuralRules`: generic structural rule ids the pack relies on.
- `fitnessRules`: repo-local JSON rule files and their owner reviewers.
- `taskContractDefaults`: allowed layers, done gates, and risk routing.
- `reviewerDefaults`: required and conditional reviewers.
- `evidenceRequirements`: proof expected when matching files change.
- `evalTemplates`: deterministic eval ideas the project can instantiate.
- `verifyUiFlows`: UI routes/assertions for smoke proof.
- `antiPatterns`: common failures plus concrete fixes.

## Fitness Rules

Each `fitnessRules[].path` points to an architecture fitness rule. Rules should
ship at least one passing and one failing example. The checker validates
examples before scanning a project, which prevents toothless rules from being
published.

Useful rule kinds:

- `forbid-pattern`: block raw text or API usage in matching files.
- `forbid-import`: block direct imports across a boundary.
- `require-pattern`: when a trigger is present, require a validation or adapter
  pattern nearby.

## Validation

Run these before committing a pack:

```bash
node .harness/scripts/check-policy-packs.mjs --pack=<pack-id>
node .harness/scripts/check-architecture-fitness.mjs --rules-dir=.harness/policy-packs/<pack-id>/fitness-rules --examples-only
node .harness/scripts/policy-pack-publish.mjs --pack=<pack-id> --dry-run
```

`pack publish --dry-run` emits a bounded plan with SHA-256 hashes. Real upload
is intentionally not implemented; the dry-run artifact is the review surface.
