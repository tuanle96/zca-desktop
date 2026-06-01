#!/usr/bin/env node
// policy-pack-publish.mjs - create a safe dry-run publish plan for reusable
// policy packs. Real registry upload is intentionally not implemented yet; the
// dry-run artifact is the reviewable contract for third-party distribution.

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const ALLOWED_DOCS = new Set(["README.md", "LICENSE", "LICENSE.md"]);

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    pack: "",
    packsDir: "",
    dryRun: false,
    json: false,
    examples: true,
  };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--no-examples") opts.examples = false;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--pack=")) opts.pack = arg.slice("--pack=".length).trim();
    else if (arg.startsWith("--packs-dir=")) opts.packsDir = arg.slice("--packs-dir=".length).trim();
  }
  opts.cwd = resolve(opts.cwd);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = opts.cwd;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

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

function readJson(path, errors, label = rel(path)) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${label}: invalid JSON (${error.message})`);
    return null;
  }
}

function readConfig() {
  for (const candidate of [".harness/config.json", "harness.config.json"]) {
    const path = resolve(ROOT, candidate);
    if (!existsSync(path)) continue;
    const errors = [];
    const parsed = readJson(path, errors, rel(path));
    return parsed && typeof parsed === "object" ? parsed : {};
  }
  return {};
}

function defaultPacksDir(config) {
  if (opts.packsDir) return opts.packsDir;
  if (existsSync(resolve(ROOT, "src/templates/.harness/policy-packs"))) {
    return "src/templates/.harness/policy-packs";
  }
  return config.policyPacks?.packsDir || ".harness/policy-packs";
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      out.push({ path, symlink: true });
      continue;
    }
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (entry.isFile()) out.push({ path, stat });
  }
  return out;
}

function fileKind(relInPack, referencedRules) {
  if (relInPack === "pack.json") return "manifest";
  if (ALLOWED_DOCS.has(relInPack)) return "doc";
  if (/^fitness-rules\/[a-z0-9][a-z0-9._-]*\.json$/.test(relInPack)) {
    return referencedRules.has(relInPack) ? "fitness-rule" : "unreferenced-fitness-rule";
  }
  return "unsupported";
}

function validateWithChecker({ packsDir, packId }) {
  const checker = resolve(SCRIPT_DIR, "check-policy-packs.mjs");
  const args = [
    checker,
    `--cwd=${ROOT}`,
    `--packs-dir=${packsDir}`,
    `--pack=${packId}`,
    "--json",
  ];
  if (!opts.examples) args.push("--no-examples");
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout || "{}");
  } catch {
    payload = null;
  }
  return {
    status: result.status === 0 ? "pass" : "fail",
    exitCode: result.status,
    payload,
    stderr: result.stderr.trim(),
  };
}

function buildPlan() {
  const errors = [];
  const warnings = [];
  const config = readConfig();
  const packsDir = defaultPacksDir(config);

  if (!opts.dryRun) {
    errors.push("real policy pack publish is not implemented yet; rerun with --dry-run to create a reviewable publish plan");
  }
  if (!opts.pack) errors.push("--pack is required");
  if (opts.pack.includes(",")) errors.push("publish accepts exactly one --pack id");
  if (opts.pack && !STABLE_ID_RE.test(opts.pack)) errors.push(`--pack must be a stable lowercase id: ${opts.pack}`);
  if (!isSafeLocalPath(packsDir)) errors.push(`--packs-dir must be a safe repo-local path: ${packsDir}`);

  const absPacksDir = resolve(ROOT, packsDir);
  const packDir = resolve(absPacksDir, opts.pack || "");
  const packPath = resolve(packDir, "pack.json");
  if (errors.length === 0 && !existsSync(packPath)) errors.push(`${rel(packPath)}: pack.json not found`);

  let validation = null;
  let pack = null;
  if (errors.length === 0) {
    validation = validateWithChecker({ packsDir, packId: opts.pack });
    if (validation.status !== "pass") {
      errors.push(`${opts.pack}: policy pack validation failed`);
      for (const error of validation.payload?.errors || []) errors.push(error);
      if (validation.stderr) errors.push(validation.stderr);
    }
    pack = readJson(packPath, errors, rel(packPath));
  }

  const files = [];
  if (errors.length === 0 && pack) {
    const referencedRules = new Set((pack.fitnessRules || []).map((rule) => normalizeRel(rule.path)));
    let totalBytes = 0;
    for (const item of walkFiles(packDir)) {
      const relInPack = normalizeRel(relative(packDir, item.path));
      if (item.symlink) {
        errors.push(`${rel(item.path)}: symlinks are not allowed in publishable policy packs`);
        continue;
      }
      const kind = fileKind(relInPack, referencedRules);
      if (kind === "unsupported") {
        errors.push(`${rel(item.path)}: unsupported publish file; allowed files are pack.json, README.md, LICENSE, LICENSE.md, and referenced fitness-rules/*.json`);
        continue;
      }
      if (kind === "unreferenced-fitness-rule") {
        errors.push(`${rel(item.path)}: fitness rule file is not referenced by pack.json`);
        continue;
      }
      if (item.stat.size > MAX_FILE_BYTES) {
        errors.push(`${rel(item.path)}: file exceeds ${MAX_FILE_BYTES} byte publish limit`);
      }
      totalBytes += item.stat.size;
      files.push({
        path: rel(item.path),
        packPath: relInPack,
        kind,
        bytes: item.stat.size,
        sha256: sha256(item.path),
      });
    }
    if (totalBytes > MAX_TOTAL_BYTES) errors.push(`${opts.pack}: publish bundle exceeds ${MAX_TOTAL_BYTES} byte total limit`);
    const publishedKinds = new Set(files.map((file) => file.kind));
    if (!publishedKinds.has("manifest")) errors.push(`${opts.pack}: publish bundle must include pack.json`);
    if ((pack.fitnessRules || []).length !== files.filter((file) => file.kind === "fitness-rule").length) {
      errors.push(`${opts.pack}: every manifest fitness rule must be included exactly once`);
    }
  }

  return {
    schemaVersion: 1,
    status: errors.length === 0 ? "planned" : "failed",
    dryRun: opts.dryRun,
    publishImplemented: false,
    packsDir,
    pack: pack
      ? {
          id: pack.id,
          title: pack.title,
          strictnessDefault: pack.strictnessDefault,
          stacks: pack.stacks,
          fitnessRules: (pack.fitnessRules || []).map((rule) => rule.id),
        }
      : { id: opts.pack || "" },
    files,
    validation,
    safety: {
      allowedFiles: ["pack.json", "README.md", "LICENSE", "LICENSE.md", "fitness-rules/*.json"],
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      realPublishRequiresFutureRegistry: true,
    },
    errors,
    warnings,
  };
}

const payload = buildPlan();

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2));
} else if (payload.status === "planned") {
  console.log(`policy pack publish: DRY RUN (${payload.pack.id})`);
  console.log(`files: ${payload.files.length}`);
  console.log("No registry upload was attempted.");
} else {
  console.error("policy pack publish: FAILED");
  for (const error of payload.errors) console.error(`- ${error}`);
  for (const warning of payload.warnings) console.error(`warning: ${warning}`);
}

process.exit(payload.status === "planned" ? 0 : 1);
