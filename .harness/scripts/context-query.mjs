#!/usr/bin/env node
import { runContextQueryCli } from "./_lib/context-query.mjs";

await runContextQueryCli(process.argv.slice(2));
