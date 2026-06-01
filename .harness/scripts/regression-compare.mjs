#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root=resolve(process.cwd(),'.harness/regression/results');
if(!existsSync(root)){console.log(JSON.stringify({error:'no results'}));process.exit(0)}
const dirs=(await readdir(root,{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name).sort();
const runs=[]; for(const d of dirs){const p=join(root,d,'summary.json'); if(existsSync(p)) runs.push(JSON.parse(await readFile(p,'utf8')))}
const byVariant=new Map(runs.map(r=>[r.variant,r])); const vals=[...byVariant.values()].slice(-2);
if(vals.length<2){console.log(JSON.stringify({variants:vals.length,message:'Need two variants'}));process.exit(0)}
const [a,b]=vals; console.log(JSON.stringify({baseline:a.variant,candidate:b.variant,passRateDelta:b.passRate-a.passRate,costDelta:b.totalCostUSD-a.totalCostUSD,tokenDelta:b.totalTokens-a.totalTokens,regressedTasks:b.results.filter(r=>!r.passed).map(r=>r.taskId)},null,2));
