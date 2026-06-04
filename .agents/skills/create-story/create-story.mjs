#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const title = args.find(a => !a.startsWith('--'));
if (!title) {
  console.error('Usage: node .claude/skills/create-story/create-story.mjs "Feature title" [--classification=normal] [--hours=2] [--layers=service,runtime]');
  process.exit(1);
}
const opt = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
  const text = a.slice(2);
  const eq = text.indexOf('=');
  if (eq === -1) return [text, 'true'];
  return [text.slice(0, eq), text.slice(eq + 1)];
}));
const classification = opt.classification || 'normal';
if (!['tiny', 'normal', 'high-risk'].includes(classification)) {
  console.error('Invalid --classification. Expected one of: tiny, normal, high-risk');
  process.exit(1);
}
const hours = opt.hours || '2';
const today = new Date().toISOString().slice(0, 10);
const storiesDir = resolve(ROOT, '.harness/docs/stories');
mkdirSync(storiesDir, { recursive: true });

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'story';
}
function nextFeatureId() {
  const listPath = resolve(ROOT, '.harness/feature_list.json');
  if (!existsSync(listPath)) return 'feature-1';
  try {
    const data = JSON.parse(readFileSync(listPath, 'utf8'));
    const arr = Array.isArray(data) ? data : data.features || [];
    const nums = arr.map(f => String(f.id || '').match(/^feature-(\d+)$/)?.[1]).filter(Boolean).map(Number);
    return `feature-${Math.max(0, ...nums) + 1}`;
  } catch { return 'feature-1'; }
}
function readFeatureListDoc() {
  const listPath = resolve(ROOT, '.harness/feature_list.json');
  if (!existsSync(listPath)) {
    return {
      isArray: false,
      doc: {
        $schema: './.harness/feature-list.schema.json',
        version: '0.1',
        project: ROOT.split('/').filter(Boolean).at(-1) || 'project',
        features: [],
      },
      features: [],
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(listPath, 'utf8'));
    if (Array.isArray(parsed)) return { isArray: true, doc: parsed, features: parsed };
    return {
      isArray: false,
      doc: {
        $schema: parsed.$schema || './.harness/feature-list.schema.json',
        version: parsed.version || '0.1',
        project: parsed.project || ROOT.split('/').filter(Boolean).at(-1) || 'project',
        ...parsed,
        features: Array.isArray(parsed.features) ? parsed.features : [],
      },
      features: Array.isArray(parsed.features) ? parsed.features : [],
    };
  } catch {
    return { isArray: false, doc: { version: '0.1', features: [] }, features: [] };
  }
}
function writeFeatureListDoc(docInfo) {
  const listPath = resolve(ROOT, '.harness/feature_list.json');
  const payload = docInfo.isArray ? docInfo.features : { ...docInfo.doc, features: docInfo.features };
  writeFileSync(listPath, JSON.stringify(payload, null, 2) + '\n');
}
function readConfiguredLayers() {
  const configPath = resolve(ROOT, '.harness/config.json');
  if (!existsSync(configPath)) return [];
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const domains = Array.isArray(config.domains) ? config.domains : [];
    return [...new Set(domains.flatMap(domain => Array.isArray(domain.layers) ? domain.layers : []))];
  } catch {
    return [];
  }
}
function parseLayers(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}
function concrete(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^(tbd|todo|n\/a|na|fill me|replace me)$/i.test(text)) return '';
  return text;
}
function readDefaultVerificationCommand() {
  const pkgPath = resolve(ROOT, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const testScript = concrete(pkg.scripts?.test);
      if (testScript && !/no test specified/i.test(testScript)) return 'npm test';
    } catch {
      // Fall through to file-based defaults.
    }
  }
  if (existsSync(resolve(ROOT, 'pyproject.toml'))) return 'pytest -x';
  if (existsSync(resolve(ROOT, 'go.mod'))) return 'go test ./...';
  if (existsSync(resolve(ROOT, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(resolve(ROOT, 'Package.swift'))) return 'swift test';
  if (existsSync(resolve(ROOT, 'build.gradle')) || existsSync(resolve(ROOT, 'build.gradle.kts'))) return './gradlew test';
  return '';
}
function verificationFrom({ command, manual }) {
  const cmd = concrete(command);
  if (cmd) return { command: cmd };
  return { manual };
}
function recordProjectMemory({ id, title, classification, storyPath, reviewer }) {
  if (process.env.AHK_DISABLE_MEMORY === '1') return;
  const script = resolve(ROOT, '.harness/scripts/project-memory.mjs');
  if (!existsSync(script)) return;
  spawnSync(process.execPath, [
    script,
    'feature-created',
    '--feature-id', id,
    '--title', title,
    '--classification', classification,
    '--story-path', storyPath,
    '--status', 'story-draft',
    ...(reviewer ? ['--reviewer', reviewer] : []),
  ], { cwd: ROOT, stdio: 'ignore' });
}
const id = opt.id || nextFeatureId();
const storyPath = `.harness/docs/stories/${id}-${slugify(title)}.md`;
const taskContractPath = `.harness/task-contracts/${id}.json`;
const evidencePath = `.harness/evidence/${id}.json`;
const absStory = resolve(ROOT, storyPath);
if (existsSync(absStory)) {
  console.error(`Story already exists: ${storyPath}`);
  process.exit(1);
}
const absContract = resolve(ROOT, taskContractPath);
mkdirSync(resolve(ROOT, '.harness/task-contracts'), { recursive: true });
mkdirSync(resolve(ROOT, '.harness/evidence'), { recursive: true });
mkdirSync(resolve(ROOT, '.harness/reviews', id), { recursive: true });
const reviewer = classification === 'high-risk' ? (opt.reviewer || 'architecture-reviewer') : '';
const configuredLayers = readConfiguredLayers();
const allowedLayers = parseLayers(opt.layers || opt.allowedLayers);
if (classification === 'high-risk' && allowedLayers.length === 0) {
  console.error('High-risk stories must declare --layers=<layer[,layer]> so task scope can be enforced.');
  process.exit(1);
}
const unknownLayers = configuredLayers.length > 0
  ? allowedLayers.filter(layer => !configuredLayers.includes(layer))
  : [];
if (unknownLayers.length > 0) {
  console.error(`Unknown layer(s): ${unknownLayers.join(', ')}. Configured layers: ${configuredLayers.join(', ')}`);
  process.exit(1);
}
const defaultVerificationCommand = readDefaultVerificationCommand();
const primaryVerificationCommand = opt.verifyCommand || opt['verify-command'] || opt.verify || defaultVerificationCommand;
const regressionVerificationCommand = opt.regressionCommand || opt['regression-command'] || opt.regressionVerify || opt['regression-verify'] || defaultVerificationCommand;
const body = `# Story: ${title}

**ID:** ${id}
**Classification:** ${classification}
**Estimated Hours:** ${hours}
**Status:** draft
**Created:** ${today}
**Assigned Reviewer:** ${reviewer || 'n/a'}
**Task Contract:** \`${taskContractPath}\`
**Evidence Bundle:** \`${evidencePath}\`
**Review Decision:** ${reviewer ? `\`.harness/reviews/${id}/${reviewer}.json\`` : 'n/a'}
**Allowed Layers:** ${allowedLayers.length > 0 ? allowedLayers.join(', ') : 'to be narrowed before implementation'}

---

## Description

What needs to be built and why it matters.

---

## Acceptance Criteria

- [ ] **AC1:** Primary behavior is implemented and visible to the user.
- [ ] **AC2:** Error or empty state is handled at the system boundary.
- [ ] **AC3:** Existing behavior remains unchanged unless explicitly listed here.

---

## Test Expectations

### Unit Tests
- [ ] Core logic is covered where applicable.

### Integration Tests
- [ ] Main workflow is exercised end-to-end where practical.

### Manual Verification
- [ ] Golden path verified.
- [ ] Relevant edge case verified.

---

## Agent Work Units

- [ ] Inspect current implementation and affected files.
- [ ] Implement the smallest vertical slice.
- [ ] Run structural checks and targeted tests.
- [ ] Update feature tracking with proof.

---

## Dependencies

- **Blocks:** none
- **Blocked by:** none
- **Related ADRs:** ${classification === 'high-risk' ? 'required before implementation' : 'n/a'}

---

## Definition of Done

- [ ] All acceptance criteria met
- [ ] Every acceptance criterion has concrete verification in the task contract
- [ ] Evidence checks reference each acceptance criterion with \`acceptanceId\`
- [ ] Task contract has explicit \`permissions.allow\` before source/config mutation
- [ ] Tests or manual proof recorded
- [ ] Evidence bundle written and valid against \`.harness/schemas/evidence-bundle.schema.json\`
- [ ] Required reviewer decisions match \`.harness/schemas/review-decision.schema.json\`
- [ ] No new structural test violations
- [ ] Feature list entry links this story
${classification === 'high-risk' ? '- [ ] ADR accepted, reviewer completed, and no wildcard tool access is granted\n' : ''}`;
writeFileSync(absStory, body);

const taskContract = {
  schemaVersion: 1,
  id,
  type: 'feature',
  riskTier: classification,
  scope: {
    summary: title,
    goals: ['Deliver the story acceptance criteria'],
    nonGoals: [],
    allowedLayers,
  },
  acceptance: [
    {
      id: 'primary-behavior',
      description: 'Primary behavior is implemented and visible to the user.',
      verification: verificationFrom({
        command: primaryVerificationCommand,
        manual: `Capture a local artifact proving primary behavior for ${id}.`,
      }),
    },
    {
      id: 'regression-safety',
      description: 'Existing behavior remains unchanged unless explicitly listed.',
      verification: verificationFrom({
        command: regressionVerificationCommand,
        manual: `Capture a local artifact proving regression safety for ${id}.`,
      }),
    },
  ],
  requiresAdr: classification === 'high-risk',
  requiredReviewers: reviewer ? [reviewer] : [],
  permissions: {
    allow: [
      'Read',
      'Grep',
      'Glob',
      'LS',
      'Edit',
      'Write',
      'Bash(npm run*)',
      'Bash(pytest*)',
      'Bash(ruff*)',
      'Bash(go test*)',
      'Bash(cargo test*)',
      'Bash(swift test*)',
      'Bash(./gradlew test*)',
      'Bash(git status*)',
      'Bash(git diff*)',
      'Bash(git log*)',
    ],
    deny: [
      'Bash(git commit*)',
      'Bash(git push*)',
    ],
  },
  doneRequires: classification === 'high-risk'
    ? ['structural', 'tests', 'smoke', 'review', 'evidence-bundle']
    : ['structural', 'tests', 'smoke', 'evidence-bundle'],
  evidencePath,
};
writeFileSync(absContract, JSON.stringify(taskContract, null, 2) + '\n');

const featureDoc = readFeatureListDoc();
if (!featureDoc.features.some(f => f.id === id)) {
  featureDoc.features.push({
    id,
    title,
    passes: false,
    classification,
    estimatedHours: Number(hours),
    storyPath,
    taskContractPath,
    evidencePath,
    allowedLayers,
    requiresAdr: classification === 'high-risk',
    requiredReviewers: reviewer ? [reviewer] : [],
    status: 'story-draft',
    steps: [],
    updatedAt: new Date().toISOString(),
  });
  writeFeatureListDoc(featureDoc);
}
recordProjectMemory({ id, title, classification, storyPath, reviewer });
console.log(JSON.stringify({ id, title, classification, storyPath, taskContractPath, evidencePath, allowedLayers, status: 'created' }, null, 2));
