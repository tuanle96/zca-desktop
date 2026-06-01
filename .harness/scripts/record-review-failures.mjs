#!/usr/bin/env node
// record-review-failures.mjs - promote blocking review decisions into the
// failure-to-rule ledger.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import {
  failureClassFromText,
  hasUrlScheme,
  insideRoot,
  preventionTemplateFor,
} from "./_lib/failure-policy.mjs";

const REVIEWER_CLASS = {
  "architecture-reviewer": "architecture-drift",
  "adapter-compatibility-reviewer": "runtime-gap",
  "api-consistency-reviewer": "architecture-drift",
  "eval-rubric-reviewer": "eval-gap",
  "release-harness-reviewer": "false-done",
  "reliability-reviewer": "runtime-gap",
  "security-reviewer": "model-behavior",
  "performance-reviewer": "model-behavior",
  "trace-failure-analyst": "model-behavior",
};

function usage() {
  return `Usage:
  node .harness/scripts/record-review-failures.mjs [--review=.harness/reviews/<task>/<reviewer>.json]

Options:
  --cwd=<path>              Project root (default: current directory)
  --review=<path>           Review decision artifact to ingest; repeatable
  --reviews-dir=<path>      Directory to scan when --review is omitted
  --taxonomy=<path>         Override failure taxonomy path
  --records-dir=<path>      Override failure records directory
  --checker=<path>          Override failure record checker path
  --class=<taxonomy-id>     Force one primary class for generated records
  --force                   Overwrite existing generated records
  --no-check                Do not run check-failure-records after writing
  --dry-run                 Print records without writing
  --json                    Print JSON output
  --help                    Show this help
`;
}

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    reviewPaths: [],
    reviewsDir: null,
    taxonomy: null,
    recordsDir: null,
    checker: null,
    primaryClass: null,
    force: false,
    check: true,
    dryRun: false,
    json: false,
    help: false,
  };

  const booleans = new Set(["force", "no-check", "dry-run", "json", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected positional argument "${arg}"`);
    const raw = arg.slice(2);
    let key;
    let value;
    if (raw.includes("=")) {
      const idx = raw.indexOf("=");
      key = raw.slice(0, idx);
      value = raw.slice(idx + 1);
    } else {
      key = raw;
      value = booleans.has(key) ? true : argv[++i];
    }
    if (value === undefined) throw new Error(`--${key} requires a value`);
    if (key === "help") opts.help = true;
    else if (key === "force") opts.force = true;
    else if (key === "no-check") opts.check = false;
    else if (key === "dry-run") opts.dryRun = true;
    else if (key === "json") opts.json = true;
    else if (key === "cwd") opts.cwd = value;
    else if (key === "review") opts.reviewPaths.push(...String(value).split(",").map((item) => item.trim()).filter(Boolean));
    else if (key === "reviews-dir") opts.reviewsDir = value;
    else if (key === "taxonomy") opts.taxonomy = value;
    else if (key === "records-dir") opts.recordsDir = value;
    else if (key === "checker") opts.checker = value;
    else if (key === "class" || key === "primary-class") opts.primaryClass = value;
    else throw new Error(`unknown option --${key}`);
  }
  opts.cwd = resolve(opts.cwd);
  return opts;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function readConfig(root) {
  return readJsonIfExists(resolve(root, ".harness/config.json")) ||
    readJsonIfExists(resolve(root, "harness.config.json")) ||
    {};
}

function rel(root, path) {
  return relative(root, path).split("\\").join("/") || ".";
}

function validateRepoLocalPath(root, value, label, errors, { mustExist = false } = {}) {
  const text = String(value || "").trim();
  if (!text) {
    errors.push(`${label} must be a non-empty repo-local path`);
    return null;
  }
  if (hasUrlScheme(text)) {
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

function listJsonFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) out.push(path);
    }
  }
  walk(dir);
  return out;
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
    .slice(0, 72)
    .replace(/-+$/g, "") || "review-failure";
}

function inferClass(decision, finding, classMap) {
  const text = [
    decision.reviewer,
    decision.summary,
    finding?.rule,
    finding?.evidence,
    finding?.fix,
  ].filter(Boolean).join(" ").toLowerCase();

  const inferred = failureClassFromText(text, classMap, { fallback: null });
  if (inferred) return inferred;

  const reviewerClass = REVIEWER_CLASS[decision.reviewer];
  if (reviewerClass && classMap.has(reviewerClass)) return reviewerClass;
  return classMap.has("model-behavior") ? "model-behavior" : [...classMap.keys()][0];
}

function recordId({ primaryClass, decision, finding, idx }) {
  const observed = Date.parse(decision.createdAt || "");
  const stamp = new Date(Number.isFinite(observed) ? observed : Date.now()).toISOString().slice(0, 10).replaceAll("-", "");
  const scope = decision.taskId || decision.featureId || decision.reviewer || "review";
  const signal = finding?.rule || finding?.evidence || decision.summary || decision.decision;
  return `${stamp}-${primaryClass}-${slugify(`${decision.reviewer}-${scope}-${idx}-${signal}`)}`;
}

function actionableFindings(decision) {
  const findings = Array.isArray(decision.findings) ? decision.findings : [];
  if (decision.decision === "block") return findings.filter((finding) => finding?.blocking === true);
  if (decision.decision === "needs-human") return findings;
  return [];
}

function symptomFor(decision, finding) {
  const scope = decision.taskId || decision.featureId || "unknown-task";
  const signal = finding?.evidence || decision.summary || "review decision requires follow-up";
  if (decision.decision === "needs-human") {
    return `${decision.reviewer} needs human decision for ${scope}: ${signal}`;
  }
  return `${decision.reviewer} blocked ${scope}: ${signal}`;
}

function buildRecords({ root, reviews, classMap, primaryClassOverride, recordsDir, force }) {
  const records = [];
  const skipped = [];
  const errors = [];

  if (classMap.size === 0) {
    errors.push("taxonomy must contain at least one failure class");
    return { records, skipped, errors };
  }
  if (primaryClassOverride && (!stableId(primaryClassOverride) || !classMap.has(primaryClassOverride))) {
    errors.push(`--class must be one of ${[...classMap.keys()].sort().join(", ")}`);
    return { records, skipped, errors };
  }

  for (const reviewPath of reviews) {
    let decision;
    try {
      decision = JSON.parse(readFileSync(reviewPath, "utf8"));
    } catch (error) {
      skipped.push({ path: rel(root, reviewPath), reason: `invalid JSON: ${error.message}` });
      continue;
    }
    if (decision?.decision !== "block" && decision?.decision !== "needs-human") {
      skipped.push({ path: rel(root, reviewPath), reason: `decision=${decision?.decision || "unknown"}` });
      continue;
    }
    const findings = actionableFindings(decision);
    if (findings.length === 0) {
      skipped.push({ path: rel(root, reviewPath), reason: `decision=${decision.decision} has no actionable findings` });
      continue;
    }
    for (const [idx, finding] of findings.entries()) {
      const primaryClass = primaryClassOverride || inferClass(decision, finding, classMap);
      const taxonomyClass = classMap.get(primaryClass);
      const id = recordId({ primaryClass, decision, finding, idx });
      const path = join(recordsDir, `${id}.json`);
      if (existsSync(path) && !force) {
        skipped.push({ path: rel(root, reviewPath), recordPath: rel(root, path), reason: "record already exists" });
        continue;
      }
      const preventionTarget = taxonomyClass?.preferredPrevention || "script";
      const proposedPrevention = preventionTemplateFor({
        root,
        recordId: id,
        primaryClass,
        preventionTarget,
        symptom: symptomFor(decision, finding),
      });
      records.push({
        path: rel(root, path),
        record: {
          schemaVersion: 1,
          id,
          observedAt: new Date().toISOString(),
          source: "review",
          primaryClass,
          symptom: symptomFor(decision, finding),
          evidence: [rel(root, reviewPath)],
          preventionTarget,
          proposedPrevention: {
            path: proposedPrevention.path,
            summary: proposedPrevention.summary,
            verificationCommand: proposedPrevention.verificationCommand,
          },
          promotionStatus: "proposed",
          links: [],
        },
      });
    }
  }

  return { records, skipped, errors };
}

function runChecker({ root, checker }) {
  const checkerPath = resolve(root, checker);
  if (!existsSync(checkerPath)) {
    return { ok: false, status: 1, stdout: "", stderr: `${rel(root, checkerPath)} not found` };
  }
  const result = spawnSync(process.execPath, [checkerPath, `--cwd=${root}`], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function nextStepsForRecords(records, { dryRun = false } = {}) {
  const recordIds = records.map((item) => item.record.id);
  const recordPaths = records.map((item) => item.path);
  const promotionTemplates = records.map((item) => ({
    recordId: item.record.id,
    command: [
      "node .harness/scripts/record-failure.mjs",
      `--update=${item.record.id}`,
      "--status=applied",
      `--prevention-path=${shellQuote(item.record.proposedPrevention?.path || "<repo-local-prevention-path>")}`,
      `--prevention-summary=${shellQuote(item.record.proposedPrevention?.summary || "<summary>")}`,
      `--verification-command=${shellQuote(item.record.proposedPrevention?.verificationCommand || "<deterministic-command>")}`,
    ].join(" "),
  }));
  const instructions = [];
  if (recordIds.length === 0) {
    return {
      recordIds,
      recordPaths,
      instructions,
      commands: [],
      promotionTemplates,
    };
  }

  if (dryRun) {
    instructions.push("Rerun without --dry-run to write these proposed failure records.");
  } else {
    instructions.push("Inspect the generated failure record JSON before editing prevention artifacts.");
  }
  instructions.push("Implement the smallest durable prevention artifact for each record.");
  instructions.push("Promote each record with record-failure.mjs --update after the prevention artifact exists.");
  instructions.push("Rerun the failure-record checker and then the release report gate.");

  return {
    recordIds,
    recordPaths,
    instructions,
    commands: [
      "node .harness/scripts/check-failure-records.mjs",
      "node .harness/scripts/harness-report.mjs --json --fail-on=fail --review-promotion=fail",
    ],
    promotionTemplates,
  };
}

function shellQuote(value) {
  return `'${String(value || "").replaceAll("'", "'\\''")}'`;
}

function printNextSteps(nextSteps) {
  if (!nextSteps || nextSteps.recordIds.length === 0) return;
  console.log("record-review-failures: next steps");
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
    console.error(`record-review-failures: ${error.message}`);
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
  const taskCfg = cfg.taskContracts || {};
  const pathErrors = [];
  const taxonomyPath = validateRepoLocalPath(
    root,
    opts.taxonomy || failureCfg.taxonomyPath || ".harness/failures/taxonomy.json",
    "taxonomy path",
    pathErrors,
    { mustExist: true },
  );
  const recordsDir = validateRepoLocalPath(
    root,
    opts.recordsDir || failureCfg.recordsDir || ".harness/failures/records",
    "recordsDir",
    pathErrors,
  );
  if (pathErrors.length > 0) {
    console.error("record-review-failures: invalid input");
    for (const error of pathErrors) console.error(`- ${error}`);
    process.exit(2);
  }

  const taxonomy = readJsonIfExists(taxonomyPath);
  const classMap = new Map((taxonomy?.classes || []).map((cls) => [cls.id, cls]));
  const reviewPathErrors = [];
  let reviews;
  if (opts.reviewPaths.length > 0) {
    reviews = opts.reviewPaths
      .map((review, idx) => validateRepoLocalPath(root, review, `--review[${idx}]`, reviewPathErrors, { mustExist: true }))
      .filter(Boolean);
  } else {
    const reviewsDir = validateRepoLocalPath(
      root,
      opts.reviewsDir || taskCfg.reviewsDir || ".harness/reviews",
      "reviewsDir",
      reviewPathErrors,
      { mustExist: false },
    );
    reviews = reviewsDir ? listJsonFilesRecursive(reviewsDir) : [];
  }
  if (reviewPathErrors.length > 0) {
    console.error("record-review-failures: invalid input");
    for (const error of reviewPathErrors) console.error(`- ${error}`);
    process.exit(2);
  }

  const payload = {
    status: "prepared",
    records: [],
    skipped: [],
    checker: null,
    nextSteps: null,
  };
  const built = buildRecords({
    root,
    reviews,
    classMap,
    primaryClassOverride: opts.primaryClass,
    recordsDir,
    force: opts.force,
  });
  payload.records = built.records;
  payload.skipped = built.skipped;
  if (built.errors.length > 0) {
    console.error("record-review-failures: invalid input");
    for (const error of built.errors) console.error(`- ${error}`);
    process.exit(2);
  }

  if (!opts.dryRun) {
    for (const item of payload.records) {
      const path = resolve(root, item.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(item.record, null, 2) + "\n");
    }
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
      console.error(`record-review-failures: wrote ${payload.records.length} record(s) but checker failed`);
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.status || 1);
    }
  }
  payload.nextSteps = nextStepsForRecords(payload.records, { dryRun: opts.dryRun });

  if (opts.json || opts.dryRun) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`record-review-failures: wrote ${payload.records.length} proposed failure record(s)`);
    if (payload.skipped.length > 0) console.log(`record-review-failures: skipped ${payload.skipped.length} review signal(s)`);
    if (payload.checker) console.log("record-review-failures: checker passed");
    printNextSteps(payload.nextSteps);
  }
  if (payload.status === "failed") process.exit(payload.checker?.status || 1);
}

main();
