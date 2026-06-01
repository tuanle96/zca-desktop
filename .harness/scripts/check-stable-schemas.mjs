#!/usr/bin/env node
// check-stable-schemas.mjs - validate the schema compatibility policy that
// keeps durable harness records readable across upgrades.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const STABLE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MIN_DEPRECATION_DAYS = 90;
const MIN_DEPRECATION_RELEASES = 2;

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    policy: "",
    schemasDir: "",
    changelog: "CHANGELOG.md",
    json: false,
    strict: false,
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--policy=")) opts.policy = arg.slice("--policy=".length).trim();
    else if (arg.startsWith("--schemas-dir=")) opts.schemasDir = arg.slice("--schemas-dir=".length).trim();
    else if (arg.startsWith("--changelog=")) opts.changelog = arg.slice("--changelog=".length).trim();
  }
  opts.cwd = resolve(opts.cwd);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = opts.cwd;
const errors = [];
const warnings = [];

function rel(path) {
  return relative(ROOT, path).replaceAll("\\", "/") || ".";
}

function normalizeRel(path) {
  return String(path || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function insideRoot(path) {
  const root = ROOT.endsWith("/") ? ROOT : `${ROOT}/`;
  return path === ROOT || path.startsWith(root);
}

function isSafeLocalPath(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return false;
  const normalized = normalizeRel(text);
  if (normalized.split("/").includes("..")) return false;
  return insideRoot(resolve(ROOT, text));
}

function readJson(path, label = rel(path)) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${label}: invalid JSON (${error.message})`);
    return null;
  }
}

function readPackageJson() {
  const path = resolve(ROOT, "package.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function defaultPolicyPath() {
  if (opts.policy) return opts.policy;
  if (existsSync(resolve(ROOT, "src/templates/.harness/schema-policy.json"))) {
    return "src/templates/.harness/schema-policy.json";
  }
  return ".harness/schema-policy.json";
}

function defaultSchemasDir(policyPath) {
  if (opts.schemasDir) return opts.schemasDir;
  if (policyPath.includes("src/templates/.harness/")) return "src/templates/.harness/schemas";
  return ".harness/schemas";
}

function resolveSchemaPath(schemaPath, schemasDir) {
  const normalized = normalizeRel(schemaPath);
  const schemaName = basename(normalized);
  const direct = resolve(ROOT, normalized);
  if (existsSync(direct)) return direct;
  return resolve(ROOT, schemasDir, schemaName);
}

function requireStableId(value, label) {
  if (!STABLE_ID_RE.test(String(value || ""))) errors.push(`${label} must be a stable lowercase id`);
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") errors.push(`${label} must be boolean`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${label} must be a non-empty string`);
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) errors.push(`${label} must be a positive integer`);
}

function validatePolicyShape(policy, policySource) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    errors.push(`${policySource}: policy must be an object`);
    return [];
  }
  if (policy.schemaVersion !== 1) errors.push(`${policySource}: schemaVersion must be 1`);
  requirePositiveInteger(policy.policyVersion, `${policySource}: policyVersion`);
  if (!["pre-1.0-stable", "stable"].includes(String(policy.status || ""))) {
    errors.push(`${policySource}: status must be pre-1.0-stable or stable`);
  }

  requirePositiveInteger(policy.versioning?.currentCompatibilityMajor, `${policySource}: versioning.currentCompatibilityMajor`);
  if (!Array.isArray(policy.versioning?.compatibleChanges) || policy.versioning.compatibleChanges.length === 0) {
    errors.push(`${policySource}: versioning.compatibleChanges must be a non-empty array`);
  }
  if (!Array.isArray(policy.versioning?.breakingChanges) || policy.versioning.breakingChanges.length === 0) {
    errors.push(`${policySource}: versioning.breakingChanges must be a non-empty array`);
  }

  if (policy.migration?.requiredForBreakingChanges !== true) {
    errors.push(`${policySource}: migration.requiredForBreakingChanges must be true`);
  }
  if (policy.migration?.mustPreserveReadability !== true) {
    errors.push(`${policySource}: migration.mustPreserveReadability must be true`);
  }
  if (policy.migration?.rollbackRequired !== true) {
    errors.push(`${policySource}: migration.rollbackRequired must be true`);
  }
  requireString(policy.migration?.migrationDir, `${policySource}: migration.migrationDir`);

  if (!Number.isInteger(policy.deprecation?.minimumNoticeDays) || policy.deprecation.minimumNoticeDays < MIN_DEPRECATION_DAYS) {
    errors.push(`${policySource}: deprecation.minimumNoticeDays must be at least ${MIN_DEPRECATION_DAYS}`);
  }
  if (!Number.isInteger(policy.deprecation?.minimumMinorReleases) || policy.deprecation.minimumMinorReleases < MIN_DEPRECATION_RELEASES) {
    errors.push(`${policySource}: deprecation.minimumMinorReleases must be at least ${MIN_DEPRECATION_RELEASES}`);
  }
  if (policy.deprecation?.removalRequiresMajor !== true) {
    errors.push(`${policySource}: deprecation.removalRequiresMajor must be true`);
  }

  requireString(policy.changelog?.requiredSection, `${policySource}: changelog.requiredSection`);
  if (!Array.isArray(policy.changelog?.breakingChangeLabels) || policy.changelog.breakingChangeLabels.length === 0) {
    errors.push(`${policySource}: changelog.breakingChangeLabels must be a non-empty array`);
  }

  if (!Array.isArray(policy.schemas) || policy.schemas.length === 0) {
    errors.push(`${policySource}: schemas must be a non-empty array`);
    return [];
  }
  return policy.schemas;
}

function validateSchemaEntry(entry, idx, schemasDir) {
  const prefix = `schema-policy.schemas[${idx}]`;
  requireStableId(entry?.id, `${prefix}.id`);
  requireString(entry?.artifact, `${prefix}.artifact`);
  requirePositiveInteger(entry?.currentVersion, `${prefix}.currentVersion`);
  requirePositiveInteger(entry?.minimumReadableVersion, `${prefix}.minimumReadableVersion`);
  requireBoolean(entry?.migrationRequiredForBreaking, `${prefix}.migrationRequiredForBreaking`);
  requireBoolean(entry?.requiresArtifactSchemaVersion, `${prefix}.requiresArtifactSchemaVersion`);
  if (entry?.migrationRequiredForBreaking !== true) {
    errors.push(`${prefix}.migrationRequiredForBreaking must be true`);
  }
  if (!Number.isInteger(entry?.deprecationNoticeDays) || entry.deprecationNoticeDays < MIN_DEPRECATION_DAYS) {
    errors.push(`${prefix}.deprecationNoticeDays must be at least ${MIN_DEPRECATION_DAYS}`);
  }
  if (entry?.minimumReadableVersion > entry?.currentVersion) {
    errors.push(`${prefix}.minimumReadableVersion cannot exceed currentVersion`);
  }
  if (entry?.requiresArtifactSchemaVersion === false && !entry?.legacyReason) {
    errors.push(`${prefix}.legacyReason is required when requiresArtifactSchemaVersion is false`);
  }
  if (!isSafeLocalPath(entry?.path)) {
    errors.push(`${prefix}.path must be a safe repo-local schema path`);
    return null;
  }
  const resolved = resolveSchemaPath(entry.path, schemasDir);
  if (!insideRoot(resolved)) {
    errors.push(`${prefix}.path must resolve inside the project root`);
    return null;
  }
  if (!existsSync(resolved)) {
    errors.push(`${entry.path}: schema file not found`);
    return null;
  }
  const schema = readJson(resolved, rel(resolved));
  if (!schema) return null;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const artifactVersion = schema.properties?.schemaVersion?.const;
  if (entry.requiresArtifactSchemaVersion) {
    if (!required.includes("schemaVersion")) errors.push(`${rel(resolved)}: schemaVersion must be required by policy ${entry.id}`);
    if (artifactVersion !== entry.currentVersion) {
      errors.push(`${rel(resolved)}: schemaVersion const ${artifactVersion ?? "(missing)"} must equal policy currentVersion ${entry.currentVersion}`);
    }
  } else if (artifactVersion !== undefined && artifactVersion !== entry.currentVersion) {
    errors.push(`${rel(resolved)}: optional schemaVersion const must equal policy currentVersion ${entry.currentVersion}`);
  }
  return {
    id: entry.id,
    path: rel(resolved),
    currentVersion: entry.currentVersion,
    minimumReadableVersion: entry.minimumReadableVersion,
    requiresArtifactSchemaVersion: entry.requiresArtifactSchemaVersion,
  };
}

function discoverSchemaFiles(schemasDir) {
  const dir = resolve(ROOT, schemasDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".schema.json"))
    .map((entry) => rel(join(dir, entry.name)))
    .sort();
}

function unreleasedSection(changelogText) {
  const match = changelogText.match(/^## Unreleased\s*([\s\S]*?)(?=^## \[|^## [^\n]+|$)/m);
  return match ? match[1] : "";
}

function validateChangelog(policy) {
  const pkg = readPackageJson();
  const changelogPath = resolve(ROOT, opts.changelog);
  const shouldRequire = policy.changelog?.requiredForPackageRelease === true &&
    (pkg.name === "agent-harness-kit" || existsSync(changelogPath));
  if (!shouldRequire) return { checked: false, path: rel(changelogPath) };
  if (!existsSync(changelogPath)) {
    errors.push(`${rel(changelogPath)}: changelog is required for package schema compatibility policy`);
    return { checked: true, path: rel(changelogPath) };
  }
  const text = readFileSync(changelogPath, "utf8");
  const section = unreleasedSection(text);
  if (!section) {
    errors.push(`${rel(changelogPath)}: missing Unreleased section for schema compatibility notes`);
    return { checked: true, path: rel(changelogPath) };
  }
  const required = String(policy.changelog.requiredSection || "");
  const heading = new RegExp(`^###\\s+${required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  if (!heading.test(section)) {
    errors.push(`${rel(changelogPath)}: Unreleased must include "### ${required}"`);
  }
  return { checked: true, path: rel(changelogPath), requiredSection: required };
}

function main() {
  const policyRel = defaultPolicyPath();
  if (!isSafeLocalPath(policyRel)) errors.push(`--policy must be a safe repo-local path: ${policyRel}`);
  const policyPath = resolve(ROOT, policyRel);
  if (!existsSync(policyPath)) errors.push(`${rel(policyPath)}: schema policy not found`);
  const schemasDir = defaultSchemasDir(policyRel);
  if (!isSafeLocalPath(schemasDir)) errors.push(`--schemas-dir must be a safe repo-local path: ${schemasDir}`);
  if (errors.length > 0) return emit(null, schemasDir, []);

  const policy = readJson(policyPath, rel(policyPath));
  const entries = validatePolicyShape(policy, rel(policyPath));
  const seenIds = new Set();
  const seenPaths = new Set();
  const schemas = [];
  for (const [idx, entry] of entries.entries()) {
    if (seenIds.has(entry?.id)) errors.push(`schema-policy.schemas[${idx}].id duplicates ${entry.id}`);
    seenIds.add(entry?.id);
    const normalizedPath = normalizeRel(entry?.path);
    if (seenPaths.has(normalizedPath)) errors.push(`schema-policy.schemas[${idx}].path duplicates ${normalizedPath}`);
    seenPaths.add(normalizedPath);
    const validated = validateSchemaEntry(entry, idx, schemasDir);
    if (validated) schemas.push(validated);
  }

  const actualSchemas = discoverSchemaFiles(schemasDir);
  const listedBasenames = new Set(entries.map((entry) => basename(normalizeRel(entry?.path))));
  for (const schemaPath of actualSchemas) {
    if (!listedBasenames.has(basename(schemaPath))) {
      errors.push(`${schemaPath}: schema file is not listed in ${rel(policyPath)}`);
    }
  }
  const changelog = validateChangelog(policy || {});
  emit(policy, schemasDir, schemas, actualSchemas, changelog);
}

function emit(policy, schemasDir, schemas = [], actualSchemas = [], changelog = null) {
  const payload = {
    status: errors.length === 0 ? "pass" : "fail",
    policy: policy ? {
      schemaVersion: policy.schemaVersion,
      policyVersion: policy.policyVersion,
      status: policy.status,
    } : null,
    schemasDir,
    schemas,
    discoveredSchemas: actualSchemas,
    changelog,
    errors,
    warnings,
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (payload.status === "pass") {
    console.log(`stable schemas: OK (${schemas.length} schema contract(s))`);
    for (const warning of warnings) console.error(`warning: ${warning}`);
  } else {
    console.error("stable schemas: FAILED");
    for (const error of errors) console.error(`- ${error}`);
    for (const warning of warnings) console.error(`warning: ${warning}`);
  }
  process.exit(payload.status === "pass" ? 0 : 1);
}

main();
