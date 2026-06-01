import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { validateProofCommand } from "./command-policy.mjs";

export function createEvalTaskPolicy({ root = process.cwd() } = {}) {
  const ROOT = resolve(root);

  function rel(path) {
    const abs = resolve(path);
    if (!insideRoot(abs)) return path;
    return relative(ROOT, abs) || ".";
  }

  function insideRoot(path) {
    const normalizedRoot = ROOT.endsWith("/") ? ROOT : `${ROOT}/`;
    return path === ROOT || path.startsWith(normalizedRoot);
  }

  function hasUrlScheme(value) {
    return /^[a-z][a-z0-9+.-]*:/i.test(String(value || ""));
  }

  function stableId(value) {
    return /^[a-z0-9][a-z0-9._-]*$/.test(String(value || ""));
  }

  function nonEmptyArray(value) {
    return Array.isArray(value) && value.length > 0;
  }

  function validateRepoPath(value, prefix, errors) {
    const text = String(value || "").trim();
    if (!text) {
      errors.push(`${prefix} must be a non-empty repo-local path`);
      return;
    }
    if (hasUrlScheme(text)) {
      errors.push(`${prefix} must be a repo-local path, not a URL`);
      return;
    }
    if (isAbsolute(text)) {
      errors.push(`${prefix} must be a repo-relative path, not an absolute path`);
      return;
    }
    const abs = resolve(ROOT, text);
    if (!insideRoot(abs)) {
      errors.push(`${prefix} must stay inside the project root`);
    }
  }

  function validateAcceptanceCommand(command, prefix, errors) {
    errors.push(...validateProofCommand(command, { prefix, context: "eval acceptance checks" }));
  }

  function hasDeterministicTruth(expected) {
    return Boolean(
      expected?.structuralTest ||
        expected?.acceptanceCheck ||
        nonEmptyArray(expected?.acceptanceChecks) ||
        nonEmptyArray(expected?.requiredFiles) ||
        nonEmptyArray(expected?.skillsInvoked) ||
        (typeof expected?.noDeterministicChecksJustification === "string" &&
          expected.noDeterministicChecksJustification.trim().length >= 20),
    );
  }

  function validateAcceptanceChecks(task, path, errors) {
    const checks = task.expected?.acceptanceChecks;
    if (checks === undefined) return;
    if (!Array.isArray(checks)) {
      errors.push(`${rel(path)}: expected.acceptanceChecks must be an array`);
      return;
    }
    const seenIds = new Set();
    for (const [idx, item] of checks.entries()) {
      if (typeof item === "string") {
        validateAcceptanceCommand(item, `${rel(path)}: expected.acceptanceChecks[${idx}]`, errors);
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`${rel(path)}: expected.acceptanceChecks[${idx}] must be a string or object`);
        continue;
      }
      if (!stableId(item.id)) {
        errors.push(`${rel(path)}: expected.acceptanceChecks[${idx}].id must be a stable lowercase id`);
      } else if (seenIds.has(item.id)) {
        errors.push(`${rel(path)}: expected.acceptanceChecks contains duplicate id "${item.id}"`);
      } else {
        seenIds.add(item.id);
      }
      if (!item.command) errors.push(`${rel(path)}: expected.acceptanceChecks[${idx}].command is required`);
      else validateAcceptanceCommand(item.command, `${rel(path)}: expected.acceptanceChecks[${idx}].command`, errors);
      if (item.timeoutMs !== undefined && (!Number.isInteger(item.timeoutMs) || item.timeoutMs < 1)) {
        errors.push(`${rel(path)}: expected.acceptanceChecks[${idx}].timeoutMs must be a positive integer`);
      }
    }
  }

  function validateTask(task, path) {
    const errors = [];
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      errors.push(`${rel(path)}: task must be an object`);
      return errors;
    }
    if (!stableId(task.id)) errors.push(`${rel(path)}: id must be a stable lowercase id`);
    if (typeof task.input !== "string" || task.input.trim().length === 0) {
      errors.push(`${rel(path)}: input is required`);
    }
    if (!task.expected || typeof task.expected !== "object" || Array.isArray(task.expected)) {
      errors.push(`${rel(path)}: expected object is required`);
      return errors;
    }

    const range = task.expected.filesChanged;
    if (range) {
      if (!Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min < 0 || range.max < range.min) {
        errors.push(`${rel(path)}: expected.filesChanged must have integer min/max with max >= min`);
      }
    }
    for (const key of ["requiredFiles", "skillsInvoked"]) {
      if (task.expected[key] !== undefined) {
        if (!Array.isArray(task.expected[key])) {
          errors.push(`${rel(path)}: expected.${key} must be an array`);
        } else if (task.expected[key].some((item) => typeof item !== "string" || !item.trim())) {
          errors.push(`${rel(path)}: expected.${key} entries must be non-empty strings`);
        } else if (key === "requiredFiles") {
          for (const [idx, item] of task.expected[key].entries()) {
            validateRepoPath(item, `${rel(path)}: expected.requiredFiles[${idx}]`, errors);
          }
        }
      }
    }
    if (task.expected.acceptanceCheck !== undefined) {
      validateAcceptanceCommand(task.expected.acceptanceCheck, `${rel(path)}: expected.acceptanceCheck`, errors);
    }
    validateAcceptanceChecks(task, path, errors);
    if (!hasDeterministicTruth(task.expected)) {
      errors.push(
        `${rel(path)}: expected must include acceptanceCheck, acceptanceChecks, structuralTest, requiredFiles, skillsInvoked, or noDeterministicChecksJustification`,
      );
    }
    return errors;
  }

  function listTaskFiles(dir) {
    const absDir = resolve(dir);
    if (!insideRoot(absDir)) {
      return { files: [], errors: [`${rel(absDir)}: eval task directory must stay inside the project root`] };
    }
    if (!existsSync(absDir)) return { files: [], errors: [] };
    return {
      files: readdirSync(absDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => join(absDir, entry.name))
        .sort(),
      errors: [],
    };
  }

  return {
    root: ROOT,
    rel,
    insideRoot,
    validateTask,
    listTaskFiles,
  };
}
