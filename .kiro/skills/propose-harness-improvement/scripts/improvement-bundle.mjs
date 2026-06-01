#!/usr/bin/env node
// Compatibility wrapper. New installs should call
// `.harness/scripts/improvement-bundle.mjs` directly; this sidecar delegates to
// that canonical harness script so the skill path does not become a second
// source of truth.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const candidates = [
  resolve(root, ".harness/scripts/improvement-bundle.mjs"),
  resolve(here, "../../../../scripts/improvement-bundle.mjs"),
];

for (const candidate of candidates) {
  if (!existsSync(candidate)) continue;
  await import(pathToFileURL(candidate).href);
  process.exit(0);
}

console.error("improvement-bundle: .harness/scripts/improvement-bundle.mjs not found");
process.exit(1);
