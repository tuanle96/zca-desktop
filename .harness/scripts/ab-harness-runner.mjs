#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2);
const repeats=Number(args.find(a=>a.startsWith('--repeats='))?.split('=')[1]||1);
const transport=args.find(a=>a.startsWith('--transport='))?.split('=')[1]||'mock';
const limit=Number(args.find(a=>a.startsWith('--limit='))?.split('=')[1]||24);
const maxTurns=Number(args.find(a=>a.startsWith('--max-turns='))?.split('=')[1]||15);
const runs=[];
for (const variant of ['baseline','current']) {
  for (let i=1;i<=repeats;i++) {
    const v=`${variant}-r${i}`;
    const runnerArgs=['.harness/scripts/regression-runner.mjs',`--transport=${transport}`,`--variant=${v}`,`--limit=${limit}`,`--max-turns=${maxTurns}`,`--harness-variant=.harness/variants/${variant}`];
    if (variant==='baseline') runnerArgs.push('--no-hydrate-skills');
    const res=spawnSync('node',runnerArgs,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
    process.stdout.write(res.stdout); process.stderr.write(res.stderr);
    if(res.status!==0) process.exit(res.status);
    try { runs.push(JSON.parse(res.stdout)); } catch {}
  }
}
console.log(JSON.stringify({runs},null,2));
