import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, join, relative, resolve, sep } from "node:path";

const LANES = new Set(["tiny", "normal", "high-risk"]);
const MAX_FILE_BYTES = 500_000;
const MAX_SOURCE_TEXT = 240;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "work",
  "works",
]);

const SKIP_DIR_NAMES = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const SKIP_REL_PREFIXES = [
  ".harness/evidence",
  ".harness/memory",
  ".harness/project",
  ".harness/reports",
  ".harness/scripts",
  ".harness/sessions",
  ".harness/state",
  ".harness/telemetry",
  ".harness/ui-validation",
];

const SKIP_FILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".go",
  ".hbs",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const EVIDENCE_TRIGGERS = new Set(["done", "evidence", "proof", "task", "validation", "validate"]);

const SYNONYMS = {
  done: ["completion", "complete", "completed", "finish", "finished"],
  evidence: ["attestation", "bundle", "proof"],
  proof: ["attestation", "evidence", "prove", "proven"],
  task: ["contract", "feature", "taskid"],
  validation: ["valid", "validate", "validated", "validates", "validator"],
  validate: ["valid", "validation", "validated", "validates", "validator"],
};

export function parseContextQueryArgs(argv = []) {
  const opts = {
    cwd: process.cwd(),
    errors: [],
    includeSrcwalk: true,
    json: false,
    lane: "normal",
    limit: 8,
    query: "",
    requireSrcwalk: false,
    scopes: [],
  };
  const queryParts = [];
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = String(argv[idx] ?? "");
    if (arg === "--json") opts.json = true;
    else if (arg === "--no-srcwalk") opts.includeSrcwalk = false;
    else if (arg === "--require-srcwalk") opts.requireSrcwalk = true;
    else if (arg === "--scope") {
      const value = argv[++idx];
      if (!value) opts.errors.push("--scope requires a path");
      else opts.scopes.push(String(value));
    } else if (arg.startsWith("--scope=")) {
      opts.scopes.push(arg.slice("--scope=".length));
    } else if (arg === "--lane") {
      const value = argv[++idx];
      if (!value) opts.errors.push("--lane requires tiny, normal, or high-risk");
      else opts.lane = String(value);
    } else if (arg.startsWith("--lane=")) {
      opts.lane = arg.slice("--lane=".length);
    } else if (arg === "--limit") {
      const value = argv[++idx];
      if (!value) opts.errors.push("--limit requires a number");
      else opts.limit = Number(value);
    } else if (arg.startsWith("--limit=")) {
      opts.limit = Number(arg.slice("--limit=".length));
    } else if (arg === "--cwd") {
      const value = argv[++idx];
      if (!value) opts.errors.push("--cwd requires a path");
      else opts.cwd = resolve(String(value));
    } else if (arg.startsWith("--cwd=")) {
      opts.cwd = resolve(arg.slice("--cwd=".length));
    } else if (arg.startsWith("-")) {
      opts.errors.push(`unknown option: ${arg}`);
    } else {
      queryParts.push(arg);
    }
  }
  opts.query = queryParts.join(" ").trim();
  if (opts.scopes.length === 0) opts.scopes.push(".");
  return opts;
}

export function buildContextQueryPayload(input = {}) {
  const opts = normalizeBuildOptions(input);
  const errors = [...(opts.errors || [])];
  const warnings = [];

  if (!opts.query) errors.push("query is required");
  if (!LANES.has(opts.lane)) errors.push(`invalid lane: ${opts.lane}`);
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 50) {
    errors.push("--limit must be an integer between 1 and 50");
  }

  const scopes = resolveScopes(opts.cwd, opts.scopes, errors);
  if (errors.length > 0) {
    return {
      schemaVersion: 1,
      mode: "context-query",
      status: "failed",
      query: opts.query,
      lane: opts.lane,
      scopes: opts.scopes.length ? opts.scopes : ["."],
      summary: errors,
      rankedFiles: [],
      sources: [],
      nextReads: [],
      commands: [],
      warnings,
      errors,
      stats: { searchedFiles: 0, candidateFiles: 0, sourceCount: 0 },
    };
  }

  const terms = queryTerms(opts.query);
  const srcwalk = runSrcwalk(opts, scopes, warnings);
  if (srcwalk.command?.status !== "passed" && opts.requireSrcwalk) {
    return {
      schemaVersion: 1,
      mode: "context-query",
      status: "failed",
      query: opts.query,
      lane: opts.lane,
      scopes: scopes.map((scope) => scope.display),
      summary: ["srcwalk is required for this query but is not available or failed."],
      rankedFiles: [],
      sources: [],
      nextReads: [],
      commands: [{ command: "internal-scan", status: "skipped", reason: "srcwalk required" }, srcwalk.command].filter(Boolean),
      warnings,
      errors: ["srcwalk is required; install it with `npm install -g srcwalk` and ensure it is on PATH."],
      stats: { searchedFiles: 0, candidateFiles: 0, sourceCount: 0 },
    };
  }
  const scan = scanContext({
    cwd: opts.cwd,
    lane: opts.lane,
    limit: opts.limit,
    phrase: normalizedText(opts.query),
    scopes,
    srcwalkHints: srcwalk.hints,
    terms,
  });

  const commands = [
    { command: "internal-scan", status: "passed" },
    srcwalk.command,
  ].filter(Boolean);

  if (scan.rankedFiles.length === 0) {
    warnings.push("No local context matched the query in the requested scope.");
  }

  return {
    schemaVersion: 1,
    mode: "context-query",
    status: "passed",
    query: opts.query,
    lane: opts.lane,
    scopes: scopes.map((scope) => scope.display),
    summary: summarizeResult(scan.rankedFiles, opts.query),
    rankedFiles: scan.rankedFiles,
    sources: scan.sources,
    nextReads: scan.nextReads,
    commands,
    warnings,
    stats: {
      searchedFiles: scan.searchedFiles,
      candidateFiles: scan.candidateFiles,
      sourceCount: scan.sources.length,
    },
  };
}

export function renderContextQueryText(payload) {
  const lines = [];
  lines.push(`# context-query: ${payload.status}`);
  if (payload.query) lines.push(`query: ${payload.query}`);
  if (payload.lane) lines.push(`lane: ${payload.lane}`);
  if (payload.scopes?.length) lines.push(`scopes: ${payload.scopes.join(", ")}`);
  if (payload.warnings?.length) {
    lines.push("");
    lines.push("warnings:");
    for (const warning of payload.warnings) lines.push(`- ${warning}`);
  }
  if (payload.errors?.length) {
    lines.push("");
    lines.push("errors:");
    for (const error of payload.errors) lines.push(`- ${error}`);
  }
  if (payload.summary?.length) {
    lines.push("");
    lines.push("summary:");
    for (const item of payload.summary) lines.push(`- ${item}`);
  }
  if (payload.rankedFiles?.length) {
    lines.push("");
    lines.push("ranked files:");
    for (const file of payload.rankedFiles) {
      lines.push(`- ${file.path} score=${file.score} (${file.reason})`);
    }
  }
  if (payload.sources?.length) {
    lines.push("");
    lines.push("sources:");
    for (const source of payload.sources) {
      lines.push(`- ${source.path}:${source.line} [${source.kind}] ${source.text}`);
    }
  }
  if (payload.nextReads?.length) {
    lines.push("");
    lines.push("next reads:");
    for (const read of payload.nextReads) lines.push(`- ${read.path}: ${read.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runContextQueryCli(argv = []) {
  const opts = parseContextQueryArgs(argv);
  const payload = buildContextQueryPayload(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(renderContextQueryText(payload));
  }
  process.exit(payload.status === "failed" ? 1 : 0);
}

function normalizeBuildOptions(input) {
  return {
    cwd: resolve(String(input.cwd || process.cwd())),
    errors: Array.isArray(input.errors) ? input.errors : [],
    includeSrcwalk: input.includeSrcwalk !== false,
    json: input.json === true,
    lane: String(input.lane || "normal"),
    limit: Number(input.limit || 8),
    query: String(input.query || "").trim(),
    requireSrcwalk: input.requireSrcwalk === true,
    scopes: Array.isArray(input.scopes) && input.scopes.length ? input.scopes.map(String) : ["."],
  };
}

function resolveScopes(cwd, rawScopes, errors) {
  const scopes = [];
  for (const rawScope of rawScopes) {
    const value = String(rawScope || "").trim() || ".";
    const absolute = resolve(cwd, value);
    if (!isInside(cwd, absolute)) {
      errors.push(`scope is outside repository: ${value}`);
      continue;
    }
    if (!existsSync(absolute)) {
      errors.push(`scope does not exist: ${value}`);
      continue;
    }
    const display = toPosix(relative(cwd, absolute)) || ".";
    scopes.push({ absolute, display });
  }
  if (scopes.length === 0) errors.push("at least one valid scope is required");
  return scopes;
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function queryTerms(query) {
  const base = splitWords(query)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
  const terms = new Set(base);
  for (const token of base) {
    for (const synonym of SYNONYMS[token] || []) terms.add(synonym);
    addSimpleStems(terms, token);
  }
  for (let idx = 0; idx < base.length - 1; idx += 1) {
    const a = base[idx];
    const b = base[idx + 1];
    terms.add(`${a}-${b}`);
    terms.add(`${a}_${b}`);
    terms.add(`${a}${b[0].toUpperCase()}${b.slice(1)}`);
  }
  return [...terms].filter(Boolean);
}

function addSimpleStems(terms, token) {
  if (token.endsWith("ation") && token.length > 7) {
    terms.add(token.slice(0, -5));
    terms.add(`${token.slice(0, -5)}e`);
  }
  if (token.endsWith("ion") && token.length > 6) terms.add(token.slice(0, -3));
  if (token.endsWith("ing") && token.length > 6) terms.add(token.slice(0, -3));
  if (token.endsWith("ed") && token.length > 5) terms.add(token.slice(0, -2));
  if (token.endsWith("s") && token.length > 4) terms.add(token.slice(0, -1));
}

function splitWords(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function normalizedText(value) {
  return splitWords(value).join(" ").toLowerCase();
}

function scanContext({ cwd, lane, limit, phrase, scopes, srcwalkHints, terms }) {
  const files = [];
  for (const scope of scopes) collectFiles(scope.absolute, cwd, files, scope.display);

  const candidates = [];
  let searchedFiles = 0;
  for (const file of files) {
    const text = readTextFile(file.absolute);
    if (text === null) continue;
    searchedFiles += 1;
    const candidate = scoreFile({ cwd, file, lane, phrase, srcwalkHints, terms, text });
    if (candidate.score > 0) candidates.push(candidate);
  }

  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const ranked = candidates.slice(0, limit);
  const rankedPaths = new Set(ranked.map((file) => file.path));
  const sources = candidates
    .filter((file) => rankedPaths.has(file.path))
    .flatMap((file) => file.sources.map((source) => ({ ...source, _score: source._score + file.score / 100 })))
    .sort((a, b) => b._score - a._score || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, Math.max(limit, Math.min(limit * 2, 16)))
    .map(({ _score, ...source }) => source);

  return {
    candidateFiles: candidates.length,
    searchedFiles,
    rankedFiles: ranked.map((file) => ({
      path: file.path,
      score: Math.round(file.score),
      reason: file.reason,
    })),
    sources,
    nextReads: ranked.slice(0, Math.min(5, ranked.length)).map((file) => ({
      path: file.path,
      reason: file.nextReadReason,
    })),
  };
}

function collectFiles(absolute, cwd, files, scopeDisplay = ".") {
  const stat = safeStat(absolute);
  if (!stat) return;
  const rel = toPosix(relative(cwd, absolute));
  if (stat.isDirectory()) {
    if (shouldSkipDir(rel, absolute, scopeDisplay)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      collectFiles(join(absolute, entry.name), cwd, files, scopeDisplay);
    }
    return;
  }
  if (!stat.isFile()) return;
  if (!isTextCandidate(absolute, rel, stat.size)) return;
  files.push({ absolute, path: rel || "." });
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function shouldSkipDir(rel, absolute, scopeDisplay = ".") {
  const name = absolute.split(sep).at(-1);
  if (SKIP_DIR_NAMES.has(name)) return true;
  const posix = toPosix(rel);
  const scope = toPosix(scopeDisplay || ".");
  return SKIP_REL_PREFIXES.some((prefix) => {
    if (posix !== prefix && !posix.startsWith(`${prefix}/`)) return false;
    return scope !== prefix && !scope.startsWith(`${prefix}/`);
  });
}

function isTextCandidate(path, rel, size) {
  if (size > MAX_FILE_BYTES) return false;
  const name = path.split(sep).at(-1);
  if (SKIP_FILE_NAMES.has(name)) return false;
  if (rel.endsWith(".png") || rel.endsWith(".jpg") || rel.endsWith(".jpeg") || rel.endsWith(".webp")) return false;
  const ext = extname(path).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || !ext;
}

function readTextFile(path) {
  try {
    const text = readFileSync(path, "utf8");
    if (text.includes("\0")) return null;
    return text;
  } catch {
    return null;
  }
}

function scoreFile({ file, lane, phrase, srcwalkHints, terms, text }) {
  const rel = file.path;
  const pathLower = rel.toLowerCase();
  const kind = sourceKind(rel);
  const drivers = [];
  const pathHits = terms.filter((term) => pathLower.includes(term.toLowerCase()));
  let score = pathHits.length * 9;
  if (pathHits.length) drivers.push(`path hits: ${pathHits.slice(0, 4).join(", ")}`);

  const normalizedFileText = normalizedText(text);
  if (phrase && normalizedFileText.includes(phrase)) {
    score += 24;
    drivers.push("exact phrase");
  }

  const triggerScore = evidenceTriggerBoost(pathLower, terms);
  if (triggerScore > 0) {
    score += triggerScore;
    drivers.push("task/evidence trigger");
  }

  const lineScores = scoreLines(rel, kind, text, terms, phrase);
  const lineTotal = lineScores.reduce((sum, source) => sum + source._score, 0);
  if (lineTotal > 0) {
    score += lineTotal;
    drivers.push(`${lineScores.length} matching lines`);
  }

  const srcwalkMatches = srcwalkHints.get(rel) || [];
  if (srcwalkMatches.length > 0) {
    score += 10 + Math.min(srcwalkMatches.length, 3) * 4;
    drivers.push("srcwalk hit");
  }

  const laneScore = laneBoost(pathLower, kind, lane);
  if (score > 0 && laneScore > 0) {
    score += laneScore;
    drivers.push(`${lane} lane boost`);
  }

  const sources = mergeSources(lineScores, srcwalkMatches, rel, kind);
  return {
    path: rel,
    reason: drivers.slice(0, 4).join("; ") || "weak lexical match",
    score,
    sources,
    nextReadReason: nextReadReason(rel, kind, drivers),
  };
}

function scoreLines(path, kind, text, terms, phrase) {
  const sources = [];
  const lines = text.split("\n");
  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = normalizedText(trimmed);
    const hits = terms.filter((term) => normalized.includes(term.toLowerCase()));
    let score = hits.length * 3;
    if (phrase && normalized.includes(phrase)) score += 12;
    if (score <= 0) continue;
    sources.push({
      path,
      line: idx + 1,
      kind,
      text: trimSource(trimmed),
      _score: score,
    });
  }
  return sources.sort((a, b) => b._score - a._score || a.line - b.line).slice(0, 5);
}

function mergeSources(lineSources, srcwalkMatches, path, kind) {
  const byKey = new Map();
  for (const source of lineSources) byKey.set(`${source.line}:${source.text}`, source);
  for (const match of srcwalkMatches) {
    const source = {
      path,
      line: match.line || 1,
      kind,
      text: trimSource(match.text || "srcwalk match"),
      _score: 8,
    };
    const key = `${source.line}:${source.text}`;
    if (!byKey.has(key)) byKey.set(key, source);
  }
  return [...byKey.values()].sort((a, b) => b._score - a._score || a.line - b.line).slice(0, 6);
}

function evidenceTriggerBoost(pathLower, terms) {
  if (!terms.some((term) => EVIDENCE_TRIGGERS.has(term.toLowerCase()))) return 0;
  let score = 0;
  if (pathLower.includes("task-evidence-check")) score += 90;
  if (pathLower.includes("evidence-bundle")) score += 28;
  if (pathLower.includes("evidence-attestation")) score += 20;
  if (pathLower.includes("task-contract")) score += 18;
  if (pathLower.includes("schema")) score += 10;
  if (pathLower.includes("test")) score += 8;
  return score;
}

function laneBoost(pathLower, kind, lane) {
  if (lane === "tiny") {
    if (kind === "docs" || kind === "schema") return 6;
    return 0;
  }
  if (lane === "high-risk") {
    if (pathLower.includes("security") || pathLower.includes("review") || pathLower.includes("evidence")) return 10;
    if (kind === "test" || kind === "schema") return 8;
    return 0;
  }
  if (kind === "code") return 3;
  if (kind === "docs" || kind === "schema" || kind === "test") return 2;
  return 0;
}

function sourceKind(path) {
  const lower = path.toLowerCase();
  const ext = extname(lower);
  if (lower.includes("/test") || lower.includes("tests/") || lower.includes(".test.") || lower.includes(".spec.")) return "test";
  if (lower.includes("schema") || lower.endsWith(".schema.json")) return "schema";
  if (ext === ".md" || lower.includes("/docs/")) return "docs";
  if ([".json", ".yaml", ".yml", ".toml"].includes(ext)) return "config";
  return "code";
}

function nextReadReason(path, kind, drivers) {
  if (kind === "test") return "Regression coverage for the matched behavior.";
  if (path.includes("task-evidence-check")) return "Primary implementation path for task evidence validation.";
  if (path.includes("evidence-bundle")) return "Evidence bundle contract or user-facing evidence documentation.";
  if (kind === "schema") return "Shape contract for the matched behavior.";
  return drivers.includes("srcwalk hit") ? "Structural search also matched this file." : "Highest lexical match for the query.";
}

function runSrcwalk(opts, scopes, warnings) {
  if (!opts.includeSrcwalk || process.env.AHK_CONTEXT_QUERY_DISABLE_SRCWALK === "1") {
    return { command: { command: "srcwalk find", status: "skipped", reason: "disabled" }, hints: new Map() };
  }
  const probe = spawnSync("srcwalk", ["version"], { cwd: opts.cwd, encoding: "utf8", timeout: 1500 });
  if (probe.error) {
    warnings.push("Install srcwalk (`npm install -g srcwalk`) for structural codebase search; using internal lexical scan only.");
    return { command: { command: "srcwalk find", status: "skipped", reason: "not available" }, hints: new Map() };
  }

  const hints = new Map();
  let ran = 0;
  let failed = 0;
  const query = srcwalkQuery(opts.query);
  for (const scope of scopes) {
    const result = spawnSync("srcwalk", ["find", query, "--scope", scope.display, "--budget", "2000"], {
      cwd: opts.cwd,
      encoding: "utf8",
      maxBuffer: 1_000_000,
      timeout: 5000,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status !== 0 && !/no matches for/i.test(output)) {
      failed += 1;
      continue;
    }
    ran += 1;
    for (const hint of parseSrcwalkFind(result.stdout || "")) {
      if (!hint.path) continue;
      const normalized = toPosix(hint.path);
      const list = hints.get(normalized) || [];
      list.push(hint);
      hints.set(normalized, list);
    }
  }
  if (failed > 0) warnings.push(`srcwalk failed for ${failed} scope(s); internal scan still completed.`);
  return {
    command: {
      command: "srcwalk find",
      status: ran > 0 ? "passed" : "failed",
      query,
      matches: [...hints.values()].reduce((sum, rows) => sum + rows.length, 0),
    },
    hints,
  };
}

function srcwalkQuery(query) {
  const compact = splitWords(query)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token))
    .slice(0, 8)
    .join(" ");
  return compact || query;
}

function parseSrcwalkFind(output) {
  const hints = [];
  let currentPath = null;
  for (const line of output.split("\n")) {
    const header = line.match(/^\s{2}(.+?)\s+\[\d+\s+matches?\]/);
    if (header) {
      currentPath = header[1].trim();
      continue;
    }
    const nested = line.match(/^\s+\[[^\]]+\]\s+:(\d+)\s+\|\s*(.*)$/);
    if (nested && currentPath) {
      hints.push({ path: currentPath, line: Number(nested[1]), text: nested[2].trim() });
      continue;
    }
    const direct = line.match(/^\s*([^:\s][^:]+):(\d+)(?::\d+)?\s*(?:\||-)?\s*(.*)$/);
    if (direct) hints.push({ path: direct[1].trim(), line: Number(direct[2]), text: direct[3].trim() });
  }
  return hints;
}

function summarizeResult(rankedFiles, query) {
  if (rankedFiles.length === 0) return [`No source-linked context found for "${query}".`];
  const top = rankedFiles[0];
  const summary = [`Top context is ${top.path} because ${top.reason}.`];
  if (rankedFiles.length > 1) {
    summary.push(`Also inspect ${rankedFiles.slice(1, 3).map((file) => file.path).join(", ")} for adjacent contracts or tests.`);
  }
  summary.push("Use the sources as a read plan; this command does not write files or produce a final answer.");
  return summary;
}

function trimSource(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_SOURCE_TEXT) return compact;
  return `${compact.slice(0, MAX_SOURCE_TEXT - 3)}...`;
}

function toPosix(path) {
  return String(path || "").split(sep).join("/");
}
