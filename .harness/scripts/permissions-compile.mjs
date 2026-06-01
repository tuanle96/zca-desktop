#!/usr/bin/env node
import { runPermissionsCompileCli } from "./_lib/permissions/compiler.mjs";

await runPermissionsCompileCli(process.argv.slice(2));
