#!/usr/bin/env node
// Structural-test entry point wired to `npm run harness:check`.
//
// Engine-aware by design (see ADR-0003 + .kiro/steering/harness.md):
// structural enforcement stays disabled while
// `.harness/config.json#structuralTest.engine` is "none" — i.e. until real
// Rust source exists under the ADR-0003 layers and the Rust adapter runner is
// dropped at .harness/runners/. While disabled this command is a clean no-op
// (exit 0) so the readiness `structural` gate passes truthfully instead of
// failing on a missing script. Once an engine is selected, it delegates to the
// matching runner and becomes mechanically enforced. Extra args (e.g.
// `-- --file path`) are forwarded to the runner so the PostToolUse edit hook
// keeps working unchanged.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const forwarded = process.argv.slice(2);

function readEngine() {
  const path = resolve(ROOT, ".harness/config.json");
  if (!existsSync(path)) return { engine: "none", missingConfig: true };
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    const engine = cfg?.structuralTest?.engine;
    return { engine: typeof engine === "string" ? engine : "none" };
  } catch (error) {
    return { engine: "none", error: `invalid .harness/config.json (${error.message})` };
  }
}

const RUNNERS = {
  ts: { cmd: "node", args: [".harness/runners/structural-check.mjs"] },
  node: { cmd: "node", args: [".harness/runners/structural-check.mjs"] },
  py: { cmd: "python", args: [".harness/runners/structural_test.py"] },
  go: { cmd: "go", args: ["run", ".harness/runners/structural_check.go"] },
};

const { engine, error } = readEngine();
if (error) {
  console.error(`harness:check: ${error}`);
  process.exit(1);
}

if (!engine || engine === "none") {
  console.log("harness:check: structural test disabled (structuralTest.engine=none) — no-op pass until the adapter is wired (see ADR-0003).");
  process.exit(0);
}

const runner = RUNNERS[engine];
if (!runner) {
  console.error(`harness:check: unknown structuralTest.engine "${engine}" — expected one of: ${Object.keys(RUNNERS).join(", ")}, none.`);
  process.exit(1);
}

const entry = runner.args.find((a) => a.startsWith(".harness/runners/"));
if (entry && !existsSync(resolve(ROOT, entry))) {
  console.error(`harness:check: structuralTest.engine="${engine}" but runner ${entry} is missing — wire the adapter or set engine=none.`);
  process.exit(1);
}

const result = spawnSync(runner.cmd, [...runner.args, ...forwarded], {
  cwd: ROOT,
  stdio: "inherit",
});
if (result.error) {
  console.error(`harness:check: failed to launch ${runner.cmd} (${result.error.message})`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
