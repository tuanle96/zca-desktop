import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const DEFAULT_BASELINE_PATH = ".harness/structural-baseline.json";

function rel(root, path) {
  return relative(root, path).split("\\").join("/") || ".";
}

function insideRoot(root, path) {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

function parseBaselineContent(raw, label) {
  const errors = [];
  let entries = [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      errors.push(`${label}: expected an array of structural violation keys`);
    } else {
      entries = parsed;
    }
  } catch (error) {
    errors.push(`${label}: invalid JSON (${error.message})`);
  }

  const validEntries = [];
  const seen = new Set();
  const duplicateEntries = [];
  for (const [idx, entry] of entries.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      errors.push(`${label}: entry ${idx} must be a non-empty string`);
      continue;
    }
    validEntries.push(entry);
    if (seen.has(entry)) duplicateEntries.push(entry);
    seen.add(entry);
  }
  if (duplicateEntries.length > 0) {
    errors.push(`${label}: duplicate entries: ${[...new Set(duplicateEntries)].join(", ")}`);
  }

  return {
    entries: validEntries,
    count: validEntries.length,
    duplicateEntries: [...new Set(duplicateEntries)].sort(),
    errors,
  };
}

function readBaselineFile(path, label) {
  if (!existsSync(path)) {
    return {
      exists: false,
      entries: [],
      count: 0,
      duplicateEntries: [],
      errors: [],
    };
  }
  return {
    exists: true,
    ...parseBaselineContent(readFileSync(path, "utf8"), label),
  };
}

function gitShow(root, ref, path) {
  const relPath = rel(root, path);
  const result = spawnSync("git", ["show", `${ref}:${relPath}`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    return { found: true, content: result.stdout };
  }

  const refCheck = spawnSync("git", ["rev-parse", "--verify", ref], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    found: false,
    refExists: refCheck.status === 0,
    error: result.stderr?.trim() || result.stdout?.trim() || null,
  };
}

export function readStructuralBaselineConfig(root) {
  for (const relPath of [".harness/config.json", "harness.config.json"]) {
    const path = resolve(root, relPath);
    if (!existsSync(path)) continue;
    try {
      const config = JSON.parse(readFileSync(path, "utf8"));
      return config.structuralBaseline || config.structuralTest?.baseline || {};
    } catch {
      return {};
    }
  }
  return {};
}

export function analyzeStructuralBaseline({
  cwd = process.cwd(),
  baselinePath,
  compareRef,
  maxEntries,
  decreasingOnly,
  burnDownRate,
  burnDownRef,
} = {}) {
  const root = resolve(cwd);
  const config = readStructuralBaselineConfig(root);
  const configuredPath = baselinePath || config.baselinePath || DEFAULT_BASELINE_PATH;
  const absBaselinePath = resolve(root, configuredPath);
  const errors = [];
  const warnings = [];
  const reasons = [];

  if (!insideRoot(root, absBaselinePath)) {
    errors.push(`baselinePath must stay inside the project root: ${configuredPath}`);
  }

  const effectiveMaxEntries = maxEntries ?? config.maxEntries ?? null;
  const effectiveCompareRef = compareRef ?? config.compareRef ?? "HEAD";
  const shouldCompare = decreasingOnly ?? config.decreasingOnly ?? true;
  const baseline = errors.length === 0
    ? readBaselineFile(absBaselinePath, rel(root, absBaselinePath))
    : { exists: false, entries: [], count: 0, duplicateEntries: [], errors: [] };
  errors.push(...baseline.errors);

  let comparison = {
    enabled: Boolean(shouldCompare && effectiveCompareRef),
    ref: effectiveCompareRef || null,
    exists: false,
    count: null,
    delta: null,
    grew: false,
  };

  if (comparison.enabled && errors.length === 0) {
    const shown = gitShow(root, effectiveCompareRef, absBaselinePath);
    if (shown.found) {
      const head = parseBaselineContent(shown.content, `${effectiveCompareRef}:${rel(root, absBaselinePath)}`);
      errors.push(...head.errors);
      comparison = {
        ...comparison,
        exists: true,
        count: head.count,
        delta: baseline.count - head.count,
        grew: baseline.count > head.count,
      };
      if (comparison.grew) {
        errors.push(`${rel(root, absBaselinePath)} grew vs ${effectiveCompareRef} (${baseline.count} > ${head.count})`);
      }
    }
  }

  if (Number.isInteger(effectiveMaxEntries) && baseline.count > effectiveMaxEntries) {
    errors.push(`${rel(root, absBaselinePath)} has ${baseline.count} entries, above maxEntries ${effectiveMaxEntries}`);
  }

  // Phase 6.2: weekly burn-down policy. burnDownRate is the *minimum* number of
  // entries we expect the baseline to shrink by, measured against burnDownRef
  // (defaults to HEAD~7 so the policy reads as "reduce N entries per week").
  // The check is best-effort: if the ref isn't available (shallow clone, fresh
  // repo), we surface a warning rather than blocking.
  const effectiveBurnDownRate = Number.isFinite(burnDownRate ?? config.burnDownRate)
    ? Number(burnDownRate ?? config.burnDownRate)
    : null;
  const effectiveBurnDownRef = burnDownRef || config.burnDownRef || "HEAD~7";
  let burnDown = {
    enabled: effectiveBurnDownRate !== null && effectiveBurnDownRate > 0,
    ref: effectiveBurnDownRef,
    rate: effectiveBurnDownRate,
    refExists: false,
    previousCount: null,
    reduction: null,
    onTrack: null,
  };
  if (burnDown.enabled && errors.length === 0) {
    const shown = gitShow(root, effectiveBurnDownRef, absBaselinePath);
    if (shown.found) {
      const previous = parseBaselineContent(shown.content, `${effectiveBurnDownRef}:${rel(root, absBaselinePath)}`);
      if (previous.errors.length === 0) {
        const reduction = previous.count - baseline.count;
        burnDown = {
          ...burnDown,
          refExists: true,
          previousCount: previous.count,
          reduction,
          onTrack: reduction >= effectiveBurnDownRate,
        };
        if (!burnDown.onTrack) {
          errors.push(
            `${rel(root, absBaselinePath)} burn-down behind target: reduced ${reduction} vs ${effectiveBurnDownRef} (target ${effectiveBurnDownRate}/period)`,
          );
        }
      }
    } else if (shown.refExists) {
      // Ref exists but file didn't exist there yet: nothing to compare against.
      burnDown = { ...burnDown, refExists: true };
    } else {
      warnings.push(
        `burn-down skipped: ref ${effectiveBurnDownRef} not available (shallow clone or fresh repo?)`,
      );
    }
  }

  if (baseline.count > 0) reasons.push(`${baseline.count} structural baseline entr${baseline.count === 1 ? "y" : "ies"} remain`);
  if (comparison.exists && comparison.delta < 0) {
    reasons.push(`baseline shrank by ${Math.abs(comparison.delta)} vs ${comparison.ref}`);
  }
  if (comparison.exists && comparison.delta === 0 && baseline.count > 0) {
    reasons.push(`baseline unchanged vs ${comparison.ref}`);
  }
  if (warnings.length > 0) reasons.push(...warnings);
  if (errors.length > 0) reasons.push(...errors);

  return {
    status: errors.length > 0 ? "fail" : baseline.count > 0 || warnings.length > 0 ? "warn" : "pass",
    baselinePath: rel(root, absBaselinePath),
    exists: baseline.exists,
    count: baseline.count,
    entries: baseline.entries,
    duplicateEntries: baseline.duplicateEntries,
    maxEntries: Number.isInteger(effectiveMaxEntries) ? effectiveMaxEntries : null,
    comparison,
    burnDown,
    errors,
    warnings,
    reasons,
  };
}
