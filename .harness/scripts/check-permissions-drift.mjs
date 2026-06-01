#!/usr/bin/env node
import { runPermissionsCompileCli } from "./_lib/permissions/compiler.mjs";

await runPermissionsCompileCli(["diff", ...process.argv.slice(2)]);
