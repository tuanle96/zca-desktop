#!/usr/bin/env node
// feature-diff.mjs — deterministic gate for /refactor-feature.
// Diffs .harness/feature_list.json#features[*].steps[*] between a base ref and the
// current working copy. Returns violations when:
//   - step.passes flipped false → true without step.tests[] or step.testCommit
//   - step.id silently renamed (no renamed_from)
//   - step disappeared without replaced_by
//
// Exit codes:
//   0 → no violations
//   2 → violations present (printed as JSON to stdout)
//   3 → input error (missing ref / unreadable file)

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function parseArgs(argv) {
  const out = { beforeRef: "HEAD", afterFile: ".harness/feature_list.json" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--before-ref") out.beforeRef = argv[++i];
    else if (argv[i] === "--after-file") out.afterFile = argv[++i];
  }
  return out;
}

function gitShow(ref, path) {
  const r = spawnSync("git", ["show", `${ref}:${path}`], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout;
}

function safeJSON(s, label) {
  if (!s) return null;
  try { return JSON.parse(s); }
  catch (e) {
    console.error(`feature-diff: invalid JSON in ${label}: ${e.message}`);
    process.exit(3);
  }
}

function indexSteps(featureList) {
  // Returns { [stepId]: { featureId, step } }.
  const idx = new Map();
  for (const f of (featureList?.features || [])) {
    for (const s of (f.steps || [])) {
      if (s && s.id) idx.set(s.id, { featureId: f.id, step: s });
    }
  }
  return idx;
}

function diff(before, after) {
  const beforeIdx = indexSteps(before);
  const afterIdx = indexSteps(after);
  const violations = [];
  const renames = [];
  const doneTransitions = [];

  // Disappearances + done-transitions (work over before).
  for (const [id, { featureId, step }] of beforeIdx) {
    const post = afterIdx.get(id);
    if (!post) {
      // Disappeared. Allowed only when a replaced_by exists in the BEFORE
      // version OR an AFTER step references this id under renamed_from.
      let renamedAway = false;
      for (const [newId, { step: newStep }] of afterIdx) {
        if (Array.isArray(newStep.renamed_from) && newStep.renamed_from.includes(id)) {
          renamedAway = true;
          renames.push({ from: id, to: newId, kind: "renamed_from" });
          break;
        }
        if (newStep.renamed_from === id) {
          renamedAway = true;
          renames.push({ from: id, to: newId, kind: "renamed_from" });
          break;
        }
      }
      if (!renamedAway && !step.replaced_by) {
        violations.push({
          kind: "step_disappeared",
          step_id: id,
          feature_id: featureId,
          fix: `Add 'replaced_by: <new_step_id>' to the step before deleting, OR mark the new step's 'renamed_from'.`,
        });
      }
      continue;
    }
    // passes transition false → true.
    if (step.passes === false && post.step.passes === true) {
      doneTransitions.push({ step_id: id, feature_id: featureId });
      const hasTests = Array.isArray(post.step.tests) && post.step.tests.length > 0;
      const hasCommit = typeof post.step.testCommit === "string" && post.step.testCommit.length > 0;
      if (!hasTests && !hasCommit) {
        violations.push({
          kind: "done_without_proof",
          step_id: id,
          feature_id: featureId,
          fix: `Add 'tests: [...]' (test file paths) or 'testCommit: <sha>' before flipping passes:true.`,
        });
      }
    }
  }
  // Newly-introduced steps with renamed_from referring to nonexistent ids
  // (paranoia: catches typos in the renamed_from value).
  for (const [id, { step }] of afterIdx) {
    if (beforeIdx.has(id)) continue;
    const refs = Array.isArray(step.renamed_from) ? step.renamed_from
               : (typeof step.renamed_from === "string" ? [step.renamed_from] : []);
    for (const ref of refs) {
      if (!beforeIdx.has(ref)) {
        violations.push({
          kind: "renamed_from_typo",
          step_id: id,
          missing_ref: ref,
          fix: `'renamed_from' must reference a step that existed at HEAD. Check the spelling.`,
        });
      }
    }
  }
  return { violations, renames, doneTransitions };
}

function main() {
  const { beforeRef, afterFile } = parseArgs(process.argv.slice(2));
  const beforeRaw = gitShow(beforeRef, afterFile);
  if (beforeRaw === null) {
    // First-time addition — nothing to diff.
    process.stdout.write(JSON.stringify({ violations: [], note: `no prior ${afterFile} at ${beforeRef}` }) + "\n");
    process.exit(0);
  }
  const afterPath = resolve(ROOT, afterFile);
  if (!existsSync(afterPath)) {
    console.error(`feature-diff: missing ${afterFile} in working copy`);
    process.exit(3);
  }
  const before = safeJSON(beforeRaw, `${beforeRef}:${afterFile}`);
  const after = safeJSON(readFileSync(afterPath, "utf8"), afterFile);
  const result = diff(before, after);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.violations.length > 0) process.exit(2);
}

main();
