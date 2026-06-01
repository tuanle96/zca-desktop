#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile, appendFile, rm, cp } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { cwd, env } from 'node:process';
import { tmpdir } from 'node:os';

function parseArgs() {
  const opts = { transport: 'mock', variant: 'current', tasksDir: '.harness/regression/tasks', outDir: '.harness/regression/results', limit: 0, maxTurns: 20, isolated: true, harnessVariant: null, hydrateSkills: true, permissionMode: 'bypassPermissions', sessions: 1, qualityThreshold: 0, decayThreshold: 0 };
  for (let i=2;i<process.argv.length;i++) {
    const a=process.argv[i];
    if (a.startsWith('--transport=')) opts.transport=a.split('=')[1];
    else if (a.startsWith('--variant=')) opts.variant=a.split('=')[1];
    else if (a.startsWith('--limit=')) opts.limit=Number(a.split('=')[1]);
    else if (a.startsWith('--out-dir=')) opts.outDir=a.split('=')[1];
    else if (a.startsWith('--tasks-dir=')) opts.tasksDir=a.split('=')[1];
    else if (a.startsWith('--harness-variant=')) opts.harnessVariant=a.split('=')[1];
    else if (a.startsWith('--max-turns=')) opts.maxTurns=Number(a.split('=')[1]);
    else if (a==='--no-isolation') opts.isolated=false;
    else if (a==='--no-hydrate-skills') opts.hydrateSkills=false;
  else if (a.startsWith('--permission-mode=')) opts.permissionMode=a.split('=')[1];
    else if (a.startsWith('--sessions=')) opts.sessions=Math.max(1, Number(a.split('=')[1]) || 1);
    else if (a.startsWith('--quality-threshold=')) opts.qualityThreshold=Number(a.split('=')[1]) || 0;
    else if (a.startsWith('--decay-threshold=')) opts.decayThreshold=Number(a.split('=')[1]) || 0;
  }
  return opts;
}
const opts=parseArgs();
const ROOT=cwd();
const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+opts.variant;
const outDir=resolve(ROOT, opts.outDir, runId);
const transcriptDir=join(outDir,'transcripts');
const workDir=join(tmpdir(), 'ahk-regression-workspaces', runId);
await mkdir(transcriptDir,{recursive:true}); await mkdir(workDir,{recursive:true});

async function loadTasks() {
  let files=(await readdir(resolve(ROOT,opts.tasksDir))).filter(f=>f.endsWith('.json')).sort();
  if (opts.limit) files=files.slice(0,opts.limit);
  return Promise.all(files.map(async f=>JSON.parse(await readFile(resolve(ROOT,opts.tasksDir,f),'utf8'))));
}
function sh(cmd, dir=ROOT) { return execSync(cmd,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(); }


async function applyHarnessVariant(dir) {
  if (!opts.harnessVariant) return;
  const variantDir = resolve(ROOT, opts.harnessVariant);
  if (!existsSync(variantDir)) return;
  await cp(variantDir, dir, { recursive: true, force: true });
}

function hydrateSkills(dir) {
  const src = resolve(dir, 'src/templates/.claude/skills');
  const dst = resolve(dir, '.claude/skills');
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });

  function copySkillTree(fromDir, toDir) {
    mkdirSync(toDir, { recursive: true });
    for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
      if (entry.name.endsWith('.vi') || entry.name.endsWith('.vi.hbs')) continue;
      const from = resolve(fromDir, entry.name);
      const toName = entry.name === 'SKILL.md.hbs' ? 'SKILL.md' : entry.name;
      const to = resolve(toDir, toName);
      if (entry.isDirectory()) {
        copySkillTree(from, to);
      } else {
        copyFileSync(from, to);
      }
    }
  }

  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    copySkillTree(resolve(src, entry.name), resolve(dst, entry.name));
  }
}

async function prepareWorkspace(task, sessionIndex = 1) {
  if (!opts.isolated) return ROOT;
  const dir=join(workDir,`${task.id}-s${sessionIndex}`);
  await rm(dir,{recursive:true,force:true});
  await mkdir(dirname(dir),{recursive:true});
  await cp(ROOT,dir,{recursive:true,filter:(src)=>!src.includes('/.git') && !src.includes('/node_modules') && !src.includes('/.harness/regression/results')});
  await applyHarnessVariant(dir);
  if (opts.hydrateSkills) hydrateSkills(dir);
  return dir;
}
function diffNames(dir) { try { return sh('git diff --name-only -- .',dir).split('\n').filter(Boolean).sort(); } catch { return []; } }
async function runMock(task, dir, transcriptPath) {
  for (const f of task.expected?.requiredFiles ?? []) {
    const abs=resolve(dir,f); await mkdir(dirname(abs),{recursive:true}); await writeFile(abs,`${task.failureClass}\nprevention note\n`);
  }
  const events=[{type:'mock', taskId:task.id, costUSD:0, inputTokens:0, outputTokens:0}];
  await writeFile(transcriptPath, events.map(JSON.stringify).join('\n')+'\n');
  return {events, costUSD:0, tokens:0, interventions:0};
}
async function runClaude(task, dir, transcriptPath) {
  const prompt=`${task.input}\n\nRegression benchmark requirements:\n- Use Write/Edit/MultiEdit for file changes.\n- Do not modify unrelated files.\n- If required, invoke the named skill first.\n- End with files changed.`;
  return new Promise((resolveRun)=>{
    const proc=spawn('claude',['-p',prompt,'--output-format','stream-json','--verbose','--permission-mode',opts.permissionMode,'--max-turns',String(opts.maxTurns)],{cwd:dir,stdio:['ignore','pipe','pipe']});
    const events=[]; let stderr=''; let buf='';
    proc.stdout.on('data',chunk=>{buf+=chunk.toString(); const lines=buf.split('\n'); buf=lines.pop()??''; for(const line of lines){ if(!line.trim()) continue; try{const r=JSON.parse(line); events.push(r); appendFile(transcriptPath,JSON.stringify(r)+'\n');}catch{}}});
    proc.stderr.on('data',c=>stderr+=c.toString());
    proc.on('exit',()=>{
      const result=events.find(e=>e.type==='result')||{};
      const usage=result.usage||{};
      const tokens=(usage.input_tokens||0)+(usage.output_tokens||0)+(usage.cache_creation_input_tokens||0)+(usage.cache_read_input_tokens||0);
      resolveRun({events, stderr, costUSD:result.total_cost_usd||0, tokens, interventions:(result.permission_denials||[]).length});
    });
  });
}
function flattenTools(events){const tools=[]; for(const e of events){if(e.type==='assistant') for(const b of e.message?.content||[]) if(b.type==='tool_use'){if(b.name==='Skill'&&b.input?.skill) tools.push(b.input.skill); tools.push(b.name);}} return tools;}
function hiddenCheck(check, dir, files, tools){
  if(check.type==='file-contains'){const p=resolve(dir,check.path); return existsSync(p)&&readFileSync(p,'utf8').includes(check.text);}
  if(check.type==='no-file-contains'){const p=resolve(dir,check.path); return !existsSync(p)||!readFileSync(p,'utf8').includes(check.text);}
  if(check.type==='max-files') return files.length<=check.max;
  if(check.type==='skill-invoked') return tools.includes(check.skill) || opts.transport==='mock';
  return false;
}
async function grade(task, dir, run){
  const files=[...new Set([...diffNames(dir), ...(task.expected?.requiredFiles||[]).filter(f=>existsSync(resolve(dir,f)))])].sort();
  const range=task.expected?.filesChanged; const tools=flattenTools(run.events);
  const grades=[];
  if(range) grades.push({dim:'files',score:files.length>=range.min&&files.length<=range.max?1:0,info:`${files.length} files (${range.min}-${range.max})`});
  const missing=(task.expected?.requiredFiles||[]).filter(f=>!existsSync(resolve(dir,f)));
  grades.push({dim:'required-files',score:missing.length?0:1,info:missing.length?`missing ${missing.join(', ')}`:'all present'});
  const checks=task.expected?.hiddenChecks||[];
  const failed=checks.filter(c=>!hiddenCheck(c,dir,files,tools));
  grades.push({dim:'hidden-checks',score:failed.length?0:1,info:failed.length?`${failed.length}/${checks.length} failed`:`${checks.length}/${checks.length} passed`});
  return {files, grades, passed:grades.every(g=>g.score===1)};
}
const tasks=await loadTasks();
const rows=[]; const startAll=Date.now();
for(let sessionIndex=1; sessionIndex<=opts.sessions; sessionIndex++){
  for(const task of tasks){
    const dir=await prepareWorkspace(task, sessionIndex); const attemptId=`${task.id}-s${sessionIndex}`; const transcriptPath=join(transcriptDir,`${attemptId}.jsonl`); const start=Date.now();
    const run=opts.transport==='claude-cli'?await runClaude(task,dir,transcriptPath):await runMock(task,dir,transcriptPath);
    const graded=await grade(task,dir,run);
    rows.push({taskId:task.id,attemptId,sessionIndex,failureClass:task.failureClass,variant:opts.variant,transport:opts.transport,workspace:dir,transcriptPath,durationMs:Date.now()-start,costUSD:run.costUSD,tokens:run.tokens,interventions:run.interventions,filesChanged:graded.files,grades:graded.grades,passed:graded.passed});
  }
}
function multiSessionStats(rows) {
  const byTask = new Map();
  const bySession = new Map();
  for (const row of rows) {
    if (!byTask.has(row.taskId)) byTask.set(row.taskId, []);
    byTask.get(row.taskId).push(row);
    if (!bySession.has(row.sessionIndex)) bySession.set(row.sessionIndex, []);
    bySession.get(row.sessionIndex).push(row);
  }
  const tasks = Array.from(byTask.entries()).map(([taskId, taskRows]) => {
    const passed = taskRows.filter(r => r.passed).length;
    const outcomes = new Set(taskRows.map(r => r.passed ? 'pass' : 'fail'));
    return {
      taskId,
      attempts: taskRows.length,
      passed,
      passRate: taskRows.length ? passed / taskRows.length : 0,
      flaky: outcomes.size > 1,
      avgDurationMs: taskRows.reduce((sum, r) => sum + r.durationMs, 0) / taskRows.length,
      avgTokens: taskRows.reduce((sum, r) => sum + r.tokens, 0) / taskRows.length,
    };
  }).sort((a, b) => a.taskId.localeCompare(b.taskId));
  const sessions = Array.from(bySession.entries()).map(([sessionIndex, sessionRows]) => {
    const passed = sessionRows.filter(r => r.passed).length;
    return {
      sessionIndex,
      total: sessionRows.length,
      passed,
      passRate: sessionRows.length ? passed / sessionRows.length : 0,
      totalCostUSD: sessionRows.reduce((sum, r) => sum + r.costUSD, 0),
      totalTokens: sessionRows.reduce((sum, r) => sum + r.tokens, 0),
    };
  }).sort((a, b) => a.sessionIndex - b.sessionIndex);
  const first = sessions[0]?.passRate ?? 0;
  const last = sessions[sessions.length - 1]?.passRate ?? first;
  return {
    sessions,
    tasks,
    flakyTasks: tasks.filter(t => t.flaky).map(t => t.taskId),
    temporal: {
      firstPassRate: first,
      lastPassRate: last,
      qualityDecay: Math.max(0, first - last),
    },
  };
}
const passed=rows.filter(r=>r.passed).length;
const multiSession=multiSessionStats(rows);
const summary={runId,variant:opts.variant,transport:opts.transport,ts:new Date().toISOString(),durationMs:Date.now()-startAll,taskCount:tasks.length,sessions:opts.sessions,total:rows.length,passed,passRate:rows.length?passed/rows.length:0,totalCostUSD:rows.reduce((a,r)=>a+r.costUSD,0),totalTokens:rows.reduce((a,r)=>a+r.tokens,0),interventions:rows.reduce((a,r)=>a+r.interventions,0),qualityThreshold:opts.qualityThreshold,decayThreshold:opts.decayThreshold,multiSession,results:rows};
await writeFile(join(outDir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
await writeFile(join(outDir,'results.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
console.log(JSON.stringify({outDir,total:summary.total,passed:summary.passed,passRate:summary.passRate,totalCostUSD:summary.totalCostUSD,totalTokens:summary.totalTokens,interventions:summary.interventions},null,2));
if (opts.qualityThreshold > 0 && summary.passRate < opts.qualityThreshold) {
  console.error(`quality threshold failed: ${summary.passRate.toFixed(3)} < ${opts.qualityThreshold}`);
  process.exitCode = 1;
}
if (opts.decayThreshold > 0 && summary.multiSession.temporal.qualityDecay > opts.decayThreshold) {
  console.error(`quality decay threshold failed: ${summary.multiSession.temporal.qualityDecay.toFixed(3)} > ${opts.decayThreshold}`);
  process.exitCode = 1;
}
