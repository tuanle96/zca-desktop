#!/usr/bin/env node
import { composeMiddleware, withBudget, withCaching, withRetry, withTelemetry, withTimeout } from '../src/core/middleware/pipeline.mjs';
const events = [];
let calls = 0;
const base = async input => ({ text: input.prompt.toUpperCase(), calls: ++calls });
const run = composeMiddleware(base, [
  withTelemetry({ sink: e => events.push(e) }),
  withBudget({ maxInputTokens: 1000 }),
  withTimeout({ ms: 1000 }),
  withRetry({ attempts: 2 }),
  withCaching({ key: input => input.prompt }),
]);
const first = await run({ prompt: 'hello middleware' });
const second = await run({ prompt: 'hello middleware' });
console.log(JSON.stringify({ first, second, cached: first.calls === second.calls, events }, null, 2));
