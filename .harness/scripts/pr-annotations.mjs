#!/usr/bin/env node
// pr-annotations.mjs - turn harness gate output into PR-friendly annotations,
// Markdown, JSON, and SARIF without depending on the GitHub API.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { auditBypassRecords } from "./_lib/bypass-audit.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STATUS_ORDER = { pass: 0, warn: 1, fail: 2 };

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    json: false,
    markdown: false,
    githubAnnotations: process.env.GITHUB_ACTIONS === "true",
    out: ".harness/reports/pr-annotations.md",
    sarifOut: ".harness/reports/pr-annotations.sarif",
    jsonOut: "",
    failOn: "",
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--markdown") opts.markdown = true;
    else if (arg === "--github-annotations") opts.githubAnnotations = true;
    else if (arg === "--no-github-annotations") opts.githubAnnotations = false;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg.startsWith("--sarif-out=")) opts.sarifOut = arg.slice("--sarif-out=".length);
    else if (arg.startsWith("--json-out=")) opts.jsonOut = arg.slice("--json-out=".length);
    else if (arg.startsWith("--fail-on=")) opts.failOn = arg.slice("--fail-on=".length);
  }
  opts.cwd = resolve(opts.cwd);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = opts.cwd;

function rel(path) {
  return relative(ROOT, path).replaceAll("\\", "/") || ".";
}

function insideRoot(path) {
  const normalizedRoot = ROOT.endsWith("/") ? ROOT : `${ROOT}/`;
  return path === ROOT || path.startsWith(normalizedRoot);
}

function safeReadJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { _invalid: true, _path: rel(path) };
  }
}

function listJsonFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        out.push(path);
      }
    }
  }
  walk(dir);
  return out;
}

function loadJsonObjects(dir) {
  return listJsonFilesRecursive(dir).map((path) => {
    const value = safeReadJson(path);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      value._path ||= rel(path);
      return value;
    }
    return { _invalid: true, _path: rel(path) };
  });
}

function runJson(scriptName, args = []) {
  const script = resolve(SCRIPT_DIR, scriptName);
  if (!existsSync(script)) {
    return {
      ok: false,
      status: "unavailable",
      errors: [`${scriptName} not found`],
      warnings: [],
      stdout: "",
      stderr: "",
    };
  }
  const result = spawnSync(process.execPath, [script, `--cwd=${ROOT}`, ...args, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const payload = JSON.parse(result.stdout || "{}");
    return {
      ok: result.status === 0,
      exitCode: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      ...payload,
    };
  } catch {
    return {
      ok: false,
      exitCode: result.status,
      status: "unavailable",
      errors: [`${scriptName} did not emit valid JSON`],
      warnings: [],
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  }
}

function worst(statuses) {
  return statuses.reduce((acc, status) => STATUS_ORDER[status] > STATUS_ORDER[acc] ? status : acc, "pass");
}

function annotation({ category, severity = "warning", file = ".harness/config.json", line = 1, message, details = "", nextStep = "" }) {
  return {
    category,
    severity,
    file,
    line: Number.isFinite(Number(line)) && Number(line) > 0 ? Number(line) : 1,
    message,
    details,
    nextStep,
  };
}

function classifyTaskEvidenceError(error) {
  const text = String(error || "");
  if (/advisor/i.test(text)) return "advisor";
  if (/reviewer|review decision|required reviewer/i.test(text)) return "required-reviewer";
  if (/hash|attest|stdoutHash|stderrHash|exitCode|workingTreeHash/i.test(text)) return "attestation";
  if (/\.harness\/task-contracts|task contract|contract/i.test(text)) return "task-contract";
  if (/\.harness\/evidence|evidence|knownRisks|diffSummary|checks\[/i.test(text)) return "evidence";
  return "evidence";
}

function fileFromMessage(message, fallback) {
  const match = String(message).match(/((?:\.harness|src|app|pages|components|api|routes|controllers|pipelines|jobs|scripts|\.github)\/[^:\s)]+)/);
  return match?.[1] || fallback;
}

function taskEvidenceAnnotations(payload) {
  const out = [];
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  if (errors.length === 0) {
    out.push(annotation({
      category: "task-evidence",
      severity: "notice",
      message: "Task contracts and evidence bundles passed strict validation.",
      nextStep: "node .harness/scripts/task-evidence-check.mjs --strict",
    }));
    return out;
  }
  for (const error of errors) {
    const category = classifyTaskEvidenceError(error);
    out.push(annotation({
      category,
      severity: "error",
      file: fileFromMessage(error, category === "task-contract" ? ".harness/task-contracts" : ".harness/evidence"),
      message: String(error),
      nextStep: "node .harness/scripts/task-evidence-check.mjs --strict --verify-hashes",
    }));
  }
  return out;
}

function reviewCoverageAnnotations({ contracts, evidence, reviewDecisions }) {
  const out = [];
  const evidenceByTask = new Map();
  for (const item of evidence) {
    if (!item._invalid && item.taskId) evidenceByTask.set(item.taskId, item);
  }
  const decisionsByTaskReviewer = new Map();
  for (const decision of reviewDecisions) {
    if (decision._invalid || !decision.taskId || !decision.reviewer) continue;
    decisionsByTaskReviewer.set(`${decision.taskId}:${decision.reviewer}`, decision);
  }

  for (const contract of contracts) {
    if (contract._invalid || !contract.id) {
      out.push(annotation({
        category: "task-contract",
        severity: "error",
        file: contract._path || ".harness/task-contracts",
        message: "Task contract JSON is invalid.",
        nextStep: "node .harness/scripts/task-evidence-check.mjs --strict",
      }));
      continue;
    }
    const required = Array.isArray(contract.requiredReviewers) ? contract.requiredReviewers : [];
    if (required.length === 0) continue;
    const evidenceReviewers = new Map();
    const bundle = evidenceByTask.get(contract.id);
    for (const item of Array.isArray(bundle?.reviewers) ? bundle.reviewers : []) {
      if (item?.name) evidenceReviewers.set(item.name, item);
    }
    for (const reviewer of required) {
      const inline = evidenceReviewers.get(reviewer);
      const decision = decisionsByTaskReviewer.get(`${contract.id}:${reviewer}`);
      const status = inline?.decision || decision?.decision || "";
      if (status === "pass") continue;
      const category = reviewer === "advisor" ? "advisor" : "required-reviewer";
      out.push(annotation({
        category,
        severity: status === "block" ? "error" : "warning",
        file: bundle?._path || contract.evidencePath || contract._path || ".harness/evidence",
        message: status === "block"
          ? `${reviewer} blocks task ${contract.id}.`
          : `${contract.id} is missing a passing ${reviewer} review decision.`,
        details: decision?.summary || inline?.summary || "",
        nextStep: reviewer === "advisor"
          ? "Add a passing advisor review decision artifact and reference it from the evidence bundle."
          : "Add the required reviewer pass decision or update the task contract scope.",
      }));
    }
  }
  return out;
}

function architectureAnnotations(payload) {
  const out = [];
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  for (const error of errors) {
    out.push(annotation({
      category: "architecture-fitness",
      severity: "error",
      file: fileFromMessage(error, ".harness/fitness/rules"),
      message: String(error),
      nextStep: "node .harness/scripts/check-architecture-fitness.mjs --strict",
    }));
  }
  for (const finding of Array.isArray(payload.findings) ? payload.findings : []) {
    out.push(annotation({
      category: "architecture-fitness",
      severity: finding.severity === "warn" ? "warning" : "error",
      file: finding.file || ".harness/fitness/rules",
      line: finding.line || 1,
      message: `[${finding.ruleId}] ${finding.message}`,
      details: finding.evidence || "",
      nextStep: `Fix ${finding.ruleId} or update the architecture fitness rule with examples.`,
    }));
  }
  return out;
}

function bypassAnnotations(payload) {
  const out = [];
  for (const error of payload.errors || []) {
    out.push(annotation({
      category: "bypass",
      severity: "error",
      file: payload.logPath || ".harness/bypass.log",
      message: String(error),
      nextStep: "node .harness/scripts/check-bypass-audit.mjs --strict",
    }));
  }
  for (const item of payload.unacknowledged || []) {
    out.push(annotation({
      category: "bypass",
      severity: "error",
      file: payload.logPath || ".harness/bypass.log",
      line: item.line || 1,
      message: `Unreviewed harness bypass ${item.fingerprint}.`,
      details: item.reason || item.command || item.prompt || "",
      nextStep: "Review the bypass in .harness/bypass-audit.json or create an approved bypass request.",
    }));
  }
  return out;
}

function runtimeParityAnnotations(payload) {
  const out = [];
  if (payload.status !== "failed" && payload.status !== "unavailable") return out;
  for (const error of payload.errors || []) {
    out.push(annotation({
      category: "runtime-parity",
      severity: "error",
      file: ".harness/config.json",
      message: String(error),
      nextStep: "node .harness/scripts/runtime-parity-report.mjs --strict",
    }));
  }
  return out;
}

function readinessAnnotations(payload) {
  const out = [];
  for (const error of Array.isArray(payload.errors) ? payload.errors : []) {
    out.push(annotation({
      category: "readiness",
      severity: "error",
      file: ".harness/config.json",
      message: String(error),
      nextStep: "node .harness/scripts/harness-readiness.mjs --strict",
    }));
  }
  for (const gate of Array.isArray(payload.results) ? payload.results : []) {
    if (gate.status !== "failed") continue;
    out.push(annotation({
      category: "readiness",
      severity: gate.required ? "error" : "warning",
      file: ".harness/config.json",
      message: `Readiness gate ${gate.id} failed.`,
      details: Array.isArray(gate.output) ? gate.output.join("; ") : gate.summary || gate.stderr || gate.stdout || "",
      nextStep: gate.command || "node .harness/scripts/harness-readiness.mjs --strict",
    }));
  }
  return out;
}

function evidenceAttestationSummary(payload) {
  const errors = (payload.errors || []).filter((error) => classifyTaskEvidenceError(error) === "attestation");
  return {
    status: errors.length === 0 ? "pass" : "fail",
    errors,
  };
}

function githubEscape(value) {
  return String(value || "")
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function githubPropEscape(value) {
  return githubEscape(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function emitGithubAnnotations(annotations) {
  for (const item of annotations) {
    if (item.severity === "notice") continue;
    const level = item.severity === "error" ? "error" : "warning";
    const props = [
      `file=${githubPropEscape(item.file || ".harness/config.json")}`,
      `line=${githubPropEscape(item.line || 1)}`,
      `title=${githubPropEscape(item.category)}`,
    ].join(",");
    const body = `${item.message}${item.nextStep ? ` Next: ${item.nextStep}` : ""}`;
    console.log(`::${level} ${props}::${githubEscape(body)}`);
  }
}

function sarifFromArchitecture(findings) {
  const rules = new Map();
  const results = [];
  for (const item of findings) {
    if (item.category !== "architecture-fitness") continue;
    const ruleId = String(item.message.match(/^\[([^\]]+)\]/)?.[1] || item.category);
    rules.set(ruleId, {
      id: ruleId,
      shortDescription: { text: ruleId },
      help: { text: item.nextStep || "Fix the architecture fitness finding." },
    });
    results.push({
      ruleId,
      level: item.severity === "error" ? "error" : "warning",
      message: { text: item.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: item.file || ".harness/config.json" },
            region: { startLine: item.line || 1 },
          },
        },
      ],
    });
  }
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "agent-harness-kit pr-annotations",
            informationUri: "https://github.com/tuanle96/agent-harness-kit",
            rules: [...rules.values()],
          },
        },
        results,
      },
    ],
  };
}

function markdown(payload) {
  const lines = [];
  lines.push("# Harness PR Annotations");
  lines.push("");
  lines.push(`Status: **${payload.status.toUpperCase()}**`);
  lines.push("");
  lines.push("| Gate | Status | Detail |");
  lines.push("| --- | --- | --- |");
  for (const row of payload.summary) {
    lines.push(`| ${row.id} | ${row.status} | ${row.detail.replaceAll("|", "\\|")} |`);
  }
  lines.push("");
  if (payload.annotations.length === 0) {
    lines.push("No PR annotations.");
  } else {
    lines.push("| Severity | Category | File | Message | Next step |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const item of payload.annotations.slice(0, 50)) {
      lines.push(
        `| ${item.severity} | ${item.category} | \`${item.file}\` | ${item.message.replaceAll("|", "\\|")} | ${String(item.nextStep || "").replaceAll("|", "\\|")} |`,
      );
    }
    if (payload.annotations.length > 50) lines.push(`| info | truncated |  | ${payload.annotations.length - 50} more annotation(s) omitted |  |`);
  }
  lines.push("");
  lines.push("Generated by `node .harness/scripts/pr-annotations.mjs`.");
  lines.push("");
  return `${lines.join("\n")}`;
}

function writeText(path, content) {
  const abs = resolve(ROOT, path);
  if (!insideRoot(abs)) throw new Error(`${path}: output path must stay inside project root`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return rel(abs);
}

function statusFromPayloads({ readiness, taskEvidence, architecture, bypass, runtimeParity }) {
  const statuses = [
    readiness.status === "failed" || readiness.status === "unavailable" ? "fail" : "pass",
    taskEvidence.status === "failed" || taskEvidence.status === "unavailable" ? "fail" : "pass",
    architecture.status === "fail" || architecture.status === "unavailable" ? "fail" : "pass",
    bypass.status === "passed" ? "pass" : "fail",
    runtimeParity.status === "failed" || runtimeParity.status === "unavailable" ? "fail" : "pass",
  ];
  return worst(statuses);
}

function main() {
  const taskEvidence = runJson("task-evidence-check.mjs", ["--strict", "--verify-hashes"]);
  const readiness = runJson("harness-readiness.mjs", ["--strict"]);
  const architecture = runJson("check-architecture-fitness.mjs", ["--strict"]);
  const runtimeParity = runJson("runtime-parity-report.mjs", ["--strict"]);
  const bypass = auditBypassRecords({ cwd: ROOT, strict: true });
  const contracts = loadJsonObjects(resolve(ROOT, ".harness/task-contracts"));
  const evidence = loadJsonObjects(resolve(ROOT, ".harness/evidence"));
  const reviewDecisions = loadJsonObjects(resolve(ROOT, ".harness/reviews"));
  const attestation = evidenceAttestationSummary(taskEvidence);

  const annotations = [
    ...readinessAnnotations(readiness),
    ...taskEvidenceAnnotations(taskEvidence),
    ...reviewCoverageAnnotations({ contracts, evidence, reviewDecisions }),
    ...architectureAnnotations(architecture),
    ...bypassAnnotations(bypass),
    ...runtimeParityAnnotations(runtimeParity),
  ];

  const status = annotations.some((item) => item.severity === "error")
    ? "fail"
    : annotations.some((item) => item.severity === "warning")
      ? "warn"
      : statusFromPayloads({ readiness, taskEvidence, architecture, bypass, runtimeParity });

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    summary: [
      { id: "readiness", status: readiness.status || "unknown", detail: `${(readiness.results || []).filter((gate) => gate.status === "failed").length} failed gate(s)` },
      { id: "task-contracts", status: taskEvidence.status || "unknown", detail: `${contracts.length} contract artifact(s)` },
      { id: "evidence", status: taskEvidence.status || "unknown", detail: `${evidence.length} evidence bundle(s)` },
      { id: "advisor", status: annotations.some((item) => item.category === "advisor") ? "attention" : "pass", detail: `${annotations.filter((item) => item.category === "advisor").length} advisor issue(s)` },
      { id: "required-reviewers", status: annotations.some((item) => item.category === "required-reviewer") ? "attention" : "pass", detail: `${annotations.filter((item) => item.category === "required-reviewer").length} reviewer gap(s)` },
      { id: "bypass-audit", status: bypass.status || "unknown", detail: `${bypass.unacknowledged?.length || 0} unreviewed bypass(es)` },
      { id: "evidence-attestation", status: attestation.status, detail: `${attestation.errors.length} attestation issue(s)` },
      { id: "architecture-fitness", status: architecture.status || "unknown", detail: `${architecture.findings?.length || 0} finding(s)` },
      { id: "runtime-parity", status: runtimeParity.status || "unknown", detail: `${runtimeParity.errors?.length || 0} runtime parity error(s)` },
    ],
    annotations,
    artifacts: {},
  };

  payload.artifacts.markdown = writeText(opts.out, markdown(payload));
  payload.artifacts.sarif = writeText(opts.sarifOut, JSON.stringify(sarifFromArchitecture(annotations), null, 2) + "\n");
  if (opts.jsonOut) payload.artifacts.json = writeText(opts.jsonOut, JSON.stringify(payload, null, 2) + "\n");

  if (opts.githubAnnotations) emitGithubAnnotations(annotations);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(payload), { flag: "a" });
    } catch {
      // Do not fail local reporting because the GitHub summary file is absent.
    }
  }

  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else if (opts.markdown) process.stdout.write(markdown(payload));
  else console.log(payload.artifacts.markdown);

  if (opts.failOn && STATUS_ORDER[payload.status] >= STATUS_ORDER[opts.failOn]) process.exitCode = 1;
}

main();
