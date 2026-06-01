#!/usr/bin/env node
import { runEvidenceCli } from "./_lib/evidence/attestation.mjs";

await runEvidenceCli(process.argv.slice(2));
