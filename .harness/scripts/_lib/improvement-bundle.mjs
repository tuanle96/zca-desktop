// improvement-bundle.mjs - deterministic signal bundler for the
// failure-to-rule loop. This module is used by .harness/scripts/improvement-bundle.mjs
// and intentionally stays runtime-agnostic: skills may call it, but it does not
// depend on .claude or .agents surfaces.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PREVENTION_TARGET,
  failureClassFromSignal,
} from "./failure-policy.mjs";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function policySource() {
  return SCRIPT_DIR.includes("/.harness/scripts/_lib")
    ? ".harness/scripts/_lib/failure-policy.mjs"
    : "template:scripts/_lib/failure-policy.mjs";
}

function parseArgs(argv) {
  const out = { window: 14, out: null, taxonomy: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--window") out.window = Number(argv[++i]) || 14;
    else if (argv[i] === "--out") out.out = argv[++i];
    else if (argv[i] === "--taxonomy") out.taxonomy = argv[++i];
  }
  return out;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function readConfig() {
  return readJsonIfExists(resolve(ROOT, ".harness/config.json")) ||
    readJsonIfExists(resolve(ROOT, "harness.config.json")) ||
    {};
}

function taxonomyPathFrom({ taxonomy }) {
  if (taxonomy) return taxonomy;
  const cfg = readConfig();
  return cfg.failureLearning?.taxonomyPath || ".harness/failures/taxonomy.json";
}

function preventionTargetsFromTaxonomy({ taxonomy }) {
  const relPath = taxonomyPathFrom({ taxonomy });
  const path = resolve(ROOT, relPath);
  if (!existsSync(path)) {
    return {
      source: "fallback",
      targets: new Map(Object.entries(DEFAULT_PREVENTION_TARGET)),
    };
  }
  const parsed = readJsonIfExists(path);
  const classes = Array.isArray(parsed?.classes) ? parsed.classes : [];
  const targets = new Map();
  for (const cls of classes) {
    if (cls?.id && cls?.preferredPrevention) targets.set(cls.id, cls.preferredPrevention);
  }
  return {
    source: relPath,
    targets: targets.size > 0 ? targets : new Map(Object.entries(DEFAULT_PREVENTION_TARGET)),
  };
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const body = readFileSync(path, "utf8");
  const out = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

function isWithin(ts, days) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) <= days * 24 * 3600 * 1000;
}

function gitLogFixes(days) {
  const since = `${days}.days`;
  const r = spawnSync("git", ["log", `--since=${since}`, "--oneline", "--grep=fix\\|revert\\|hotfix"], {
    cwd: ROOT, encoding: "utf8",
  });
  if (r.status !== 0) return [];
  return (r.stdout || "").split("\n").filter(Boolean).slice(0, 50);
}

function summariseFailures(telemetry, bypass, windowDays) {
  const failures = [];
  for (const rec of telemetry) {
    if (!rec.ts || !isWithin(rec.ts, windowDays)) continue;
    if (rec.event === "structural_test_fail" || rec.event === "precompletion_block" ||
        rec.event === "permission_denied" || rec.event === "userprompt_block") {
      failures.push({
        ts: rec.ts,
        event: rec.event,
        source: rec.source || rec.rule || "(unspecified)",
        detail: (rec.reason || rec.detail || rec.skill || "").slice(0, 200),
        evidencePath: ".harness/telemetry.jsonl",
      });
    }
  }
  for (const rec of bypass) {
    if (!rec.ts || !isWithin(rec.ts, windowDays)) continue;
    failures.push({
      ts: rec.ts,
      event: "bypass",
      source: rec.rule || rec.bypass || "(unspecified)",
      detail: (rec.command || rec.file || "").slice(0, 200),
      evidencePath: ".harness/bypass.log",
    });
  }
  failures.sort((a, b) => a.ts.localeCompare(b.ts));
  return failures.slice(-40);
}

function recurringPatterns(failures) {
  const counts = new Map();
  const samples = new Map();
  for (const f of failures) {
    const key = `${f.event}::${f.source}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!samples.has(key)) samples.set(key, f.ts);
  }
  const out = [];
  for (const [key, count] of counts) {
    if (count >= 2) out.push({ pattern: key, count, sample_ts: samples.get(key) });
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, 20);
}

function classify(failures, recurring) {
  const buckets = { context: 0, rule: 0, tool_skill: 0, architecture: 0, prompt: 0 };
  for (const f of failures) {
    if (f.event === "structural_test_fail") buckets.rule++;
    else if (f.event === "precompletion_block") buckets.rule++;
    else if (f.event === "permission_denied") buckets.context++;
    else if (f.event === "userprompt_block") buckets.context++;
    else if (f.event === "bypass") buckets.tool_skill++;
  }
  for (const r of recurring) {
    if (r.count >= 3 && r.pattern.startsWith("structural_test_fail::")) {
      buckets.architecture++;
    }
  }
  return buckets;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function taxonomyClassification(failures, preventionTargets) {
  const grouped = new Map();
  for (const failure of failures) {
    const primaryClass = failureClassFromSignal(failure);
    if (!grouped.has(primaryClass)) grouped.set(primaryClass, []);
    grouped.get(primaryClass).push(failure);
  }
  return [...grouped.entries()]
    .map(([primaryClass, items]) => ({
      primaryClass,
      count: items.length,
      preventionTarget: preventionTargets.get(primaryClass) || DEFAULT_PREVENTION_TARGET[primaryClass] || "script",
      evidence: [...new Set(items.map((item) => item.evidencePath).filter(Boolean))],
      sample: items.at(-1),
    }))
    .sort((a, b) => b.count - a.count || a.primaryClass.localeCompare(b.primaryClass));
}

function buildSuggestedRecords(classification) {
  return classification.slice(0, 8).map((item) => {
    const sample = item.sample || {};
    const detail = sample.detail ? `: ${sample.detail}` : "";
    const symptom = `${item.count} recent ${item.primaryClass} signal(s); latest ${sample.event || "event"} from ${sample.source || "unknown"}${detail}`;
    const evidenceArgs = item.evidence.map((path) => `--evidence=${shellQuote(path)}`);
    const command = [
      "node .harness/scripts/record-failure.mjs",
      `--class=${item.primaryClass}`,
      "--source=session-trace",
      `--symptom=${shellQuote(symptom)}`,
      ...evidenceArgs,
      `--prevention-target=${item.preventionTarget}`,
    ].join(" ");
    return {
      primaryClass: item.primaryClass,
      source: "session-trace",
      symptom,
      evidence: item.evidence,
      preventionTarget: item.preventionTarget,
      command,
    };
  });
}

function nextStepsForRecords(records) {
  if (records.length === 0) {
    return {
      instructions: ["No recent machine-readable failure signals were found; create an explicit record only if the user reported a failure with evidence."],
      commands: [],
    };
  }
  return {
    instructions: [
      "Run the suggested record-failure.mjs command for the failure class that matches the real incident.",
      "Apply the smallest durable prevention artifact, then promote the record with record-failure.mjs --update.",
      "Rerun the failure-record checker before claiming the harness improvement is complete.",
    ],
    commands: [
      ...records.map((record) => record.command),
      "node .harness/scripts/check-failure-records.mjs",
    ],
  };
}

function fixTargets(buckets) {
  const out = [];
  if (buckets.rule > 0) {
    out.push({ file: ".harness/config.json", why: "structural rule lives here; consider tightening" });
    out.push({ file: ".harness/structural-baseline.json", why: "review whether baseline entries should drain" });
  }
  if (buckets.context > 0) {
    out.push({ file: ".harness/docs/golden-principles.md", why: "context gap surfaced via permission denials" });
    out.push({ file: "CLAUDE.md", why: "consider a pointer (not a paste) to relevant doc" });
  }
  if (buckets.tool_skill > 0) {
    out.push({ file: ".claude/skills/", why: "missing skill or wrong skill chosen - write or edit one" });
  }
  if (buckets.architecture > 0) {
    out.push({ file: ".harness/docs/adr/", why: "recurring violation suggests an ADR is needed" });
  }
  if (buckets.prompt > 0) {
    out.push({ file: ".claude/skills/<name>/SKILL.md", why: "prompt ambiguity led the agent astray" });
  }
  return out;
}

async function main() {
  const { window: windowDays, out: outPath, taxonomy } = parseArgs(process.argv.slice(2));
  const taxonomyInfo = preventionTargetsFromTaxonomy({ taxonomy });
  const telemetry = readJsonl(resolve(ROOT, ".harness/telemetry.jsonl"));
  const bypass = readJsonl(resolve(ROOT, ".harness/bypass.log"));
  const recentFailures = summariseFailures(telemetry, bypass, windowDays);
  const recurring = recurringPatterns(recentFailures);
  const classification = classify(recentFailures, recurring);
  const byTaxonomy = taxonomyClassification(recentFailures, taxonomyInfo.targets);
  const suggestedRecords = buildSuggestedRecords(byTaxonomy);
  const targets = fixTargets(classification);
  const fixCommits = gitLogFixes(windowDays);

  const payload = {
    window_days: windowDays,
    recent_failures: recentFailures,
    recurring_patterns: recurring,
    classification,
    policy_source: policySource(),
    taxonomy_source: taxonomyInfo.source,
    taxonomy_classification: byTaxonomy,
    suggested_records: suggestedRecords,
    nextSteps: nextStepsForRecords(suggestedRecords),
    fix_targets: targets,
    recent_fix_commits: fixCommits,
  };
  const text = JSON.stringify(payload, null, 2);
  if (outPath) writeFileSync(resolve(ROOT, outPath), text + "\n");
  else process.stdout.write(text + "\n");
}

main().catch((error) => {
  console.error(`improvement-bundle: ${error.message}`);
  process.exit(1);
});
