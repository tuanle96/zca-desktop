#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAdversarialArgs,
  renderAdversarialSuiteText,
  runAdversarialSuite,
} from "./_lib/adversarial-suite.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const opts = parseAdversarialArgs(process.argv.slice(2), { scriptDir });
const payload = runAdversarialSuite(opts);

if (opts.json) console.log(JSON.stringify(payload, null, 2));
else process[payload.status === "passed" ? "stdout" : "stderr"].write(renderAdversarialSuiteText(payload));

process.exit(payload.status === "passed" ? 0 : 1);
