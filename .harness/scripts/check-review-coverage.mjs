#!/usr/bin/env node
// check-review-coverage.mjs - validate that structured reviewer pass decisions
// cover the changed files, impacted layers, and high-risk areas they claim.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const TECHNICAL_FILE_RE = /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|tsconfig[^/]*\.json|jsconfig\.json|pyproject\.toml|poetry\.lock|requirements[^/]*\.txt|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Package\.swift|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$/;
const TECHNICAL_CONFIG_RE = /(^|\/)(next|vite|eslint|prettier|tailwind|postcss)\.config\.[cm]?[jt]s$|^\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)\.env\.(example|sample)$/;
const SOURCE_FILE_RE = /\.(cjs|cts|go|jsx|js|kt|kts|mjs|mts|py|rs|swift|tsx|ts)$/;
const SECURITY_AREA_INVARIANTS = new Map([
  ["auth-session", "auth-session-boundary"],
  ["authorization", "authorization"],
  ["secret-handling", "secret-handling"],
  ["input-boundary", "input-validation"],
  ["payment-boundary", "payment-boundary"],
  ["network-boundary", "network-boundary"],
]);

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    json: false,
    strict: false,
    taskId: null,
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--task") opts.taskId = String(argv[++idx] || "").trim() || null;
    else if (arg.startsWith("--task=")) opts.taskId = arg.slice("--task=".length).trim() || null;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = resolve(opts.cwd);
const errors = [];
const warnings = [];
const decisions = [];
let expectedRiskAreaCount = 0;

function rel(path) {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
}

function readJson(path, label = rel(path)) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${label}: invalid JSON (${error.message})`);
    return null;
  }
}

function insideRoot(path) {
  const normalizedRoot = ROOT.endsWith("/") ? ROOT : `${ROOT}/`;
  return path === ROOT || path.startsWith(normalizedRoot);
}

function normalizeProjectPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const abs = resolve(ROOT, text);
  const normalized = insideRoot(abs) ? rel(abs) : text;
  return normalized.replaceAll("\\", "/").replace(/^\.\//, "");
}

function repoLocalPath(value) {
  const text = String(value || "").trim();
  if (!text || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) || text.startsWith("/")) return false;
  const abs = resolve(ROOT, text);
  return insideRoot(abs);
}

function readConfig() {
  const path = resolve(ROOT, ".harness/config.json");
  if (!existsSync(path)) return {};
  return readJson(path, rel(path)) || {};
}

function readFeatureList() {
  const path = resolve(ROOT, ".harness/feature_list.json");
  if (!existsSync(path)) return [];
  const doc = readJson(path, rel(path));
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc?.features)) return doc.features;
  warnings.push(`${rel(path)}: no features[] array found; review coverage can only inspect discovered contracts`);
  return [];
}

function isHarnessProofArtifact(file) {
  return (
    file === ".harness/feature_list.json" ||
    file === ".harness/PROGRESS.md" ||
    file === ".harness/compaction-snapshot.json" ||
    file === ".harness/bypass.log" ||
    file === ".harness/bypass-audit.json" ||
    file.startsWith(".harness/bypass-requests/") ||
    file.startsWith(".harness/evidence/") ||
    file.startsWith(".harness/task-contracts/") ||
    file.startsWith(".harness/reviews/") ||
    file.startsWith(".harness/state/") ||
    file.startsWith(".harness/memory/") ||
    file.startsWith(".harness/project/") ||
    file.startsWith(".harness/failures/records/")
  );
}

function layerForFile(config, file) {
  const normalized = normalizeProjectPath(file);
  const domains = Array.isArray(config.domains) ? config.domains : [];
  for (const domain of domains) {
    const root = normalizeProjectPath(domain?.root || "");
    const layers = Array.isArray(domain?.layers) ? domain.layers : [];
    if (!root || !normalized.startsWith(`${root}/`)) continue;
    const rest = normalized.slice(root.length + 1);
    const first = rest.split("/")[0] || "";
    return {
      domain: domain.name || "default",
      layer: layers.includes(first) ? first : "",
      file: normalized,
    };
  }
  return null;
}

function isReviewCoverageFile(config, file) {
  const normalized = normalizeProjectPath(file);
  if (!normalized || isHarnessProofArtifact(normalized)) return false;
  const layer = layerForFile(config, normalized);
  if (layer) return true;
  return SOURCE_FILE_RE.test(normalized) || TECHNICAL_FILE_RE.test(normalized) || TECHNICAL_CONFIG_RE.test(normalized);
}

function changedReviewCoverageFiles(config, evidence) {
  const seen = new Set();
  const files = [];
  for (const file of evidence?.changedFiles || []) {
    const normalized = normalizeProjectPath(file);
    if (!normalized || !isReviewCoverageFile(config, normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    files.push(normalized);
  }
  files.sort();
  return files;
}

function sameSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const set = new Set(actual);
  return expected.every((item) => set.has(item));
}

function uniqueNormalizedStrings(items) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeProjectPath(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  out.sort();
  return out;
}

function uniqueCoverageStrings(config, items) {
  return uniqueNormalizedStrings(items).filter((file) => isReviewCoverageFile(config, file));
}

function loadReviewDecision(evidenceReviewer, evidencePath, idx) {
  if (evidenceReviewer?.reviewDecision) return evidenceReviewer.reviewDecision;
  const artifact = String(evidenceReviewer?.artifact || "").trim();
  if (!artifact) return null;
  const prefix = `${rel(evidencePath)}: reviewers[${idx}].artifact`;
  if (!repoLocalPath(artifact)) {
    errors.push(`${prefix} must be a repo-local JSON path`);
    return null;
  }
  if (!artifact.endsWith(".json")) {
    errors.push(`${prefix} must point to a JSON review decision artifact`);
    return null;
  }
  const artifactPath = resolve(ROOT, artifact);
  if (!existsSync(artifactPath)) {
    errors.push(`${prefix} not found: ${artifact}`);
    return null;
  }
  return readJson(artifactPath, rel(artifactPath));
}

function securityRiskAreasForFile(file) {
  const normalized = file.toLowerCase();
  const areas = [];
  if (/(^|\/)(auth|session|oauth|login|signup|password|jwt|token)(\/|\.|-|_)/.test(normalized)) areas.push("auth-session");
  if (/(^|\/)(rbac|acl|permission|permissions|policy|policies|authorize|authorization)(\/|\.|-|_)/.test(normalized)) areas.push("authorization");
  if (/(secret|credential|api[-_]?key|private[-_]?key|\.env|env\.|vault)/.test(normalized)) areas.push("secret-handling");
  if (/(^|\/)(api|route|routes|controller|controllers|handler|handlers|form|forms|schema|schemas|validator|validators|request|body)(\/|\.|-|_)/.test(normalized)) areas.push("input-boundary");
  if (/(stripe|payment|payments|billing|checkout|subscription|invoice)/.test(normalized)) areas.push("payment-boundary");
  if (/(webhook|fetch|http|network|client|provider|providers|integration|integrations)/.test(normalized)) areas.push("network-boundary");
  return areas;
}

function expectedSecurityRiskAreas(files) {
  const byArea = new Map();
  for (const file of files) {
    for (const area of securityRiskAreasForFile(file)) {
      const current = byArea.get(area) || [];
      current.push(file);
      byArea.set(area, current);
    }
  }
  return byArea;
}

function impactedLayers(config, files) {
  const layers = new Map();
  for (const file of files) {
    const layer = layerForFile(config, file);
    if (!layer?.layer) continue;
    const key = `${layer.domain}:${layer.layer}`;
    if (!layers.has(key)) layers.set(key, { ...layer, files: [] });
    layers.get(key).files.push(file);
  }
  return layers;
}

function validateDecisionShape(decision, label) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    errors.push(`${label}: reviewDecision must be an object`);
    return false;
  }
  if (decision.decision !== "pass") return true;
  if (!Array.isArray(decision.checkedFiles) || decision.checkedFiles.length === 0) {
    errors.push(`${label}: pass decision must include checkedFiles`);
  }
  if (!Array.isArray(decision.checkedInvariants) || decision.checkedInvariants.length === 0) {
    errors.push(`${label}: pass decision must include checkedInvariants`);
  }
  if (typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    errors.push(`${label}: pass decision confidence must be a number between 0 and 1`);
  }
  if (Array.isArray(decision.unreviewedRiskAreas) && decision.unreviewedRiskAreas.length > 0) {
    errors.push(`${label}: pass decision cannot include unreviewedRiskAreas`);
  }
  if (!decision.diffCoverage || typeof decision.diffCoverage !== "object" || Array.isArray(decision.diffCoverage)) {
    errors.push(`${label}: pass decision must include diffCoverage`);
  } else {
    for (const field of ["changedFiles", "reviewedFiles", "uncoveredFiles"]) {
      if (!Array.isArray(decision.diffCoverage[field])) {
        errors.push(`${label}: diffCoverage.${field} must be an array`);
      }
    }
  }
  return true;
}

function validateDiffCoverage({ label, config, decision, expectedChangedFiles, checkedFiles }) {
  const coverage = decision.diffCoverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) return;
  const declaredChanged = uniqueCoverageStrings(config, coverage.changedFiles);
  const reviewed = uniqueCoverageStrings(config, coverage.reviewedFiles);
  const uncovered = uniqueCoverageStrings(config, coverage.uncoveredFiles);
  const checked = new Set(checkedFiles);

  if (expectedChangedFiles.length > 0 && !sameSet(declaredChanged, expectedChangedFiles)) {
    errors.push(`${label}: diffCoverage.changedFiles must match evidence changed source/config files: ${expectedChangedFiles.join(", ")}`);
  }
  for (const file of reviewed) {
    if (!expectedChangedFiles.includes(file)) {
      errors.push(`${label}: diffCoverage.reviewedFiles contains file not in changed coverage set: ${file}`);
    }
    if (!checked.has(file)) {
      errors.push(`${label}: diffCoverage.reviewedFiles must be included in checkedFiles: ${file}`);
    }
  }
  const expectedUncovered = expectedChangedFiles.filter((file) => !reviewed.includes(file));
  if (!sameSet(uncovered, expectedUncovered)) {
    errors.push(`${label}: diffCoverage.uncoveredFiles must be changed files not in reviewedFiles: ${expectedUncovered.join(", ") || "(none)"}`);
  }
  const expectedCoverage = expectedChangedFiles.length === 0
    ? 1
    : reviewed.filter((file) => expectedChangedFiles.includes(file)).length / expectedChangedFiles.length;
  if (typeof coverage.coverage !== "number" || Math.abs(coverage.coverage - expectedCoverage) > 0.01) {
    errors.push(`${label}: diffCoverage.coverage must equal reviewed/changed ratio ${expectedCoverage.toFixed(2)}`);
  }
}

function validateSecurityCoverage({ label, decision, expectedChangedFiles, checkedFiles }) {
  if (decision.reviewer !== "security-reviewer") return;
  const riskAreas = expectedSecurityRiskAreas(expectedChangedFiles);
  expectedRiskAreaCount += riskAreas.size;
  const checked = new Set(checkedFiles);
  const invariants = new Set(Array.isArray(decision.checkedInvariants) ? decision.checkedInvariants : []);
  for (const [area, files] of riskAreas) {
    const invariant = SECURITY_AREA_INVARIANTS.get(area);
    if (invariant && !invariants.has(invariant)) {
      errors.push(`${label}: security-reviewer must include checkedInvariants "${invariant}" for ${area}`);
    }
    if (!files.some((file) => checked.has(file))) {
      errors.push(`${label}: security-reviewer must check at least one ${area} changed file: ${files.join(", ")}`);
    }
  }
}

function validateArchitectureCoverage({ label, config, contract, decision, expectedChangedFiles, checkedFiles }) {
  if (decision.reviewer !== "architecture-reviewer") return;
  const layers = impactedLayers(config, expectedChangedFiles);
  if (layers.size === 0) return;
  const invariants = new Set(Array.isArray(decision.checkedInvariants) ? decision.checkedInvariants : []);
  if (!invariants.has("layering") && !invariants.has("allowed-layers")) {
    errors.push(`${label}: architecture-reviewer must include checkedInvariants "layering" or "allowed-layers"`);
  }
  const checkedLayers = impactedLayers(config, checkedFiles);
  const missing = [...layers.keys()].filter((key) => !checkedLayers.has(key));
  if (missing.length === 0) return;
  if (typeof decision.confidence === "number" && decision.confidence > 0.6) {
    errors.push(`${label}: architecture-reviewer confidence must be <= 0.6 when impacted layers are skipped: ${missing.join(", ")}`);
  }
  if (contract?.riskTier === "high-risk" && decision.decision === "pass") {
    errors.push(`${label}: high-risk architecture pass must inspect every impacted layer: ${missing.join(", ")}`);
  }
}

function validateReviewerDecision({ config, contract, evidence, evidencePath, reviewerName, decision }) {
  const label = `${rel(evidencePath)}: reviewer "${reviewerName}"`;
  if (!validateDecisionShape(decision, label) || decision?.decision !== "pass") return;
  decisions.push({ reviewer: reviewerName, taskId: contract?.id || evidence?.taskId || "", decision });
  if (decision.reviewer && decision.reviewer !== reviewerName) {
    errors.push(`${label}: decision reviewer "${decision.reviewer}" must match evidence reviewer`);
  }
  if (contract?.id && decision.taskId !== contract.id) {
    errors.push(`${label}: taskId "${decision.taskId || ""}" must match contract id "${contract.id}"`);
  }
  const expectedChangedFiles = changedReviewCoverageFiles(config, evidence);
  const checkedFiles = uniqueNormalizedStrings(decision.checkedFiles);
  validateDiffCoverage({ label, config, decision, expectedChangedFiles, checkedFiles });
  if (contract?.riskTier === "high-risk" && decision.confidence < 0.75) {
    errors.push(`${label}: high-risk pass confidence must be at least 0.75`);
  }
  validateSecurityCoverage({ label, decision, expectedChangedFiles, checkedFiles });
  validateArchitectureCoverage({ label, config, contract, decision, expectedChangedFiles, checkedFiles });
}

function validateAggregateCoverage({ config, contract, evidence, evidencePath, passedDecisions }) {
  const expectedChangedFiles = changedReviewCoverageFiles(config, evidence);
  if (expectedChangedFiles.length === 0 || passedDecisions.length === 0) return;
  const covered = new Set();
  for (const decision of passedDecisions) {
    for (const file of uniqueNormalizedStrings(decision.checkedFiles)) {
      if (expectedChangedFiles.includes(file)) covered.add(file);
    }
  }
  const missing = expectedChangedFiles.filter((file) => !covered.has(file));
  if (missing.length > 0) {
    errors.push(`${rel(evidencePath)}: required reviewer checkedFiles must cover changed source/config file(s): ${missing.join(", ")}`);
  }
  if (contract?.riskTier === "high-risk" && passedDecisions.some((decision) => Array.isArray(decision.unreviewedRiskAreas) && decision.unreviewedRiskAreas.length > 0)) {
    errors.push(`${rel(evidencePath)}: high-risk pass cannot carry unreviewed risk areas`);
  }
}

function discoverTaskRecords(config) {
  const records = [];
  const features = readFeatureList();
  for (const feature of features) {
    const taskId = String(feature?.id || "");
    const contractPath = feature?.taskContractPath ? resolve(ROOT, feature.taskContractPath) : null;
    const evidencePath = feature?.evidencePath ? resolve(ROOT, feature.evidencePath) : null;
    if (opts.taskId && opts.taskId !== taskId) continue;
    if (!contractPath || !evidencePath) continue;
    records.push({
      taskId,
      contractPath,
      evidencePath,
      requireEvidence: feature?.passes === true || Boolean(opts.taskId),
    });
  }
  if (records.length > 0) return records;

  const contractsDir = resolve(ROOT, config.taskContracts?.contractsDir || ".harness/task-contracts");
  const evidenceDir = resolve(ROOT, config.taskContracts?.evidenceDir || ".harness/evidence");
  if (!existsSync(contractsDir) || !existsSync(evidenceDir)) return records;
  for (const name of listJsonFiles(contractsDir)) {
    if (!name.endsWith(".json")) continue;
    const taskId = name.replace(/\.json$/, "");
    if (opts.taskId && opts.taskId !== taskId) continue;
    records.push({
      taskId,
      contractPath: resolve(contractsDir, name),
      evidencePath: resolve(evidenceDir, name),
      requireEvidence: Boolean(opts.taskId),
    });
  }
  return records;
}

function listJsonFiles(dir) {
  try {
    return existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

function validateTaskRecord(config, record) {
  if (!existsSync(record.contractPath)) {
    if (record.requireEvidence) errors.push(`${rel(record.contractPath)}: task contract not found`);
    return false;
  }
  if (!existsSync(record.evidencePath)) {
    if (record.requireEvidence) errors.push(`${rel(record.evidencePath)}: evidence bundle not found`);
    return false;
  }
  const contract = readJson(record.contractPath, rel(record.contractPath));
  const evidence = readJson(record.evidencePath, rel(record.evidencePath));
  if (!contract || !evidence) return false;
  if (!Array.isArray(contract.doneRequires) || !contract.doneRequires.includes("review")) return false;
  const requiredReviewers = Array.isArray(contract.requiredReviewers) ? contract.requiredReviewers : [];
  const evidenceReviewers = Array.isArray(evidence.reviewers) ? evidence.reviewers : [];
  const passedDecisions = [];
  for (const required of requiredReviewers) {
    const idx = evidenceReviewers.findIndex((reviewer) => reviewer?.name === required);
    const item = idx >= 0 ? evidenceReviewers[idx] : null;
    if (!item || item.decision !== "pass") {
      errors.push(`${rel(record.evidencePath)}: reviewer "${required}" must have decision=pass`);
      continue;
    }
    const decision = loadReviewDecision(item, record.evidencePath, idx);
    if (!decision) {
      errors.push(`${rel(record.evidencePath)}: reviewer "${required}" must include reviewDecision or artifact`);
      continue;
    }
    validateReviewerDecision({ config, contract, evidence, evidencePath: record.evidencePath, reviewerName: required, decision });
    if (decision.decision === "pass") passedDecisions.push(decision);
  }
  validateAggregateCoverage({ config, contract, evidence, evidencePath: record.evidencePath, passedDecisions });
  return true;
}

function main() {
  const config = readConfig();
  const records = discoverTaskRecords(config);
  if (opts.taskId && records.length === 0) {
    errors.push(`task "${opts.taskId}" not found in feature list or task contract directory`);
  }
  for (const record of records) validateTaskRecord(config, record);

  const payload = {
    status: errors.length > 0 ? "fail" : "pass",
    taskCount: records.length,
    decisionCount: decisions.length,
    expectedRiskAreaCount,
    errors,
    warnings,
  };
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (errors.length > 0) {
    for (const error of errors) console.error(error);
    for (const warning of warnings) console.error(`warning: ${warning}`);
  } else {
    console.log(`review-coverage: OK (${records.length} task(s), ${decisions.length} pass decision(s), ${expectedRiskAreaCount} expected risk area(s))`);
    for (const warning of warnings) console.error(`warning: ${warning}`);
  }
  process.exit(errors.length > 0 ? 1 : 0);
}

main();
