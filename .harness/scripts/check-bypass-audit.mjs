#!/usr/bin/env node
import { resolve } from "node:path";
import { auditBypassRecords } from "./_lib/bypass-audit.mjs";
import { renderBypassAuditText } from "./bypass.mjs";

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    json: false,
    strict: false,
    logPath: ".harness/bypass.log",
    ackPath: ".harness/bypass-audit.json",
    requestsDir: ".harness/bypass-requests",
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--log=")) opts.logPath = arg.slice("--log=".length);
    else if (arg.startsWith("--ack=")) opts.ackPath = arg.slice("--ack=".length);
    else if (arg.startsWith("--requests-dir=")) opts.requestsDir = arg.slice("--requests-dir=".length);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const payload = auditBypassRecords(opts);

if (opts.json) console.log(JSON.stringify(payload, null, 2));
else if (payload.status === "passed") process.stdout.write(renderBypassAuditText(payload));
else process.stderr.write(renderBypassAuditText(payload));

process.exit(payload.status === "passed" ? 0 : 1);
