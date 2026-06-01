#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const dir = resolve(process.cwd(), process.argv.find(a=>a.startsWith('--dir='))?.split('=')[1] || '.harness/bench/results');
if (!existsSync(dir)) { console.error('No benchmark results directory found'); process.exit(1); }
const files = readdirSync(dir).filter(f=>f.endsWith('.json')).sort();
const byVariant = new Map();
for (const f of files) {
  const r = JSON.parse(readFileSync(join(dir,f),'utf8'));
  byVariant.set(r.variant || f, { file:f, ...r });
}
const variants = [...byVariant.values()].slice(-2);
if (variants.length < 2) { console.log(JSON.stringify({ variants: variants.length, message: 'Need two variants to compare' }, null, 2)); process.exit(0); }
const [base, candidate] = variants;
const delta = candidate.avgScore - base.avgScore;
const passDelta = candidate.passRate - base.passRate;
console.log(JSON.stringify({
  baseline: base.variant,
  candidate: candidate.variant,
  scoreDelta: Number(delta.toFixed(4)),
  passRateDelta: Number(passDelta.toFixed(4)),
  improved: delta >= 0 && passDelta >= 0,
  baselineFile: base.file,
  candidateFile: candidate.file,
}, null, 2));
