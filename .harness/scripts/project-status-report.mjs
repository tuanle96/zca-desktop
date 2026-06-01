#!/usr/bin/env node
// project-status-report.mjs - render the repo-local project state + memory
// ledger into a self-contained HTML dashboard.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectProjectStatus, renderProjectStatusHtml } from "./project-memory.mjs";

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      opts[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      opts[body] = next;
      i++;
    } else {
      opts[body] = true;
    }
  }
  return opts;
}

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

async function main(argv) {
  const opts = parseArgs(argv);
  const cwd = process.cwd();
  const out = resolve(cwd, opts.out || ".harness/project/status.html");
  const data = collectProjectStatus(cwd);
  const html = renderProjectStatusHtml(data);
  ensureDir(out);
  writeFileSync(out, html);

  let opened = false;
  if (opts.open && process.platform === "darwin" && process.env.CI !== "true") {
    try {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("open", [out], { stdio: "ignore" });
      opened = r.status === 0;
    } catch {
      opened = false;
    }
  }

  console.log(JSON.stringify({
    status: "created",
    out,
    opened,
    phase: data.state.currentPhase,
    features: data.features.length,
    memoryEvents: data.ledger.length,
    structuralBaselineStatus: data.harnessHealth?.structuralBaseline?.status,
    orchestrationStatus: data.harnessHealth?.orchestration?.status,
    sessionIsolationStatus: data.harnessHealth?.sessionIsolation?.status,
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
}
