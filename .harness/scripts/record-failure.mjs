#!/usr/bin/env node
// record-failure.mjs - write a machine-checkable failure-to-rule record.
//
// This is the deterministic companion to /propose-harness-improvement. It
// turns an observed agent failure into .harness/failures/records/<id>.json and
// immediately runs the record checker so the learning loop has a hard gate.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validateProofCommand } from "./_lib/command-policy.mjs";
import {
  FAILURE_SOURCES as SOURCES,
  PREVENTION_TARGETS,
  PROMOTION_STATUSES,
  hasUrlScheme,
  insideRoot,
  preventionTemplateFor,
  preventionTargetPathAllowed,
} from "./_lib/failure-policy.mjs";

function usage() {
  return `Usage:
  node .harness/scripts/record-failure.mjs \\
    --class=false-done \\
    --symptom="Agent marked a feature done without evidence" \\
    --evidence=.harness/eval/results/latest.jsonl

Options:
	  --cwd=<path>                     Project root (default: current directory)
	  --id=<id>                        Stable record id; generated when omitted
	  --update=<id>                    Update/promote an existing record instead of creating a new one
	  --class=<taxonomy-id>            Required primary taxonomy class
	  --source=<source>                eval|hook|review|user-report|session-trace|ci|runtime
	  --symptom=<text>                 Required failure symptom
  --evidence=<path>                Required; repeat for multiple evidence paths
  --prevention-target=<target>     Defaults to taxonomy preferredPrevention
  --prevention-justification=<txt> Required when target differs from taxonomy preferredPrevention
  --prevention-path=<path>         Proposed prevention artifact path
  --prevention-summary=<text>      Proposed prevention summary
  --verification-command=<cmd>     Required when --status=applied|verified
  --status=<status>                proposed|applied|verified|rejected (default: proposed)
  --observed-result=<text>         Required when --status=verified
  --link=<url-or-path>             Optional; repeat for multiple links
  --taxonomy=<path>                Override taxonomy path
  --records-dir=<path>             Override records directory
  --checker=<path>                 Override checker path
  --no-check                       Write without running the checker
  --force                          Overwrite an existing explicit --id file
  --json                           Print JSON output
  --dry-run                        Print the record without writing it
  --help                           Show this help
`;
}

function parseArgs(argv) {
  const opts = {
	    cwd: process.cwd(),
	    id: null,
	    updateId: null,
	    primaryClass: null,
	    source: null,
	    symptom: null,
	    observedAt: null,
	    evidence: [],
	    preventionTarget: null,
    preventionJustification: null,
    preventionPath: null,
    preventionSummary: null,
    verificationCommand: null,
    status: "proposed",
    observedResult: null,
    links: [],
    taxonomy: null,
    recordsDir: null,
    checker: null,
    check: true,
    force: false,
    json: false,
    dryRun: false,
    help: false,
  };

  const aliases = {
	    "primary-class": "primaryClass",
	    "failure-class": "primaryClass",
	    class: "primaryClass",
	    update: "updateId",
	    "observed-at": "observedAt",
    "prevention-target": "preventionTarget",
    "prevention-justification": "preventionJustification",
    "prevention-path": "preventionPath",
    "prevention-summary": "preventionSummary",
    "verification-command": "verificationCommand",
    "observed-result": "observedResult",
    "records-dir": "recordsDir",
    status: "status",
    evidence: "evidence",
    link: "links",
  };
  const booleans = new Set(["json", "dry-run", "force", "no-check", "help"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument "${arg}"`);
    }
    const raw = arg.slice(2);
    let key;
    let value;
    if (raw.includes("=")) {
      const idx = raw.indexOf("=");
      key = raw.slice(0, idx);
      value = raw.slice(idx + 1);
    } else {
      key = raw;
      if (booleans.has(key)) value = true;
      else value = argv[++i];
    }
    if (value === undefined) throw new Error(`--${key} requires a value`);
    if (key === "help") opts.help = true;
    else if (key === "json") opts.json = true;
    else if (key === "dry-run") opts.dryRun = true;
    else if (key === "force") opts.force = true;
    else if (key === "no-check") opts.check = false;
    else {
      const normalized = aliases[key] || key;
      if (normalized === "evidence" || normalized === "links") {
        opts[normalized].push(...String(value).split(",").map((item) => item.trim()).filter(Boolean));
      } else if (Object.hasOwn(opts, normalized)) {
        opts[normalized] = value;
      } else {
        throw new Error(`unknown option --${key}`);
      }
    }
  }
  opts.cwd = resolve(opts.cwd);
  return opts;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function readConfig(root) {
  for (const rel of [".harness/config.json", "harness.config.json"]) {
    const cfg = readJsonIfExists(resolve(root, rel));
    if (cfg) return cfg;
  }
  return {};
}

function rel(root, path) {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}

function validateRepoLocalPath(root, value, label, errors, { mustExist = false, allowUrl = false } = {}) {
  const text = String(value || "").trim();
  if (!text) {
    errors.push(`${label} must be a non-empty repo-local path`);
    return null;
  }
  if (hasUrlScheme(text)) {
    if (allowUrl) return text;
    errors.push(`${label} must be a repo-local path, not a URL`);
    return null;
  }
  const abs = resolve(root, text);
  if (!insideRoot(root, abs)) {
    errors.push(`${label} must stay inside the project root`);
    return null;
  }
  if (mustExist && !existsSync(abs)) {
    errors.push(`${label} not found: ${text}`);
    return null;
  }
  return abs;
}

function stableId(value) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(String(value || ""));
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "") || "failure";
}

function generatedId({ primaryClass, symptom }, recordsDir) {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const base = `${stamp}-${primaryClass}-${slugify(symptom)}`;
  let candidate = base;
  let idx = 2;
  while (existsSync(join(recordsDir, `${candidate}.json`))) {
    candidate = `${base}-${idx}`;
    idx += 1;
  }
  return candidate;
}

function validateInputs(opts, classMap, root) {
  const errors = [];
  if (opts.updateId && !stableId(opts.updateId)) errors.push("--update must match ^[a-z0-9][a-z0-9._-]*$");
  if (!opts.primaryClass) errors.push("--class is required");
  else if (!classMap.has(opts.primaryClass)) {
    errors.push(`--class must be one of ${[...classMap.keys()].sort().join(", ")}`);
  }
  if (opts.id && !stableId(opts.id)) errors.push("--id must match ^[a-z0-9][a-z0-9._-]*$");
  if (opts.source && !SOURCES.has(opts.source)) errors.push(`--source must be one of ${[...SOURCES].join(", ")}`);
  if (!opts.symptom) errors.push("--symptom is required");
  if (!Array.isArray(opts.evidence) || opts.evidence.length === 0) errors.push("--evidence is required");
  for (const [idx, evidencePath] of opts.evidence.entries()) {
    validateRepoLocalPath(root, evidencePath, `--evidence[${idx}]`, errors, {
      mustExist: true,
      allowUrl: true,
    });
  }
  if (opts.preventionTarget && !PREVENTION_TARGETS.has(opts.preventionTarget)) {
    errors.push(`--prevention-target must be one of ${[...PREVENTION_TARGETS].join(", ")}`);
  }
  const preferredPrevention = classMap.get(opts.primaryClass)?.preferredPrevention;
  if (opts.preventionTarget && preferredPrevention && opts.preventionTarget !== preferredPrevention && !opts.preventionJustification) {
    errors.push(`--prevention-justification is required when --prevention-target differs from taxonomy preferredPrevention "${preferredPrevention}"`);
  }
  if (!PROMOTION_STATUSES.has(opts.status)) {
    errors.push("--status must be proposed, applied, verified, or rejected");
  }
  if (
    (opts.preventionPath || opts.preventionSummary || opts.verificationCommand) &&
    (!opts.preventionPath || !opts.preventionSummary)
  ) {
    errors.push("--prevention-path and --prevention-summary are required when any proposed prevention field is provided");
  }
  if ((opts.status === "applied" || opts.status === "verified") && (!opts.preventionPath || !opts.preventionSummary)) {
    errors.push("--prevention-path and --prevention-summary are required when status is applied or verified");
  }
  if (opts.preventionPath) {
    validateRepoLocalPath(root, opts.preventionPath, "--prevention-path", errors, {
      mustExist: opts.status === "applied" || opts.status === "verified",
    });
    const preventionTarget = opts.preventionTarget || preferredPrevention;
    if (preventionTarget && !preventionTargetPathAllowed(root, preventionTarget, opts.preventionPath)) {
      errors.push(`--prevention-path does not match prevention target "${preventionTarget}"`);
    }
  }
  if ((opts.status === "applied" || opts.status === "verified") && !opts.verificationCommand) {
    errors.push(`--verification-command is required when status is ${opts.status}`);
  } else if (opts.status === "applied" || opts.status === "verified") {
    errors.push(...validateProofCommand(opts.verificationCommand, {
      prefix: "--verification-command",
      context: "failure prevention verification",
    }));
  }
  if (opts.status === "verified" && !opts.observedResult) {
    errors.push("--observed-result is required when status is verified");
  }
  return errors;
}

function mergeExistingRecordOptions(opts, existing, classMap) {
  if (!existing) return { ...opts, status: opts.status || "proposed", source: opts.source || "user-report" };
  const primaryClass = opts.primaryClass || existing.primaryClass;
  const existingPrevention = existing.proposedPrevention || {};
  const mergedLinks = opts.links.length > 0
    ? [...new Set([...(Array.isArray(existing.links) ? existing.links : []), ...opts.links])]
    : (Array.isArray(existing.links) ? existing.links : []);
  return {
    ...opts,
    id: existing.id,
    primaryClass,
    source: opts.source || existing.source || "user-report",
    symptom: opts.symptom || existing.symptom,
    observedAt: opts.observedAt || existing.observedAt,
    evidence: opts.evidence.length > 0 ? opts.evidence : (Array.isArray(existing.evidence) ? existing.evidence : []),
    preventionTarget: opts.preventionTarget || existing.preventionTarget || classMap.get(primaryClass)?.preferredPrevention || null,
    preventionJustification: opts.preventionJustification || existing.preventionJustification || null,
    preventionPath: opts.preventionPath || existingPrevention.path || null,
    preventionSummary: opts.preventionSummary || existingPrevention.summary || null,
    verificationCommand: opts.verificationCommand || existingPrevention.verificationCommand || null,
    status: opts.status || existing.promotionStatus || "proposed",
    observedResult: opts.observedResult || existing.observedResult || null,
    links: mergedLinks,
  };
}

function buildRecord(opts, taxonomyClass, id) {
  const preventionTarget = opts.preventionTarget || taxonomyClass.preferredPrevention;
  const template = preventionTemplateFor({
    root: opts.cwd,
    recordId: id,
    primaryClass: opts.primaryClass,
    preventionTarget,
    symptom: opts.symptom,
  });
  const record = {
    schemaVersion: 1,
    id,
    observedAt: opts.observedAt || new Date().toISOString(),
    source: opts.source,
    primaryClass: opts.primaryClass,
    symptom: opts.symptom,
    evidence: opts.evidence,
    preventionTarget,
    promotionStatus: opts.status,
    links: opts.links,
  };
  if (opts.preventionJustification) record.preventionJustification = opts.preventionJustification;
  if (opts.status !== "rejected") {
    record.proposedPrevention = {
      path: opts.preventionPath || template.path,
      summary: opts.preventionSummary || template.summary,
    };
    if (opts.verificationCommand || template.verificationCommand) {
      record.proposedPrevention.verificationCommand = opts.verificationCommand || template.verificationCommand;
    }
  }
  if (opts.observedResult) record.observedResult = opts.observedResult;
  return record;
}

function shellQuote(value) {
  return `'${String(value || "").replaceAll("'", "'\\''")}'`;
}

function runChecker({ root, checker }) {
  const checkerPath = resolve(root, checker);
  if (!existsSync(checkerPath)) {
    return {
      ok: false,
      stdout: "",
      stderr: `${rel(root, checkerPath)} not found`,
      status: 1,
    };
  }
  const result = spawnSync(process.execPath, [checkerPath, `--cwd=${root}`], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status ?? 1,
  };
}

function nextStepsForRecord(record, { path, dryRun = false } = {}) {
  const instructions = [];
  const commands = [];
  const promotionTemplates = [];
  if (dryRun) {
    instructions.push("Rerun without --dry-run to write this failure record.");
  }

  if (record.promotionStatus === "proposed") {
    const prevention = record.proposedPrevention || {};
    if (!dryRun) instructions.push("Inspect the generated failure record before editing prevention artifacts.");
    instructions.push(`Implement the prevention artifact: ${prevention.path || "<repo-local-prevention-path>"}.`);
    instructions.push("Promote the record to applied after the prevention artifact exists.");
    const command = [
      "node .harness/scripts/record-failure.mjs",
      `--update=${record.id}`,
      "--status=applied",
      `--prevention-path=${shellQuote(prevention.path || "<repo-local-prevention-path>")}`,
      `--prevention-summary=${shellQuote(prevention.summary || "<summary>")}`,
      `--verification-command=${shellQuote(prevention.verificationCommand || "<deterministic-command>")}`,
    ].join(" ");
    promotionTemplates.push({
      status: "applied",
      command,
    });
  } else if (record.promotionStatus === "applied") {
    instructions.push("Run the deterministic verification command recorded on the prevention.");
    instructions.push("Promote the record to verified with the observed result when the prevention is proven.");
    promotionTemplates.push({
      status: "verified",
      command: `node .harness/scripts/record-failure.mjs --update=${record.id} --status=verified --observed-result="<observed-result>"`,
    });
  } else if (record.promotionStatus === "verified") {
    instructions.push("Keep the verified record as durable evidence and rerun release readiness.");
  } else if (record.promotionStatus === "rejected") {
    instructions.push("Keep the rejected record with links/evidence explaining why no prevention was applied.");
  }

  commands.push("node .harness/scripts/check-failure-records.mjs");
  commands.push("node .harness/scripts/harness-report.mjs --json --fail-on=fail --review-promotion=fail");

  return {
    recordId: record.id,
    recordPath: path,
    promotionStatus: record.promotionStatus,
    instructions,
    commands,
    promotionTemplates,
  };
}

function printNextSteps(nextSteps) {
  if (!nextSteps) return;
  console.log("record-failure: next steps");
  for (const instruction of nextSteps.instructions.slice(0, 3)) {
    console.log(`  - ${instruction}`);
  }
  for (const command of nextSteps.commands) {
    console.log(`  - ${command}`);
  }
  if (nextSteps.promotionTemplates.length > 0) {
    console.log(`  - ${nextSteps.promotionTemplates[0].command}`);
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`record-failure: ${error.message}`);
    console.error(usage());
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  const root = opts.cwd;
  const cfg = readConfig(root);
  const failureCfg = cfg.failureLearning || {};
  const pathErrors = [];
  const taxonomyPath = validateRepoLocalPath(
    root,
    opts.taxonomy || failureCfg.taxonomyPath || ".harness/failures/taxonomy.json",
    "taxonomy path",
    pathErrors,
    { mustExist: true },
  );
  if (pathErrors.length > 0) {
    console.error("record-failure: invalid input");
    for (const error of pathErrors) console.error(`- ${error}`);
    process.exit(2);
  }
  const taxonomy = readJsonIfExists(taxonomyPath);
  if (!taxonomy) {
    console.error(`record-failure: taxonomy not found at ${rel(root, taxonomyPath)}`);
    process.exit(1);
  }
  const classMap = new Map((taxonomy.classes || []).map((cls) => [cls.id, cls]));

  const recordsDirErrors = [];
  const recordsDir = validateRepoLocalPath(
    root,
    opts.recordsDir || failureCfg.recordsDir || taxonomy.recordsDir || ".harness/failures/records",
    "recordsDir",
    recordsDirErrors,
  );
  if (recordsDirErrors.length > 0) {
    console.error("record-failure: invalid input");
    for (const error of recordsDirErrors) console.error(`- ${error}`);
    process.exit(2);
  }
  let existingRecord = null;
  let recordPath = null;
  if (opts.updateId) {
    if (!stableId(opts.updateId)) {
      console.error("record-failure: invalid input");
      console.error("- --update must match ^[a-z0-9][a-z0-9._-]*$");
      process.exit(2);
    }
    recordPath = join(recordsDir, `${opts.updateId}.json`);
    if (!existsSync(recordPath)) {
      console.error(`record-failure: ${rel(root, recordPath)} not found; cannot update`);
      process.exit(1);
    }
    existingRecord = readJsonIfExists(recordPath);
    if (!existingRecord || typeof existingRecord !== "object" || Array.isArray(existingRecord)) {
      console.error(`record-failure: ${rel(root, recordPath)} is not a valid record object`);
      process.exit(1);
    }
  }
  const effectiveOpts = mergeExistingRecordOptions(opts, existingRecord, classMap);
  const inputErrors = validateInputs(effectiveOpts, classMap, root);
  if (inputErrors.length > 0) {
    console.error("record-failure: invalid input");
    for (const error of inputErrors) console.error(`- ${error}`);
    process.exit(2);
  }
  const id = opts.updateId || effectiveOpts.id || generatedId(effectiveOpts, recordsDir);
  recordPath ||= join(recordsDir, `${id}.json`);
  if (!opts.updateId && existsSync(recordPath) && (!opts.id || !opts.force)) {
    console.error(`record-failure: ${rel(root, recordPath)} already exists; pass --force with an explicit --id to overwrite`);
    process.exit(1);
  }

  const record = buildRecord(effectiveOpts, classMap.get(effectiveOpts.primaryClass), id);
  const payload = {
    status: "prepared",
    mode: opts.updateId ? "update" : "create",
    path: rel(root, recordPath),
    record,
    checker: null,
    nextSteps: null,
  };

  if (!opts.dryRun) {
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
    payload.status = "written";
  }

  if (!opts.dryRun && opts.check) {
    const checker = opts.checker || failureCfg.checker || ".harness/scripts/check-failure-records.mjs";
    const result = runChecker({ root, checker });
    payload.checker = {
      ok: result.ok,
      status: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
    payload.status = result.ok ? "passed" : "failed";
    if (!result.ok && !opts.json) {
      console.error(`record-failure: ${opts.updateId ? "updated" : "wrote"} ${rel(root, recordPath)} but checker failed`);
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.status || 1);
    }
  }
  payload.nextSteps = nextStepsForRecord(record, { path: payload.path, dryRun: opts.dryRun });

  if (opts.json || opts.dryRun) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`record-failure: ${opts.updateId ? "updated" : "wrote"} ${rel(root, recordPath)}`);
    if (payload.checker) console.log("record-failure: checker passed");
    printNextSteps(payload.nextSteps);
  }
  if (payload.status === "failed") process.exit(payload.checker?.status || 1);
}

main();
