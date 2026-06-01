#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const ROOT = process.cwd();
const outPath = resolve(ROOT, '.harness/skill-index.json');
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  return Object.fromEntries(m[1].split('\n').map(l => l.match(/^([^:]+):\s*(.*)$/)).filter(Boolean).map(([,k,v]) => [k.trim(), v.trim()]));
}
function discoverSurface(surface, skillsDir) {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true }).filter(e=>e.isDirectory()).map(e => {
    const skillPath = join(skillsDir, e.name, 'SKILL.md');
    const text = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : '';
    const fm = parseFrontmatter(text);
    const examplesDir = join(skillsDir, e.name, 'examples');
    const examples = existsSync(examplesDir)
      ? readdirSync(examplesDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && /\.(json|jsonl)$/.test(entry.name))
        .map(entry => `${surface}/${e.name}/examples/${entry.name}`)
        .sort()
      : [];
    return { name: fm.name || e.name, description: fm.description || '', path: `${surface}/${e.name}/SKILL.md`, surface, loaded: false, examples };
  });
}
const byName = new Map();
for (const skill of [
  ...discoverSurface('.claude/skills', resolve(ROOT, '.claude/skills')),
  ...discoverSurface('.agents/skills', resolve(ROOT, '.agents/skills')),
]) {
  if (!byName.has(skill.name)) byName.set(skill.name, skill);
}
const skills = [...byName.values()].sort((a,b)=>a.name.localeCompare(b.name));
mkdirSync(resolve(ROOT, '.harness'), { recursive: true });
writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), count: skills.length, skills }, null, 2) + '\n');
console.log(JSON.stringify({ outPath, count: skills.length }, null, 2));
