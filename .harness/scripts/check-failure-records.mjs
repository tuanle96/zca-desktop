#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { concreteCommand, validateProofCommand } from "./_lib/command-policy.mjs";
import {
  FAILURE_CLASSES,
  FAILURE_SOURCES as SOURCES,
  PREVENTION_TARGETS,
  PROMOTION_STATUSES,
  hasUrlScheme,
  insideRoot,
  preventionTemplateFor,
  preventionTargetPathAllowed,
} from "./_lib/failure-policy.mjs";

function parseArgs(argv) {
	  const opts = {
	    cwd: process.cwd(),
	    taxonomy: ".harness/failures/taxonomy.json",
	    recordsDir: null,
	    maxProposedAgeDays: null,
	    json: false,
	  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
	    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
	    else if (arg.startsWith("--taxonomy=")) opts.taxonomy = arg.slice("--taxonomy=".length);
	    else if (arg.startsWith("--records-dir=")) opts.recordsDir = arg.slice("--records-dir=".length);
	    else if (arg.startsWith("--max-proposed-age-days=")) {
	      opts.maxProposedAgeDays = Number(arg.slice("--max-proposed-age-days=".length));
	    }
	  }
	  return opts;
	}

const opts = parseArgs(process.argv.slice(2));
const ROOT = resolve(opts.cwd);
const errors = [];
const warnings = [];

function rel(path) {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${rel(path)}: invalid JSON (${error.message})`);
    return null;
  }
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readConfig() {
  return readJsonIfExists(resolve(ROOT, ".harness/config.json")) ||
    readJsonIfExists(resolve(ROOT, "harness.config.json")) ||
    {};
}

function stableId(value) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(String(value || ""));
}

	function isIsoDate(value) {
	  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
	}

	function ageDaysSince(value) {
	  const t = Date.parse(value || "");
	  if (!Number.isFinite(t)) return null;
	  return Math.max(0, Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000)));
	}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function validateTaxonomy(taxonomy, path) {
  const prefix = rel(path);
  if (!taxonomy) return null;
  if (taxonomy.schemaVersion !== 1) errors.push(`${prefix}: schemaVersion must be 1`);
  if (!Array.isArray(taxonomy.classes) || taxonomy.classes.length === 0) {
    errors.push(`${prefix}: classes must be a non-empty array`);
  } else {
    const seen = new Set();
    for (const [idx, cls] of taxonomy.classes.entries()) {
      if (!stableId(cls?.id)) errors.push(`${prefix}: classes[${idx}].id must be a stable lowercase id`);
      if (seen.has(cls?.id)) errors.push(`${prefix}: duplicate class id "${cls.id}"`);
      seen.add(cls?.id);
      if (!FAILURE_CLASSES.has(cls?.id)) errors.push(`${prefix}: unsupported failure class "${cls?.id}"`);
      if (!cls?.description) errors.push(`${prefix}: classes[${idx}].description is required`);
      if (!PREVENTION_TARGETS.has(cls?.preferredPrevention)) {
        errors.push(`${prefix}: classes[${idx}].preferredPrevention must be a supported prevention target`);
      }
    }
    const missing = [...FAILURE_CLASSES].filter((id) => !seen.has(id));
    for (const id of missing) errors.push(`${prefix}: missing canonical failure class "${id}"`);
  }
  if (!taxonomy.recordSchemaPath) {
    errors.push(`${prefix}: recordSchemaPath is required`);
  } else {
    validateRepoLocalPath(taxonomy.recordSchemaPath, `${prefix}: recordSchemaPath`);
  }
  if (!taxonomy.recordsDir) {
    errors.push(`${prefix}: recordsDir is required`);
  } else {
    validateRepoLocalPath(taxonomy.recordsDir, `${prefix}: recordsDir`);
  }
  return taxonomy;
}

function validateStringArray(value, path, key, { minItems = 0 } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${path}: ${key} must be an array`);
    return;
  }
  if (value.length < minItems) errors.push(`${path}: ${key} must contain at least ${minItems} item(s)`);
  for (const [idx, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      errors.push(`${path}: ${key}[${idx}] must be a non-empty string`);
    }
  }
}

function concrete(value) {
  return concreteCommand(value);
}

function validateRepoLocalPath(value, prefix, { mustExist = false } = {}) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (hasUrlScheme(text)) {
    errors.push(`${prefix} must be a repo-local path, not a URL`);
    return false;
  }
  const abs = resolve(ROOT, text);
  if (!insideRoot(ROOT, abs)) {
    errors.push(`${prefix} must stay inside the project root`);
    return false;
  }
  if (mustExist && !existsSync(abs)) {
    errors.push(`${prefix} not found: ${text}`);
    return false;
  }
  return true;
}

function validateEvidencePaths(record, prefix) {
  if (!Array.isArray(record.evidence)) return;
  for (const [idx, item] of record.evidence.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) continue;
    const text = item.trim();
    if (hasUrlScheme(text)) continue;
    validateRepoLocalPath(text, `${prefix}: evidence[${idx}]`, { mustExist: true });
  }
}

function validateProposedPrevention(value, prefix, status, preventionTarget) {
  const requiresPrevention = status === "proposed" || status === "applied" || status === "verified";
  if (value === undefined) {
    if (requiresPrevention) {
      errors.push(`${prefix}: proposedPrevention is required when promotionStatus=${status}`);
    }
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${prefix}: proposedPrevention must be an object`);
    return;
  }
  if (!value.path) {
    errors.push(`${prefix}: proposedPrevention.path is required`);
  } else {
    validateRepoLocalPath(value.path, `${prefix}: proposedPrevention.path`, { mustExist: status === "applied" || status === "verified" });
    if (PREVENTION_TARGETS.has(preventionTarget) && !preventionTargetPathAllowed(ROOT, preventionTarget, value.path)) {
      errors.push(`${prefix}: proposedPrevention.path "${value.path}" does not match preventionTarget "${preventionTarget}"`);
    }
  }
  if (!value.summary) errors.push(`${prefix}: proposedPrevention.summary is required`);
  if (requiresPrevention && !value.verificationCommand) {
    errors.push(`${prefix}: proposedPrevention.verificationCommand is required when promotionStatus=${status}`);
  } else if (requiresPrevention && !concrete(value.verificationCommand)) {
    errors.push(`${prefix}: proposedPrevention.verificationCommand must be concrete when promotionStatus=${status}`);
  } else if (value.verificationCommand) {
    errors.push(...validateProofCommand(value.verificationCommand, {
      prefix: `${prefix}: proposedPrevention.verificationCommand`,
      requireConcrete: true,
      context: "failure prevention verification",
    }));
  }
}

	function validateRecord(record, path, taxonomyClasses, { maxProposedAgeDays = null } = {}) {
  const prefix = rel(path);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    errors.push(`${prefix}: record must be an object`);
    return;
  }
  if (record.schemaVersion !== 1) errors.push(`${prefix}: schemaVersion must be 1`);
  if (!stableId(record.id)) errors.push(`${prefix}: id must be a stable lowercase id`);
  const expectedId = basename(path, ".json");
  if (record.id && record.id !== expectedId) {
    errors.push(`${prefix}: id must match filename "${expectedId}"`);
  }
  if (!isIsoDate(record.observedAt)) errors.push(`${prefix}: observedAt must be an ISO date-time`);
  if (record.source !== undefined && !SOURCES.has(record.source)) {
    errors.push(`${prefix}: source must be one of ${[...SOURCES].join(", ")}`);
  }
  if (!taxonomyClasses.has(record.primaryClass)) {
    errors.push(`${prefix}: primaryClass must be one of the taxonomy class ids`);
  }
  if (!record.symptom) errors.push(`${prefix}: symptom is required`);
  validateStringArray(record.evidence, prefix, "evidence", { minItems: 1 });
  validateEvidencePaths(record, prefix);
  if (!PREVENTION_TARGETS.has(record.preventionTarget)) {
    errors.push(`${prefix}: preventionTarget must be one of ${[...PREVENTION_TARGETS].join(", ")}`);
  }
  const preferredPrevention = taxonomyClasses.get(record.primaryClass)?.preferredPrevention;
  if (preferredPrevention && record.preventionTarget !== preferredPrevention) {
    if (!concrete(record.preventionJustification)) {
      errors.push(`${prefix}: preventionJustification is required when preventionTarget "${record.preventionTarget}" differs from taxonomy preferredPrevention "${preferredPrevention}"`);
    }
  }
	  if (!PROMOTION_STATUSES.has(record.promotionStatus)) {
	    errors.push(`${prefix}: promotionStatus must be proposed, applied, verified, or rejected`);
	  }
	  if (record.promotionStatus === "proposed" && Number.isInteger(maxProposedAgeDays) && maxProposedAgeDays > 0) {
	    const ageDays = ageDaysSince(record.observedAt);
	    if (ageDays !== null && ageDays > maxProposedAgeDays) {
	      errors.push(`${prefix}: proposed record is ${ageDays} days old; promote, reject, or refresh it before the ${maxProposedAgeDays}-day limit`);
	    }
	  }
	  validateProposedPrevention(record.proposedPrevention, prefix, record.promotionStatus, record.preventionTarget);
  if (record.promotionStatus === "verified" && !record.observedResult) {
    errors.push(`${prefix}: observedResult is required when promotionStatus=verified`);
  }
  if (record.links !== undefined) validateStringArray(record.links, prefix, "links");
}

	if (opts.maxProposedAgeDays !== null && (!Number.isInteger(opts.maxProposedAgeDays) || opts.maxProposedAgeDays < 0)) {
	  errors.push("--max-proposed-age-days must be a non-negative integer");
	}

	const config = readConfig();
	const taxonomyPath = validateRepoLocalPath(opts.taxonomy, "taxonomy path")
	  ? resolve(ROOT, opts.taxonomy)
	  : resolve(ROOT, ".harness/failures/taxonomy.json");
const taxonomy = existsSync(taxonomyPath)
  ? validateTaxonomy(readJson(taxonomyPath), taxonomyPath)
  : null;
if (!taxonomy) {
  errors.push(`${rel(taxonomyPath)}: taxonomy file is required`);
}

const taxonomyClasses = new Map((taxonomy?.classes || []).map((cls) => [cls.id, cls]));
	const recordsDirValue = opts.recordsDir || taxonomy?.recordsDir || ".harness/failures/records";
	const maxProposedAgeDays = opts.maxProposedAgeDays ??
	  taxonomy?.maxProposedAgeDays ??
	  config.failureLearning?.maxProposedAgeDays ??
	  null;
	const recordsDir = validateRepoLocalPath(recordsDirValue, "recordsDir")
  ? resolve(ROOT, recordsDirValue)
  : null;
const records = recordsDir ? listJsonFiles(recordsDir) : [];
if (recordsDir && !existsSync(recordsDir)) {
  warnings.push(`${rel(recordsDir)} not found; no failure records to validate yet`);
}
const parsedRecords = [];
for (const file of records) {
  const record = readJson(file);
  parsedRecords.push({ path: file, record });
  validateRecord(record, file, taxonomyClasses, { maxProposedAgeDays });
}

function shellQuote(value) {
  return `'${String(value || "").replaceAll("'", "'\\''")}'`;
}

function recordNextSteps(items, taxonomyClasses) {
  const instructions = [];
  const commands = ["node .harness/scripts/check-failure-records.mjs"];
  const promotionTemplates = [];
  const staleProposed = [];
  const missingPreventions = [];
  const applied = [];

  for (const item of items) {
    const record = item.record;
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const recordPath = rel(item.path);
    const status = record.promotionStatus;
    const template = preventionTemplateFor({
      root: ROOT,
      recordId: record.id || basename(item.path, ".json"),
      primaryClass: record.primaryClass,
      preventionTarget: record.preventionTarget || taxonomyClasses.get(record.primaryClass)?.preferredPrevention,
      symptom: record.symptom,
    });
    const prevention = record.proposedPrevention || {
      path: template.path,
      summary: template.summary,
      verificationCommand: template.verificationCommand,
    };

    if ((status === "proposed" || status === "applied" || status === "verified") && !record.proposedPrevention) {
      missingPreventions.push({ id: record.id, path: recordPath, template: prevention });
    }
    if (status === "proposed") {
      const ageDays = ageDaysSince(record.observedAt);
      if (Number.isInteger(maxProposedAgeDays) && maxProposedAgeDays > 0 && ageDays !== null && ageDays > maxProposedAgeDays) {
        staleProposed.push({ id: record.id, path: recordPath, ageDays, template: prevention });
      }
      promotionTemplates.push({
        recordId: record.id,
        status: "applied",
        command: [
          "node .harness/scripts/record-failure.mjs",
          `--update=${record.id}`,
          "--status=applied",
          `--prevention-path=${shellQuote(prevention.path)}`,
          `--prevention-summary=${shellQuote(prevention.summary)}`,
          `--verification-command=${shellQuote(prevention.verificationCommand)}`,
        ].join(" "),
      });
    }
    if (status === "applied") {
      applied.push({ id: record.id, path: recordPath, prevention });
      promotionTemplates.push({
        recordId: record.id,
        status: "verified",
        command: `node .harness/scripts/record-failure.mjs --update=${record.id} --status=verified --observed-result=${shellQuote("<observed-result>")}`,
      });
    }
  }

  if (missingPreventions.length > 0) {
    instructions.push(`${missingPreventions.length} failure record(s) need a concrete proposedPrevention artifact path.`);
  }
  if (staleProposed.length > 0) {
    instructions.push(`${staleProposed.length} proposed failure record(s) are stale; promote, reject, or refresh them.`);
  }
  if (applied.length > 0) {
    instructions.push(`${applied.length} applied failure record(s) need verification and promotion to verified.`);
  }
  if (promotionTemplates.length > 0 && instructions.length === 0) {
    instructions.push("Promote or verify open failure records after implementing their prevention artifacts.");
  }
  return {
    instructions,
    commands,
    promotionTemplates,
    staleProposed,
    missingPreventions,
    applied,
  };
}

function printNextSteps(nextSteps, write = console.log) {
  if (!nextSteps || nextSteps.instructions.length === 0) return;
  write("check-failure-records: next steps");
  for (const instruction of nextSteps.instructions.slice(0, 4)) write(`  - ${instruction}`);
  for (const command of nextSteps.commands.slice(0, 3)) write(`  - ${command}`);
  if (nextSteps.promotionTemplates.length > 0) write(`  - ${nextSteps.promotionTemplates[0].command}`);
}

const nextSteps = recordNextSteps(parsedRecords, taxonomyClasses);

const payload = {
  status: errors.length === 0 ? "passed" : "failed",
  errors,
	  warnings,
	  maxProposedAgeDays,
	  recordsDir: recordsDir ? rel(recordsDir) : null,
	  records: records.map(rel),
  nextSteps,
	};

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2));
} else if (errors.length > 0) {
  console.error("check-failure-records: FAILED");
  for (const error of errors) console.error(`- ${error}`);
  for (const warning of warnings) console.error(`warning: ${warning}`);
  printNextSteps(nextSteps, console.error);
} else {
  console.log(`check-failure-records: OK (${records.length} records)`);
  if (recordsDir) console.log(`recordsDir: ${rel(recordsDir)}`);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  printNextSteps(nextSteps, console.log);
}
process.exit(errors.length === 0 ? 0 : 1);
