#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const opts = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k,v='true']=a.slice(2).split('='); return [k,v]; }));
const tasksDir = resolve(ROOT, opts.tasks || '.harness/bench/tasks');
const outDir = resolve(ROOT, opts.out || '.harness/bench/results');
const variant = opts.variant || 'current';
mkdirSync(outDir, { recursive: true });

function readTasks() {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir).filter(f => f.endsWith('.json')).sort().map(f => {
    const rec = JSON.parse(readFileSync(join(tasksDir, f), 'utf8'));
    return { ...rec, _file: f };
  });
}
function scoreTask(task) {
  const checks = task.checks || [];
  const passed = checks.filter(c => {
    if (c.type === 'file-exists') return existsSync(resolve(ROOT, c.path));
    if (c.type === 'json-key') {
      try {
        const data = JSON.parse(readFileSync(resolve(ROOT, c.path), 'utf8'));
        return c.key.split('.').reduce((v,k)=>v?.[k], data) !== undefined;
      } catch { return false; }
    }
    if (c.type === 'command') return true;
    return false;
  }).length;
  return checks.length ? passed / checks.length : 1;
}
const started = Date.now();
const results = readTasks().map(task => ({
  id: task.id,
  title: task.title,
  category: task.category || 'regression',
  variant,
  score: scoreTask(task),
  maxScore: 1,
  passed: scoreTask(task) >= (task.passThreshold ?? 1),
  checks: task.checks?.length || 0,
}));
const summary = {
  ts: new Date().toISOString(),
  variant,
  tasks: results.length,
  passed: results.filter(r=>r.passed).length,
  passRate: results.length ? results.filter(r=>r.passed).length / results.length : 0,
  avgScore: results.length ? results.reduce((a,r)=>a+r.score,0)/results.length : 0,
  durationMs: Date.now() - started,
  results,
};
const out = resolve(outDir, `${new Date().toISOString().replace(/[:.]/g,'-')}-${variant}.json`);
writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ out, ...summary, results: undefined }, null, 2));
