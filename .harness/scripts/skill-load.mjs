#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const args = process.argv.slice(2);
const examplesOnly = args.includes('--examples');
const name = args.find(arg => !arg.startsWith('--'));
if (!name) { console.error('Usage: node .harness/scripts/skill-load.mjs <skill-name> [--examples]'); process.exit(1); }
const root = process.cwd();
const skillDir = [
  `.claude/skills/${name}`,
  `.agents/skills/${name}`,
].map((rel) => resolve(root, rel)).find((candidate) => existsSync(candidate));
if (!skillDir) { console.error(`Skill not found: ${name}`); process.exit(1); }
if (examplesOnly) {
  const examplesDir = join(skillDir, 'examples');
  if (!existsSync(examplesDir)) { console.error(`Skill examples not found: ${name}`); process.exit(1); }
  const examples = readdirSync(examplesDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(json|jsonl)$/.test(entry.name))
    .map(entry => ({
      file: `examples/${entry.name}`,
      content: readFileSync(join(examplesDir, entry.name), 'utf8'),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
  console.log(JSON.stringify({ skill: name, examples }, null, 2));
  process.exit(0);
}
const path = join(skillDir, 'SKILL.md');
if (!existsSync(path)) { console.error(`Skill instructions not found: ${name}`); process.exit(1); }
console.log(readFileSync(path, 'utf8'));
