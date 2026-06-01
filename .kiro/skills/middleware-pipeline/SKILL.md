---
name: middleware-pipeline
description: Use composable middleware behaviors for provider/tool execution: retry, caching, timeout, telemetry, and budget guards.
allowed-tools: Read, Bash(node .harness/scripts/middleware-demo.mjs:*)
suggested-turns: 5
---

# Middleware Pipeline

Provides five composable behaviors via `src/core/middleware/pipeline.mjs`:

- `withRetry()`
- `withCaching()`
- `withTimeout()`
- `withTelemetry()`
- `withBudget()`

## Example

```js
const run = composeMiddleware(baseRun, [
  withTelemetry({ sink }),
  withBudget({ maxInputTokens: 100000 }),
  withTimeout({ ms: 30000 }),
  withRetry({ attempts: 2 }),
  withCaching(),
]);
```

## Smoke test

```bash
node .harness/scripts/middleware-demo.mjs
```
