#!/usr/bin/env node
// check-architecture-fitness.mjs - deterministic architecture fitness rule
// loader/checker. Rules are repo-local JSON files so projects can add domain
// invariants without editing this script.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const STABLE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SOURCE_EXT_RE = /\.(cjs|cts|go|jsx|js|kt|kts|mjs|mts|py|rs|swift|tsx|ts)$/;
const DEFAULT_IGNORES = [
  ".git/**",
  ".harness/evidence/**",
  ".harness/reviews/**",
  ".harness/state/**",
  ".harness/upgrades/**",
  "coverage/**",
  "dist/**",
  "build/**",
  ".next/**",
  "node_modules/**",
  "vendor/**",
];

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    examples: true,
    examplesOnly: false,
    json: false,
    rule: "",
    rulesDir: "",
    strict: false,
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--no-examples") opts.examples = false;
    else if (arg === "--examples-only") opts.examplesOnly = true;
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg.startsWith("--rule=")) opts.rule = arg.slice("--rule=".length).trim();
    else if (arg.startsWith("--rules-dir=")) opts.rulesDir = arg.slice("--rules-dir=".length).trim();
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
  const normalizedRoot = ROOT.endsWith("/") ? ROOT : `${ROOT}/`;
  return path === ROOT || path.startsWith(normalizedRoot);
}

function isSafeLocalPath(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return false;
  const abs = resolve(ROOT, text);
  return insideRoot(abs) && !normalizeRel(text).split("/").includes("..");
}

function assertSafeGlob(pattern, label) {
  const text = String(pattern || "").trim();
  if (!text) {
    errors.push(`${label}: glob must be a non-empty string`);
    return false;
  }
  if (text.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) || normalizeRel(text).split("/").includes("..")) {
    errors.push(`${label}: glob must be repo-local and cannot contain ..`);
    return false;
  }
  return true;
}

function readJson(path, label = rel(path)) {
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
    const parsed = readJson(path, rel(path));
    return parsed && typeof parsed === "object" ? parsed : {};
  }
  return {};
}

function escapeRegexChar(char) {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(pattern) {
  let out = "";
  for (let idx = 0; idx < pattern.length;) {
    const char = pattern[idx];
    if (char === "*") {
      if (pattern[idx + 1] === "*") {
        if (pattern[idx + 2] === "/") {
          out += "(?:.*/)?";
          idx += 3;
        } else {
          out += ".*";
          idx += 2;
        }
      } else {
        out += "[^/]*";
        idx += 1;
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      idx += 1;
      continue;
    }
    if (char === "{") {
      const end = pattern.indexOf("}", idx + 1);
      if (end > idx) {
        const body = pattern.slice(idx + 1, end);
        out += `(?:${body.split(",").map((part) => part.split("").map(escapeRegexChar).join("")).join("|")})`;
        idx = end + 1;
        continue;
      }
    }
    out += escapeRegexChar(char);
    idx += 1;
  }
  return new RegExp(`^${out}$`);
}

function matchesAny(file, patterns) {
  const normalized = normalizeRel(file);
  return patterns.some((pattern) => {
    if (!assertSafeGlob(pattern, pattern)) return false;
    return globToRegExp(normalizeRel(pattern)).test(normalized);
  });
}

function compileRegex(pattern, label) {
  try {
    return new RegExp(pattern);
  } catch (error) {
    errors.push(`${label}: invalid regex (${error.message})`);
    return null;
  }
}

function readRuleFiles(config) {
  const fitness = config.architectureFitness || {};
  if (fitness.enabled === false) return { disabled: true, rules: [] };
  const configuredDir = opts.rulesDir || fitness.rulesDir;
  const defaultDir = existsSync(resolve(ROOT, "src/templates/.harness/fitness/rules"))
    ? "src/templates/.harness/fitness/rules"
    : ".harness/fitness/rules";
  const rulesDir = configuredDir || defaultDir;
  const rules = [];

  if (rulesDir) {
    if (!isSafeLocalPath(rulesDir)) {
      errors.push(`architectureFitness.rulesDir must be a safe repo-local path: ${rulesDir}`);
    } else {
      const absRulesDir = resolve(ROOT, rulesDir);
      if (existsSync(absRulesDir)) {
        for (const entry of readdirSync(absRulesDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const path = join(absRulesDir, entry.name);
          const rule = readJson(path, rel(path));
          if (rule) rules.push({ rule, source: rel(path) });
        }
      } else if (configuredDir) {
        errors.push(`${rulesDir}: architecture fitness rules directory not found`);
      }
    }
  }

  for (const [idx, rule] of (Array.isArray(fitness.rules) ? fitness.rules : []).entries()) {
    rules.push({ rule, source: `.harness/config.json:architectureFitness.rules[${idx}]` });
  }
  for (const [idx, path] of (Array.isArray(fitness.rulePaths) ? fitness.rulePaths : []).entries()) {
    if (!isSafeLocalPath(path)) {
      errors.push(`architectureFitness.rulePaths[${idx}] must be a safe repo-local path: ${path}`);
      continue;
    }
    const abs = resolve(ROOT, path);
    if (!existsSync(abs)) {
      errors.push(`architectureFitness.rulePaths[${idx}] not found: ${path}`);
      continue;
    }
    const rule = readJson(abs, rel(abs));
    if (rule) rules.push({ rule, source: rel(abs) });
  }
  return { disabled: false, rules };
}

function validateRule(entry) {
  const { rule, source } = entry;
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    errors.push(`${source}: rule must be an object`);
    return null;
  }
  const id = String(rule.id || "");
  if (rule.schemaVersion !== 1) errors.push(`${source}: schemaVersion must be 1`);
  if (!STABLE_ID_RE.test(id)) errors.push(`${source}: id must be a stable lowercase id`);
  if (!["forbid-pattern", "forbid-import", "require-pattern"].includes(rule.kind)) {
    errors.push(`${source}: kind must be forbid-pattern, forbid-import, or require-pattern`);
  }
  const severity = rule.severity || "block";
  if (!["block", "warn"].includes(severity)) errors.push(`${source}: severity must be block or warn`);
  if (!STABLE_ID_RE.test(String(rule.owner || ""))) errors.push(`${source}: owner must be a stable reviewer id`);
  if (!STABLE_ID_RE.test(String(rule.failureClass || ""))) errors.push(`${source}: failureClass must be a stable taxonomy id`);
  if (!STABLE_ID_RE.test(String(rule.prevention || ""))) errors.push(`${source}: prevention must be a stable prevention id`);
  const appliesTo = Array.isArray(rule.appliesTo) ? rule.appliesTo : [];
  if (appliesTo.length === 0) errors.push(`${source}: appliesTo must contain at least one glob`);
  appliesTo.forEach((pattern, idx) => assertSafeGlob(pattern, `${source}: appliesTo[${idx}]`));
  (Array.isArray(rule.allowPaths) ? rule.allowPaths : []).forEach((pattern, idx) => assertSafeGlob(pattern, `${source}: allowPaths[${idx}]`));
  const examples = rule.examples || {};
  for (const kind of ["pass", "fail"]) {
    for (const [idx, example] of (Array.isArray(examples[kind]) ? examples[kind] : []).entries()) {
      if (!example || typeof example !== "object" || Array.isArray(example)) {
        errors.push(`${source}: examples.${kind}[${idx}] must be an object`);
        continue;
      }
      assertSafeGlob(example.path, `${source}: examples.${kind}[${idx}].path`);
      if (typeof example.content !== "string") errors.push(`${source}: examples.${kind}[${idx}].content must be a string`);
    }
  }
  return {
    ...rule,
    source,
    severity,
    appliesTo,
    allowPaths: Array.isArray(rule.allowPaths) ? rule.allowPaths : [],
  };
}

function ruleApplies(rule, file) {
  return matchesAny(file, rule.appliesTo) && !matchesAny(file, rule.allowPaths);
}

function finding(rule, file, line, message, evidence) {
  return {
    ruleId: rule.id,
    severity: rule.severity,
    owner: rule.owner,
    failureClass: rule.failureClass,
    prevention: rule.prevention,
    file,
    line,
    message,
    evidence,
  };
}

function evaluateForbidPattern(rule, file, content) {
  const out = [];
  const patterns = Array.isArray(rule.forbiddenPatterns) ? rule.forbiddenPatterns : [];
  for (const [idx, item] of patterns.entries()) {
    const regex = compileRegex(item?.regex, `${rule.source}: forbiddenPatterns[${idx}].regex`);
    if (!regex) continue;
    const message = item?.message || rule.description || `forbidden pattern for ${rule.id}`;
    for (const [lineIdx, line] of content.split(/\r?\n/).entries()) {
      if (regex.test(line)) out.push(finding(rule, file, lineIdx + 1, message, line.trim()));
    }
  }
  return out;
}

function importSpecifiers(content) {
  const specs = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const lines = content.split(/\r?\n/);
  for (const [lineIdx, line] of lines.entries()) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        specs.push({ specifier: match[1], line: lineIdx + 1, raw: line.trim() });
      }
    }
  }
  return specs;
}

function evaluateForbidImport(rule, file, content) {
  const out = [];
  const imports = Array.isArray(rule.forbiddenImports) ? rule.forbiddenImports : [];
  const specs = importSpecifiers(content);
  for (const [idx, item] of imports.entries()) {
    const regex = compileRegex(item?.specifierRegex, `${rule.source}: forbiddenImports[${idx}].specifierRegex`);
    if (!regex) continue;
    const message = item?.message || rule.description || `forbidden import for ${rule.id}`;
    for (const spec of specs) {
      if (regex.test(spec.specifier)) out.push(finding(rule, file, spec.line, message, spec.raw));
    }
  }
  return out;
}

function anyRegexMatch(patterns, content, label) {
  for (const [idx, pattern] of patterns.entries()) {
    const regex = compileRegex(pattern, `${label}[${idx}]`);
    if (regex?.test(content)) return true;
  }
  return false;
}

function evaluateRequirePattern(rule, file, content) {
  const triggerPatterns = Array.isArray(rule.triggerPatterns) ? rule.triggerPatterns : [];
  if (triggerPatterns.length > 0 && !anyRegexMatch(triggerPatterns, content, `${rule.source}: triggerPatterns`)) return [];
  const requiredPatterns = Array.isArray(rule.requiredPatterns) ? rule.requiredPatterns : [];
  if (requiredPatterns.length === 0) {
    errors.push(`${rule.source}: require-pattern rules must define requiredPatterns`);
    return [];
  }
  if (anyRegexMatch(requiredPatterns, content, `${rule.source}: requiredPatterns`)) return [];
  return [finding(rule, file, 1, rule.message || rule.description || `missing required pattern for ${rule.id}`, "required pattern not found")];
}

function evaluateRule(rule, file, content) {
  if (!ruleApplies(rule, file)) return [];
  if (rule.kind === "forbid-pattern") return evaluateForbidPattern(rule, file, content);
  if (rule.kind === "forbid-import") return evaluateForbidImport(rule, file, content);
  if (rule.kind === "require-pattern") return evaluateRequirePattern(rule, file, content);
  return [];
}

function validateExamples(rules) {
  const exampleErrors = [];
  let total = 0;
  for (const rule of rules) {
    const examples = rule.examples || {};
    for (const [kind, expectedPass] of [["pass", true], ["fail", false]]) {
      for (const [idx, example] of (Array.isArray(examples[kind]) ? examples[kind] : []).entries()) {
        total += 1;
        const path = normalizeRel(example.path);
        const findings = evaluateRule(rule, path, example.content || "");
        if (expectedPass && findings.length > 0) {
          exampleErrors.push(`${rule.source}: examples.${kind}[${idx}] unexpectedly violates ${rule.id}`);
        } else if (!expectedPass && findings.length === 0) {
          exampleErrors.push(`${rule.source}: examples.${kind}[${idx}] does not exercise failing rule ${rule.id}`);
        }
      }
    }
  }
  return { total, errors: exampleErrors };
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const relPath = rel(abs);
    if (matchesAny(relPath, DEFAULT_IGNORES)) continue;
    if (entry.isDirectory()) {
      walkFiles(abs, out);
      continue;
    }
    if (entry.isFile() && SOURCE_EXT_RE.test(entry.name)) out.push(relPath);
  }
  return out;
}

function scanProject(rules) {
  const files = walkFiles(ROOT).sort();
  const findings = [];
  for (const file of files) {
    const applicable = rules.filter((rule) => rule.enabled !== false && ruleApplies(rule, file));
    if (applicable.length === 0) continue;
    const abs = resolve(ROOT, file);
    let content = "";
    try {
      if (statSync(abs).size > 1_000_000) {
        warnings.push(`${file}: skipped architecture fitness scan because file is larger than 1MB`);
        continue;
      }
      content = readFileSync(abs, "utf8");
    } catch (error) {
      warnings.push(`${file}: skipped architecture fitness scan (${error.message})`);
      continue;
    }
    for (const rule of applicable) findings.push(...evaluateRule(rule, file, content));
  }
  return { files: files.length, findings };
}

function formatFinding(item) {
  return `${item.file}:${item.line} [${item.severity} ${item.ruleId} -> ${item.owner}] ${item.message} (failure=${item.failureClass}, prevention=${item.prevention})`;
}

function main() {
  const config = readConfig();
  const fitness = config.architectureFitness || {};
  const loaded = readRuleFiles(config);
  if (loaded.disabled) {
    console.log("architecture fitness: disabled");
    process.exit(0);
  }
  const rules = loaded.rules.map(validateRule).filter(Boolean).filter((rule) => !opts.rule || rule.id === opts.rule);
  if (opts.rule && rules.length === 0) errors.push(`rule "${opts.rule}" not found`);

  const shouldValidateExamples = opts.examples && fitness.includeExamples !== false;
  const exampleResult = shouldValidateExamples ? validateExamples(rules) : { total: 0, errors: [] };
  errors.push(...exampleResult.errors);

  const scan = opts.examplesOnly ? { files: 0, findings: [] } : scanProject(rules.filter((rule) => rule.enabled !== false));
  const blockOnViolation = fitness.blockOnViolation !== false;
  const blockingFindings = blockOnViolation
    ? scan.findings.filter((item) => item.severity === "block" || opts.strict)
    : [];
  const payload = {
    status: errors.length === 0 && blockingFindings.length === 0 ? "pass" : "fail",
    rules: rules.length,
    filesScanned: scan.files,
    examples: exampleResult.total,
    findings: scan.findings,
    errors,
    warnings,
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (payload.status === "pass") {
    console.log(`architecture fitness: OK (${rules.length} rule(s), ${scan.files} scanned file(s), ${exampleResult.total} example(s))`);
    for (const warning of warnings) console.error(`warning: ${warning}`);
  } else {
    console.error("architecture fitness: FAILED");
    for (const error of errors) console.error(`- ${error}`);
    for (const item of scan.findings) console.error(`- ${formatFinding(item)}`);
    for (const warning of warnings) console.error(`warning: ${warning}`);
  }
  process.exit(payload.status === "pass" ? 0 : 1);
}

main();
