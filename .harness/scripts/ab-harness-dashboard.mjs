#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const cwd=process.cwd();
const root=resolve(cwd,'.harness/regression/results');
const out=process.argv.find(a=>a.startsWith('--out='))?.split('=')[1]||'.harness/regression/reports/ab-harness-dashboard.html';
const dirs=existsSync(root)?(await readdir(root,{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name).sort():[];
const runs=[]; for(const d of dirs){const p=join(root,d,'summary.json'); if(existsSync(p)){const s=JSON.parse(await readFile(p,'utf8')); if(/^(baseline|current)-r\d+$/.test(s.variant)) runs.push(s)}}
function group(prefix){return runs.filter(r=>r.variant.startsWith(prefix+'-r'))}
function avg(arr,k){return arr.length?arr.reduce((a,r)=>a+r[k],0)/arr.length:0}
const b=group('baseline'), c=group('current');
const decision=(avg(c,'passRate')>=avg(b,'passRate') && avg(c,'interventions')<=avg(b,'interventions')+2)?'SHIP':'HOLD';
const rows=[...b,...c].map(r=>`<tr><td>${r.variant}</td><td>${(r.passRate*100).toFixed(1)}%</td><td>${r.passed}/${r.total}</td><td>$${r.totalCostUSD.toFixed(4)}</td><td>${r.totalTokens.toLocaleString()}</td><td>${r.interventions}</td><td>${(r.durationMs/1000).toFixed(1)}s</td></tr>`).join('');
const html=`<!doctype html><html><head><meta charset="utf-8"><title>A/B Harness Dashboard</title><style>body{background:#09090b;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:32px}main{max-width:1100px;margin:auto}.card{background:#18181b;border:1px solid #27272a;border-radius:12px;padding:18px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.metric{background:#111113;border:1px solid #27272a;border-radius:12px;padding:14px}.value{font-size:30px;font-weight:800}.ok{color:#22c55e}.bad{color:#ef4444}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #27272a;text-align:left}th{color:#a1a1aa}code{background:#27272a;color:#fbbf24;padding:2px 4px;border-radius:4px}</style></head><body><main><h1>Tier 3 A/B Harness Evaluation</h1><div class="grid"><div class="metric"><div>Decision</div><div class="value ${decision==='SHIP'?'ok':'bad'}">${decision}</div></div><div class="metric"><div>Baseline avg pass</div><div class="value">${(avg(b,'passRate')*100).toFixed(1)}%</div></div><div class="metric"><div>Current avg pass</div><div class="value">${(avg(c,'passRate')*100).toFixed(1)}%</div></div><div class="metric"><div>Delta</div><div class="value">${((avg(c,'passRate')-avg(b,'passRate'))*100).toFixed(1)}pp</div></div></div><div class="card"><h2>Runs</h2><table><tr><th>Variant</th><th>Pass rate</th><th>Passed</th><th>Cost</th><th>Tokens</th><th>Interventions</th><th>Duration</th></tr>${rows}</table></div><div class="card"><h2>Gate</h2><p>Candidate ships if pass rate >= baseline and interventions <= baseline + 2.</p><p>Runs included: baseline=${b.length}, current=${c.length}</p></div></main></body></html>`;
await mkdir(dirname(resolve(cwd,out)),{recursive:true}); await writeFile(out,html); console.log(out);
