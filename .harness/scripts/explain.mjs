#!/usr/bin/env node
import { runExplainCli } from "./_lib/explain/diagnostics.mjs";

await runExplainCli(process.argv.slice(2));
