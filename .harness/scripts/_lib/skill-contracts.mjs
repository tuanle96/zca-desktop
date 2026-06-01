import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import {
  overbroadSensitiveBashPermission,
  permissionCovers,
  splitAllowedTools,
  uncoveredPermissions,
} from "./permission-matching.mjs";

export { splitAllowedTools };

export function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) fields[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return fields;
}

function sameSet(a = [], b = []) {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

function expandedPermissionAliases(permission) {
  if (permission === "Bash({{devCmd}})") {
    return [
      "Bash(npm run dev*)",
      "Bash(node ./src/server.js*)",
      "Bash(npm run start:dev*)",
      "Bash(uvicorn*)",
      "Bash(python manage.py runserver*)",
      "Bash(flask*)",
      "Bash(python -m app*)",
      "Bash(go run*)",
      "Bash(cargo run*)",
      "Bash(swift run*)",
      "Bash(./gradlew run*)",
    ];
  }
  return [permission];
}

export function expandPermissionAliases(permissions = []) {
  return permissions.flatMap(expandedPermissionAliases);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function skillIds(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function readSkillFrontmatter(skillDir) {
  for (const name of ["SKILL.md", "SKILL.md.hbs"]) {
    const path = join(skillDir, name);
    if (existsSync(path)) return parseFrontmatter(await readFile(path, "utf8"));
  }
  return {};
}

export async function readSkillContract(skillDir) {
  const contractPath = join(skillDir, "skill.json");
  if (!existsSync(contractPath)) return null;
  return await readJson(contractPath);
}

export async function discoverContracts(skillsDir) {
  const contracts = [];
  for (const id of await skillIds(skillsDir)) {
    const skillDir = join(skillsDir, id);
    const frontmatter = await readSkillFrontmatter(skillDir);
    const contract = await readSkillContract(skillDir);
    contracts.push({
      id,
      frontmatter,
      contract,
      source: normalizeRelative(skillDir),
    });
  }
  return contracts;
}

export async function validateSkillContracts({ skillsDir, registryPath, permissionsPath }) {
  const errors = [];
  const warnings = [];
  const discovered = await discoverContracts(skillsDir);
  const registry = existsSync(registryPath) ? await readJson(registryPath) : null;
  const permissions = existsSync(permissionsPath) ? await readJson(permissionsPath) : null;
  const registryById = new Map((registry?.skills || []).map((skill) => [skill.id, skill]));

  if (!registry) errors.push(`missing skill registry: ${registryPath}`);
  else if (registry.schemaVersion !== 1) errors.push("skill registry schemaVersion must be 1");

  for (const item of discovered) {
    const { id, frontmatter, contract } = item;
    // Gap 4 fix: validate each skill has SKILL.md or SKILL.md.hbs
    const skillDir = join(skillsDir, id);
    const hasSkillMd = existsSync(join(skillDir, "SKILL.md"));
    const hasSkillMdHbs = existsSync(join(skillDir, "SKILL.md.hbs"));
    if (!hasSkillMd && !hasSkillMdHbs) {
      errors.push(`${id}: missing SKILL.md and SKILL.md.hbs — at least one required`);
    }
    if (!contract) {
      errors.push(`${id}: missing skill.json`);
      continue;
    }
    if (contract.schemaVersion !== 1) errors.push(`${id}: skill.json schemaVersion must be 1`);
    if (contract.id !== id) errors.push(`${id}: skill.json id must match directory name`);
    if (frontmatter.name && contract.name !== frontmatter.name) errors.push(`${id}: skill.json name must match SKILL.md frontmatter`);
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(contract.version || "")) errors.push(`${id}: version must be semver`);
    if (!Array.isArray(contract.capabilities) || contract.capabilities.length === 0) errors.push(`${id}: capabilities must be a non-empty array`);
    if (!contract.permissions || typeof contract.permissions !== "object") errors.push(`${id}: permissions object is required`);
    for (const key of ["allow", "deny"]) {
      if (!Array.isArray(contract.permissions?.[key])) errors.push(`${id}: permissions.${key} must be an array`);
    }
    for (const permission of contract.permissions?.allow || []) {
      if (overbroadSensitiveBashPermission(permission)) {
        errors.push(`${id}: skill.json permissions.allow uses overbroad sensitive Bash grant ${permission}`);
      }
    }
    const registered = registryById.get(id);
    if (!registered) {
      errors.push(`${id}: missing from ${registryPath}`);
    } else {
      for (const key of ["name", "version"]) {
        if (registered[key] !== contract[key]) errors.push(`${id}: registry ${key} drift (${registered[key]} != ${contract[key]})`);
      }
      if (JSON.stringify(registered.capabilities || []) !== JSON.stringify(contract.capabilities || [])) {
        errors.push(`${id}: registry capabilities drift`);
      }
      if (!sameSet(registered.permissions?.allow || [], contract.permissions?.allow || [])) {
        errors.push(`${id}: registry permissions.allow drift from skill.json`);
      }
      if (!sameSet(registered.permissions?.deny || [], contract.permissions?.deny || [])) {
        errors.push(`${id}: registry permissions.deny drift from skill.json`);
      }
    }
    const declaredPermissions = contract.permissions || {};
    const policyPermissions = permissions?.skills?.[id];
    if ((declaredPermissions.allow?.length || declaredPermissions.deny?.length) && !policyPermissions) {
      errors.push(`${id}: declares explicit permissions but is missing from permissions policy`);
    }
    if (policyPermissions) {
      if (!sameSet(policyPermissions.allow || [], declaredPermissions.allow || [])) {
        errors.push(`${id}: permissions policy allow drift from skill.json`);
      }
      if (!sameSet(policyPermissions.deny || [], declaredPermissions.deny || [])) {
        errors.push(`${id}: permissions policy deny drift from skill.json`);
      }
    }
    const frontmatterAllow = expandPermissionAliases(splitAllowedTools(frontmatter["allowed-tools"]));
    if (frontmatterAllow.length > 0) {
      const deniedByContract = frontmatterAllow.filter((item) =>
        (declaredPermissions.deny || []).some((deniedPermission) => permissionCovers(deniedPermission, item))
      );
      for (const permission of deniedByContract) {
        errors.push(`${id}: SKILL.md frontmatter allows ${permission} but skill.json denies it`);
      }
      const undeclared = uncoveredPermissions(frontmatterAllow, declaredPermissions.allow || []);
      if (undeclared.length > 0) {
        errors.push(`${id}: SKILL.md frontmatter allowed-tools not declared in skill.json: ${undeclared.join(", ")}`);
      }
    }
  }

  const discoveredIds = new Set(discovered.map((item) => item.id));
  for (const skill of registry?.skills || []) {
    if (!discoveredIds.has(skill.id)) errors.push(`${skill.id}: registry entry has no matching skill directory`);
  }
  for (const skill of Object.keys(permissions?.skills || {})) {
    if (!discoveredIds.has(skill)) warnings.push(`${skill}: permissions policy entry has no matching skill directory`);
  }

  return {
    status: errors.length === 0 ? "passed" : "failed",
    skills: discovered.length,
    registrySkills: registry?.skills?.length || 0,
    errors,
    warnings,
  };
}

export async function validateSkillSurfaceParity({ registryPath, surfaces }) {
  const errors = [];
  const warnings = [];
  const registry = existsSync(registryPath) ? await readJson(registryPath) : null;
  const expectedIds = (registry?.skills || []).map((skill) => skill.id).sort();

  if (!registry) {
    return {
      status: "failed",
      errors: [`missing skill registry: ${registryPath}`],
      warnings,
    };
  }

  for (const surface of surfaces) {
    const surfacePath = surface.path;
    const surfaceLabel = `${surface.name} skills`;
    if (!existsSync(surfacePath)) {
      if (surface.required) errors.push(`${surfaceLabel}: missing surface at ${normalizeRelative(surfacePath)}`);
      continue;
    }
    const actualIds = await skillIds(surfacePath);
    const actualSet = new Set(actualIds);
    const expectedSet = new Set(expectedIds);
    const missing = expectedIds.filter((id) => !actualSet.has(id));
    const extra = actualIds.filter((id) => !expectedSet.has(id));
    if (missing.length > 0) {
      errors.push(`${surfaceLabel}: missing registry skill(s): ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      warnings.push(`${surfaceLabel}: extra skill(s) not in registry: ${extra.join(", ")}`);
    }
  }

  return {
    status: errors.length === 0 ? "passed" : "failed",
    errors,
    warnings,
  };
}

export async function compareSkillSurfaces(surfaces) {
  const entries = [];
  for (const surface of surfaces) {
    entries.push({ ...surface, ids: await skillIds(surface.path) });
  }
  const all = new Set(entries.flatMap((entry) => entry.ids));
  const drift = {};
  for (const entry of entries) {
    const set = new Set(entry.ids);
    drift[entry.name] = {
      count: entry.ids.length,
      missing: [...all].filter((id) => !set.has(id)).sort(),
      extra: entry.ids.filter((id) => ![...all].includes(id)).sort(),
    };
  }
  return { surfaces: entries.map(({ name, path, ids }) => ({ name, path: normalizeRelative(path), count: ids.length, ids })), drift };
}

export function normalizeRelative(path) {
  return relative(resolve("."), path).replaceAll("\\", "/") || ".";
}
