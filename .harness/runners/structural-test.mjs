// .harness/runners/structural-test.mjs — forward-only layer enforcement.
//
// Reads .harness/config.json. For each domain, parses every source file's
// imports (via ts-morph) and asserts that no import goes "backward" through
// the layer order. New violations on existing code are baselined into
// .harness/structural-baseline.json on first run.
//
// Exit codes:
//   0 — clean (or only baselined violations)
//   2 — new violations found (Claude Code reads stderr and re-prompts)

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";

let Project;
let SyntaxKind;
try {
  ({ Project, SyntaxKind } = await import("ts-morph"));
} catch {
  console.error(
    "ts-morph is not installed. Run `npm install --save-dev ts-morph`.",
  );
  process.exit(1);
}

const ROOT = process.cwd();
const cfg = JSON.parse(readFileSync(resolve(ROOT, ".harness/config.json"), "utf8"));
const baselinePath = resolve(ROOT, ".harness/structural-baseline.json");
let baseline = new Map();
let baselineWarnings = [];
let baselineBlocks = [];

if (existsSync(baselinePath)) {
  const baselineData = JSON.parse(readFileSync(baselinePath, "utf8"));
  const now = Date.now();
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
  const ONE_EIGHTY_DAYS = 180 * 24 * 60 * 60 * 1000;
  
  // Handle old format (array of strings) - migrate to new format
  if (Array.isArray(baselineData)) {
    for (const key of baselineData) {
      baseline.set(key, { baselinedAt: now, key });
    }
  } else {
    // New format (object with timestamps)
    for (const [key, entry] of Object.entries(baselineData)) {
      const baselinedAt = entry.baselinedAt || now;
      const age = now - baselinedAt;
      baseline.set(key, { baselinedAt, key });
      
      if (age > ONE_EIGHTY_DAYS) {
        baselineBlocks.push({ key, age: Math.floor(age / (24 * 60 * 60 * 1000)) });
      } else if (age > NINETY_DAYS) {
        baselineWarnings.push({ key, age: Math.floor(age / (24 * 60 * 60 * 1000)) });
      }
    }
  }
}

// Phase 5: Enhanced alias resolution for tsconfig paths
function loadTsConfigPaths() {
  const tsconfigPath = resolve(ROOT, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return {};
  
  try {
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    const paths = tsconfig?.compilerOptions?.paths || {};
    const baseUrl = tsconfig?.compilerOptions?.baseUrl || ".";
    
    // Convert tsconfig paths to resolution map
    const aliasMap = {};
    for (const [alias, targets] of Object.entries(paths)) {
      // Remove trailing /* from alias
      const cleanAlias = alias.replace(/\/\*$/, "");
      // Take first target, remove trailing /*
      const target = Array.isArray(targets) ? targets[0] : targets;
      const cleanTarget = target.replace(/\/\*$/, "");
      aliasMap[cleanAlias] = resolve(ROOT, baseUrl, cleanTarget);
    }
    
    return aliasMap;
  } catch (err) {
    console.warn(`Warning: Could not parse tsconfig.json paths: ${err.message}`);
    return {};
  }
}

function resolveAlias(specifier, aliasMap) {
  for (const [alias, targetPath] of Object.entries(aliasMap)) {
    if (specifier === alias) {
      return targetPath;
    }
    if (specifier.startsWith(`${alias}/`)) {
      const remainder = specifier.slice(alias.length + 1);
      return resolve(targetPath, remainder);
    }
  }
  return null;
}

function resolveImportPath(imp, sourcePath, aliasMap) {
  const specifier = imp.getModuleSpecifierValue();
  
  // Try ts-morph's built-in resolution first
  const target = imp.getModuleSpecifierSourceFile();
  if (target) {
    return target.getFilePath();
  }
  
  // Try alias resolution
  const aliasResolved = resolveAlias(specifier, aliasMap);
  if (aliasResolved) {
    // Try common extensions
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ".js", ".jsx"]) {
      const candidate = aliasResolved + ext;
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    // Return resolved path even if file doesn't exist (might be external)
    return aliasResolved;
  }
  
  // Relative import resolution
  if (specifier.startsWith(".")) {
    const sourceDir = dirname(sourcePath);
    const resolved = resolve(sourceDir, specifier);
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ".js", ".jsx"]) {
      const candidate = resolved + ext;
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return resolved;
  }
  
  // External module (node_modules)
  return null;
}

// Phase 5.2: Barrel-export expansion. When a resolved import lands on a barrel
// `index` file, follow its `export { ... } from "..."` and `export * from "..."`
// declarations one level so the structural rules see the underlying file
// instead of stopping at the barrel layer. Returns an array of resolved file
// paths; falls back to [target] when target is not a barrel or expansion fails.
const BARREL_BASENAMES = new Set([
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "index.mts",
  "index.cts",
]);

const barrelCache = new Map();

function isBarrelFile(filePath) {
  if (!filePath) return false;
  const base = filePath.split("/").pop() || "";
  return BARREL_BASENAMES.has(base);
}

function expandBarrelTarget(barrelPath, project, aliasMap, depth = 0) {
  if (!barrelPath || !isBarrelFile(barrelPath)) return [barrelPath].filter(Boolean);
  if (depth > 2) return [barrelPath];
  if (barrelCache.has(barrelPath)) return barrelCache.get(barrelPath);
  // Mark in-progress to prevent cycles before recursion.
  barrelCache.set(barrelPath, [barrelPath]);

  const sf = project.getSourceFile(barrelPath);
  if (!sf || !existsSync(barrelPath)) {
    return [barrelPath];
  }

  const expanded = new Set();
  for (const exp of sf.getExportDeclarations()) {
    const specifier = exp.getModuleSpecifierValue();
    if (!specifier) continue;
    const targetPath = resolveImportPath(exp, barrelPath, aliasMap);
    if (!targetPath) continue;
    if (isBarrelFile(targetPath)) {
      for (const nested of expandBarrelTarget(targetPath, project, aliasMap, depth + 1)) {
        if (nested) expanded.add(nested);
      }
    } else {
      expanded.add(targetPath);
    }
  }

  const result = expanded.size > 0 ? [...expanded] : [barrelPath];
  barrelCache.set(barrelPath, result);
  return result;
}

// CLI flag --file <path> scopes the check to one file (used by the hook).
const args = process.argv.slice(2);
let scopedFile = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--file" && i + 1 < args.length) scopedFile = resolve(ROOT, args[i + 1]);
}

function layerOf(filePath) {
  for (const d of cfg.domains) {
    if (!filePath.includes(`/${d.root}/`) && !filePath.endsWith(`/${d.root}`)) {
      // also accept relative match
      const rel = filePath.startsWith(ROOT) ? filePath.slice(ROOT.length + 1) : filePath;
      if (!rel.startsWith(d.root)) continue;
    }
    for (const layer of d.layers) {
      if (filePath.includes(`/${layer}/`) || filePath.endsWith(`/${layer}.ts`)) {
        return { layer, domain: d };
      }
    }
  }
  return null;
}

function indexOf(layer, layers) {
  return layers.indexOf(layer);
}

function relPath(filePath) {
  return (filePath.startsWith(ROOT) ? filePath.slice(ROOT.length + 1) : filePath).replaceAll("\\", "/");
}

function isUnderSourceDir(filePath, dir) {
  const rel = relPath(filePath);
  return rel.startsWith(`${dir}/`);
}

function globToRegex(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAnyPattern(value, patterns = []) {
  return patterns.some((pattern) => globToRegex(pattern).test(value));
}

function matchesSpecifierPattern(specifier, pattern) {
  const normalized = String(pattern || "");
  if (normalized.endsWith("*")) return specifier.startsWith(normalized.slice(0, -1));
  return specifier === normalized || specifier.startsWith(`${normalized}/`);
}

function isAllowedByLayerOrPath(rule, src, sourcePath) {
  if ((rule.allowLayers || []).includes(src.layer)) return true;
  return matchesAnyPattern(relPath(sourcePath), rule.allowPaths || []);
}

function violationKey(ruleId, file, line, detail) {
  return `${ruleId}::${relPath(file)}:${line}::${detail}`;
}

function pushViolation(violation) {
  if (baseline.has(violation.key)) {
    baselinedViolations.push(violation);
    return;
  }
  violations.push(violation);
}

function activeStructuralRules() {
  return (cfg.structuralTest?.rules || [])
    .filter((rule) => rule && rule.enabled !== false && rule.kind);
}

const DEFAULT_DB_IMPORT_SPECIFIERS = [
  "@prisma/client",
  "drizzle-orm",
  "knex",
  "mongodb",
  "mongoose",
  "mysql2",
  "pg",
  "sequelize",
  "typeorm",
];

const DEFAULT_PROVIDER_IMPORT_SPECIFIERS = {
  auth: [
    "@auth/*",
    "next-auth",
    "lucia",
    "@clerk/*",
    "@supabase/supabase-js",
    "firebase/auth",
  ],
  telemetry: [
    "@sentry/*",
    "@opentelemetry/*",
    "posthog-js",
    "mixpanel-browser",
    "datadog-logs",
  ],
  "feature-flags": [
    "launchdarkly-js-client-sdk",
    "launchdarkly-node-server-sdk",
    "@flags-sdk/*",
    "unleash-client",
    "growthbook",
  ],
};

function entriesForProviderRule(rule) {
  const configured = rule.providers || rule.providerImportSpecifiers || DEFAULT_PROVIDER_IMPORT_SPECIFIERS;
  if (Array.isArray(configured)) {
    return configured.map((entry) => ({
      id: entry.id || entry.name || "provider",
      importSpecifiers: entry.importSpecifiers || entry.specifiers || [],
    }));
  }
  return Object.entries(configured).map(([id, importSpecifiers]) => ({
    id,
    importSpecifiers,
  }));
}

const project = new Project({
  tsConfigFilePath: existsSync(resolve(ROOT, "tsconfig.json"))
    ? resolve(ROOT, "tsconfig.json")
    : undefined,
  skipAddingFilesFromTsConfig: false,
});
if (!existsSync(resolve(ROOT, "tsconfig.json"))) {
  project.addSourceFilesAtPaths("**/*.{ts,tsx,mts,cts}");
}

const violations = [];
const baselinedViolations = [];
const structuralRules = activeStructuralRules();
const aliasMap = loadTsConfigPaths();

for (const sf of project.getSourceFiles()) {
  const sourcePath = sf.getFilePath();
  if (scopedFile && sourcePath !== scopedFile) continue;
  const src = layerOf(sourcePath);
  if (!src) continue;
  const sourceIdx = indexOf(src.layer, src.domain.layers);

  for (const imp of sf.getImportDeclarations()) {
    const specifier = imp.getModuleSpecifierValue();
    const targetPath = resolveImportPath(imp, sourcePath, aliasMap);
    let boundaryViolation = false;
    if (targetPath && isUnderSourceDir(sourcePath, "src/runtime") && isUnderSourceDir(targetPath, "src/ui")) {
      const key = `${sourcePath}::${targetPath}`;
      boundaryViolation = true;
      pushViolation({
        file: sourcePath,
        line: imp.getStartLineNumber(),
        from: "runtime",
        to: "ui",
        domain: "runtime-ui-boundary",
        key,
        message: "src/runtime/ must not import from src/ui/",
      });
    }

    // Phase 5.2: expand barrel exports so layer checks see the real module.
    const expandedTargets = targetPath
      ? expandBarrelTarget(targetPath, project, aliasMap)
      : [null];

    let recordedBackwardImport = false;
    for (const expandedTarget of expandedTargets) {
      const tgt = expandedTarget ? layerOf(expandedTarget) : null;
      if (boundaryViolation || !tgt || tgt.domain.name !== src.domain.name) continue;
      const targetIdx = indexOf(tgt.layer, tgt.domain.layers);
      // forward-only: source layer index must be >= target layer index
      if (sourceIdx < targetIdx && !recordedBackwardImport) {
        const key = `${sourcePath}::${expandedTarget}`;
        pushViolation({
          file: sourcePath,
          line: imp.getStartLineNumber(),
          from: src.layer,
          to: tgt.layer,
          domain: src.domain.name,
          key,
          via: expandedTarget !== targetPath ? targetPath : undefined,
        });
        recordedBackwardImport = true;
      }
    }
    // Keep `tgt` defined for the rule loop below using the direct target so
    // existing rules (no-db-in-ui etc.) keep their current semantics.
    const tgt = targetPath ? layerOf(targetPath) : null;

    for (const rule of structuralRules) {
      if (rule.kind === "no-db-in-ui") {
        const uiLayers = rule.uiLayers || ["ui"];
        if (!uiLayers.includes(src.layer)) continue;
        const dbLayers = rule.dbLayers || ["repo"];
        const dbSpecifiers = rule.dbImportSpecifiers || DEFAULT_DB_IMPORT_SPECIFIERS;
        const importsDbLayer = tgt && tgt.domain.name === src.domain.name && dbLayers.includes(tgt.layer);
        const importsDbLibrary = dbSpecifiers.some((pattern) => matchesSpecifierPattern(specifier, pattern));
        if (!importsDbLayer && !importsDbLibrary) continue;
        pushViolation({
          file: sourcePath,
          line: imp.getStartLineNumber(),
          from: src.layer,
          to: importsDbLayer ? tgt.layer : "database-client",
          domain: rule.id,
          key: violationKey(rule.id, sourcePath, imp.getStartLineNumber(), specifier),
          rule: rule.id,
          message: rule.description || "UI must not import repository/database clients directly.",
        });
      } else if (rule.kind === "no-provider-bypass") {
        if (isAllowedByLayerOrPath(rule, src, sourcePath)) continue;
        for (const provider of entriesForProviderRule(rule)) {
          const importSpecifiers = Array.isArray(provider.importSpecifiers) ? provider.importSpecifiers : [];
          if (!importSpecifiers.some((pattern) => matchesSpecifierPattern(specifier, pattern))) continue;
          pushViolation({
            file: sourcePath,
            line: imp.getStartLineNumber(),
            from: src.layer,
            to: `provider:${provider.id}`,
            domain: rule.id,
            key: violationKey(rule.id, sourcePath, imp.getStartLineNumber(), `${provider.id}:${specifier}`),
            rule: rule.id,
            message: rule.description || "Import provider SDKs only through the provider boundary.",
          });
        }
      }
    }
  }

  for (const rule of structuralRules) {
    if (rule.kind === "no-raw-env") {
      if (isAllowedByLayerOrPath(rule, src, sourcePath)) continue;
      const seen = new Set();
      for (const expr of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const text = expr.getText();
        if (text !== "process.env" && text !== "import.meta.env") continue;
        if (seen.has(text)) continue;
        seen.add(text);
        const line = expr.getStartLineNumber();
        pushViolation({
          file: sourcePath,
          line,
          from: src.layer,
          to: (rule.allowLayers || ["config"]).join("|"),
          domain: rule.id,
          key: violationKey(rule.id, sourcePath, line, text),
          rule: rule.id,
          message: rule.description || "Read environment variables through the config layer.",
        });
      }
    } else if (rule.kind === "no-dynamic-import") {
      if (isAllowedByLayerOrPath(rule, src, sourcePath)) continue;
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
        const text = call.getText();
        const line = call.getStartLineNumber();
        pushViolation({
          file: sourcePath,
          line,
          from: src.layer,
          to: "static-import",
          domain: rule.id,
          key: violationKey(rule.id, sourcePath, line, text),
          rule: rule.id,
          message: rule.description || "Dynamic import hides dependencies from structural analysis.",
        });
      }
    }
  }
}

// First-run baseline behavior: if no baseline file exists, write the current
// set as the baseline and exit clean. Subsequent runs only block on NEW
// violations.
if (!existsSync(baselinePath) && violations.length > 0) {
  mkdirSync(dirname(baselinePath), { recursive: true });
  const now = Date.now();
  const baselineObj = {};
  for (const v of violations) {
    baselineObj[v.key] = { baselinedAt: now, key: v.key };
  }
  writeFileSync(baselinePath, JSON.stringify(baselineObj, null, 2) + "\n");
  console.log(
    `✓ structural test: baselined ${violations.length} existing violations (.harness/structural-baseline.json).`,
  );
  console.log(
    `  New violations introduced after this point will block. Existing ones can be fixed incrementally.`,
  );
  process.exit(0);
}

if (violations.length === 0) {
  console.log("✓ structural test passed");
  process.exit(0);
}

for (const v of violations) {
  const ruleLabel = v.rule ? `  rule="${v.rule}"` : "";
  console.error(`✖ ${v.file}:${v.line}${ruleLabel}  layer=${v.from} → ${v.to}  ${v.message ?? "(must be forward-only)"}`);
}
console.error(`\n${violations.length} new structural violation(s). Fix the dependency, boundary, or raw access.`);
console.error(`Layer order for domain "${cfg.domains[0]?.name}": ${cfg.domains[0]?.layers?.join(" → ")}`);
process.exit(2);
