#!/usr/bin/env node
import { runHarnessNoiseCli } from "./_lib/harness-noise.mjs";

await runHarnessNoiseCli(process.argv.slice(2));
