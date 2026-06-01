#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const ROOT = process.cwd();
const colors = { reset:'\x1b[0m', bright:'\x1b[1m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m', cyan:'\x1b[36m', dim:'\x1b[2m' };
const c=(s,k)=>`${colors[k]||''}${s}${colors.reset}`;
function parseDuration(str='7d'){ const m=String(str).match(/^(\d+)([dhm])$/); if(!m) return 7*864e5; const n=+m[1]; return n*({m:6e4,h:36e5,d:864e5}[m[2]]); }
const argLast = process.argv.find(a=>a.startsWith('--last='));
const windowMs = parseDuration(argLast?.split('=')[1] || '7d');
const cutoff = Date.now() - windowMs;
function jsonl(path){ if(!existsSync(path)) return []; return readFileSync(path,'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean); }
const telemetry = jsonl(resolve(ROOT,'.harness/telemetry.jsonl')).filter(r => new Date(r.ts || 0).getTime() >= cutoff);
const providers = telemetry.filter(r=>r.event==='provider_call');
const bySession = new Map();
for (const p of providers) {
  const id = p.session_id || 'unknown';
  const s = bySession.get(id) || { input:0, output:0, calls:0 };
  s.input += p.input_tokens || 0; s.output += p.output_tokens || 0; s.calls++;
  bySession.set(id, s);
}
let config = {}; try { config = JSON.parse(readFileSync(resolve(ROOT,'.harness/config.json'),'utf8')); } catch {}
const budget = config.contextManagement || { maxInputTokensPerSession: 160000, warnAtPercent: 70, compactAtPercent: 85 };
const totalInput = providers.reduce((a,p)=>a+(p.input_tokens||0),0);
const totalOutput = providers.reduce((a,p)=>a+(p.output_tokens||0),0);
const total = totalInput + totalOutput;
const top = [...bySession.entries()].map(([id,s])=>({ id, ...s, total:s.input+s.output, pct: budget.maxInputTokensPerSession ? (s.input / budget.maxInputTokensPerSession)*100 : 0 })).sort((a,b)=>b.total-a.total).slice(0,5);
let snapshot = null; try { snapshot = JSON.parse(readFileSync(resolve(ROOT,'.harness/compaction-snapshot.json'),'utf8')); } catch {}
console.log(c('\n╔════════════════════════════════════════════════════════════════╗','bright'));
console.log(c('║                     CONTEXT HEALTH                             ║','bright'));
console.log(c('╚════════════════════════════════════════════════════════════════╝\n','bright'));
console.log(c('=== Token Pressure ===\n','bright'));
console.log(`  Provider calls:       ${c(String(providers.length),'cyan')}`);
console.log(`  Total input tokens:   ${totalInput.toLocaleString()}`);
console.log(`  Total output tokens:  ${totalOutput.toLocaleString()}`);
console.log(`  Total tokens:         ${c(total.toLocaleString(),'cyan')}`);
console.log(`  Input/output ratio:   ${totalOutput ? (totalInput/totalOutput).toFixed(2) : 'n/a'}`);
console.log('');
console.log(c('=== Session Budget ===\n','bright'));
console.log(`  Max input/session:    ${Number(budget.maxInputTokensPerSession || 0).toLocaleString()}`);
console.log(`  Warn threshold:       ${budget.warnAtPercent || 70}%`);
console.log(`  Compact threshold:    ${budget.compactAtPercent || 85}%`);
for (const s of top) {
  const level = s.pct >= (budget.compactAtPercent || 85) ? 'red' : s.pct >= (budget.warnAtPercent || 70) ? 'yellow' : 'green';
  console.log(`  ${s.id.slice(0,28).padEnd(28)} ${c(s.pct.toFixed(1)+'%', level)} input=${s.input.toLocaleString()} calls=${s.calls}`);
}
console.log('');
console.log(c('=== Compaction Snapshot ===\n','bright'));
if (snapshot) {
  console.log(`  Last compacted:       ${snapshot.compacted_at || 'unknown'}`);
  console.log(`  Trigger:              ${snapshot.trigger || 'unknown'}`);
  console.log(`  Tokens removed est:   ${Number(snapshot.estimated_tokens_removed || 0).toLocaleString()}`);
  console.log(`  Feature:              ${snapshot.feature || 'unknown'}`);
} else {
  console.log(`  ${c('No compaction snapshot found','dim')}`);
}
console.log('');
console.log(c('=== Recommendations ===\n','bright'));
if (!providers.length) console.log(`  ${c('No provider telemetry found for this window','yellow')}`);
else if (top[0]?.pct >= (budget.compactAtPercent || 85)) console.log(`  ${c('Compact now or split the work into a new session','red')}`);
else if (top[0]?.pct >= (budget.warnAtPercent || 70)) console.log(`  ${c('Prepare to compact after the next completed milestone','yellow')}`);
else console.log(`  ${c('Context pressure is healthy','green')}`);
console.log('');
