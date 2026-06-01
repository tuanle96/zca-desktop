# Architecture Fitness Rules

Architecture fitness rules are deterministic JSON plugins loaded from
`.harness/fitness/rules/*.json` by:

```bash
node .harness/scripts/check-architecture-fitness.mjs --strict
```

Use them for local domain invariants that are too specific for generic layer
checks, such as "no DB client in UI", "all request bodies are validated", or
"external providers go through adapters".

## Rule Shape

```json
{
  "schemaVersion": 1,
  "id": "no-raw-env-outside-config",
  "description": "Environment reads must stay behind config/env modules.",
  "kind": "forbid-pattern",
  "severity": "block",
  "owner": "architecture-reviewer",
  "failureClass": "architecture-drift",
  "prevention": "structural-rule",
  "strictnessTier": "normal",
  "appliesTo": ["src/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
  "allowPaths": ["src/config/**"],
  "forbiddenPatterns": [
    {
      "regex": "\\bprocess\\.env\\b",
      "message": "Raw process.env access belongs in config."
    }
  ],
  "examples": {
    "pass": [{ "path": "src/config/env.ts", "content": "process.env.API_URL" }],
    "fail": [{ "path": "src/service/payments.ts", "content": "process.env.API_URL" }]
  }
}
```

Supported `kind` values:

- `forbid-pattern`: block regex matches in matching files.
- `forbid-import`: block imports/requires whose specifier matches
  `forbiddenImports[].specifierRegex`.
- `require-pattern`: when any `triggerPatterns[]` match a file, require at
  least one `requiredPatterns[]` match.

Every rule should include at least one pass and one fail example. The checker
validates examples before scanning project files, so broken or toothless rules
fail fast.

## Output Contract

Failures name the exact file, line, owner reviewer, failure taxonomy class, and
prevention category:

```text
src/service/payments.ts:1 [block no-raw-env-outside-config -> architecture-reviewer] Raw process.env access belongs in config. (failure=architecture-drift, prevention=structural-rule)
```

That output is intentionally usable by humans, review subagents, failure
records, and readiness summaries.
