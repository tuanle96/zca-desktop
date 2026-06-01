#!/usr/bin/env node
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { argv, cwd } from 'node:process';
import { createEvalTaskPolicy } from './_lib/eval-task-policy.mjs';

function parseArgs(argv) {
  const opts = { tasksGlob: null, out: null, maxTurns: 30 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') continue;
    else if (a === '--tasks') opts.tasksGlob = argv[++i];
    else if (a.startsWith('--tasks=')) opts.tasksGlob = a.slice('--tasks='.length);
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
    else if (a === '--max-turns') opts.maxTurns = Number(argv[++i]);
    else if (a.startsWith('--max-turns=')) opts.maxTurns = Number(a.slice('--max-turns='.length));
  }
  return opts;
}

async function loadTasks(opts) {
  const dir = resolve(cwd(), '.harness/eval/tasks');
  let files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort();
  if (opts.tasksGlob) files = files.filter(f => f === opts.tasksGlob || f.includes(opts.tasksGlob));
  return Promise.all(files.map(async f => ({ ...JSON.parse(await readFile(join(dir, f), 'utf8')), _file: join(dir, f) })));
}

function preflightTasks(tasks) {
  const policy = createEvalTaskPolicy({ root: cwd() });
  const errors = tasks.flatMap(task => policy.validateTask(task, task._file ?? task.id ?? '<eval-task>'));
  if (errors.length) throw new Error(`eval task preflight failed:\n- ${errors.join('\n- ')}`);
}

function gitSha() {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); }
  catch { return 'no-git'; }
}

function gitDiffNames() {
  const out = execSync('git diff --name-only -- . ":!.harness/eval/results" ":!.harness/eval/transcripts"', { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).sort();
}

function snapshot(task = null) {
  return {
    diff: new Set(gitDiffNames()),
    required: new Map((task?.expected?.requiredFiles ?? []).map(f => [f, existsSync(resolve(cwd(), f)) ? 'exists' : 'missing'])),
  };
}

function deltaFiles(before, task = null) {
  const files = new Set(gitDiffNames().filter(f => !before.diff.has(f)));
  for (const f of task?.expected?.requiredFiles ?? []) {
    const abs = resolve(cwd(), f);
    const was = before.required.get(f);
    if (existsSync(abs) && was !== 'exists') files.add(f);
    else if (existsSync(abs) && was === 'exists') {
      const diff = gitDiffNames();
      if (diff.includes(f)) files.add(f);
    }
  }
  return [...files].sort();
}

async function runClaude(task, opts, transcriptPath) {
  const prompt = `${task.input}\n\nBenchmark harness requirements:\n- Use Edit, Write, or MultiEdit for file changes so the benchmark can observe changed files.\n- Do not use Bash/Python/Perl scripts to rewrite source files.\n- Make every required file change explicitly.\n- If a skill is required by the task, invoke it before editing.\n- End with a concise list of files changed and tests run.`;
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--max-turns', String(opts.maxTurns)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const events = [];
    let stderr = '';
    let buf = '';
    const ingest = async raw => {
      events.push(raw);
      await appendFile(transcriptPath, JSON.stringify(raw) + '\n');
    };
    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { ingest(JSON.parse(line)); } catch {}
      }
    });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('exit', code => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 1000)}`));
      resolve({ events, stderr });
    });
  });
}

function flattenedTools(events) {
  const tools = [];
  for (const raw of events) {
    if (raw.type !== 'assistant' || !raw.message?.content) continue;
    for (const block of raw.message.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'Skill' && block.input?.skill) tools.push({ tool: block.input.skill, path: null });
      tools.push({ tool: block.name, path: block.input?.file_path ?? block.input?.path ?? null });
    }
  }
  return tools;
}

function gradeProcess(task, tools) {
  const expected = task.expected?.skillsInvoked ?? [];
  if (!expected.length) return null;
  const invoked = new Set(tools.map(t => t.tool));
  const missing = expected.filter(s => !invoked.has(s));
  return { dim: 'process', score: missing.length ? 0 : 1, info: missing.length ? `missing skills: ${missing.join(', ')}` : 'all expected skills invoked' };
}

function gradeStyle(task, files) {
  const range = task.expected?.filesChanged;
  if (!range) return null;
  const count = files.length;
  const ok = count >= range.min && count <= range.max;
  return { dim: 'style', score: ok ? 1 : 0, info: `${count} files changed by git diff (expected ${range.min}-${range.max}): ${files.join(', ') || 'none'}` };
}

function gradeRequiredFiles(task, files) {
  const required = task.expected?.requiredFiles ?? [];
  if (!required.length) return null;
  const missing = required.filter(f => !files.includes(f));
  return { dim: 'required-files', score: missing.length ? 0 : 1, info: missing.length ? `missing: ${missing.join(', ')}` : 'all required files changed' };
}

function normalizeAcceptanceChecks(task) {
  const expected = task.expected ?? {};
  const checks = [];
  if (expected.acceptanceCheck) checks.push({ id: 'acceptance', command: expected.acceptanceCheck });
  for (const item of expected.acceptanceChecks ?? []) {
    checks.push(typeof item === 'string' ? { id: 'acceptance', command: item } : item);
  }
  return checks.filter(check => check?.command);
}

function outputFromExecError(error) {
  const stdout = error.stdout?.toString?.() || '';
  const stderr = error.stderr?.toString?.() || '';
  return `${stdout}\n${stderr}`.trim().slice(-500);
}

function gradeAcceptance(task) {
  const checks = normalizeAcceptanceChecks(task);
  if (!checks.length) return null;
  const results = checks.map((check, index) => {
    const id = check.id || `acceptance-${index + 1}`;
    try {
      execSync(check.command, { cwd: cwd(), shell: true, encoding: 'utf8', stdio: 'pipe', timeout: check.timeoutMs ?? 120000 });
      return { id, command: check.command, passed: true };
    } catch (error) {
      return { id, command: check.command, passed: false, output: outputFromExecError(error) };
    }
  });
  const failed = results.filter(result => !result.passed);
  return {
    dim: 'acceptance',
    score: failed.length ? 0 : 1,
    info: failed.length ? `acceptance checks failed: ${failed.map(r => r.id).join(', ')}` : `acceptance checks passed (${results.map(r => r.id).join(', ')})`,
    checks: results
  };
}

async function runEval(opts) {
  const tasks = await loadTasks(opts);
  preflightTasks(tasks);
  const sha = gitSha();
  const outPath = opts.out ?? resolve(cwd(), `.harness/eval/results/${sha}-v2.jsonl`);
  const transcriptDir = resolve(cwd(), '.harness/eval/transcripts');
  await mkdir(dirname(outPath), { recursive: true });
  await mkdir(transcriptDir, { recursive: true });
  const results = [];
  for (const task of tasks) {
    const before = snapshot(task);
    const transcriptPath = join(transcriptDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${task.id}.jsonl`);
    let transcript;
    try { transcript = await runClaude(task, opts, transcriptPath); }
    catch (error) { transcript = { events: [], stderr: error.message }; }
    const files = deltaFiles(before, task);
    const tools = flattenedTools(transcript.events);
    const grades = [gradeProcess(task, tools), gradeStyle(task, files), gradeRequiredFiles(task, files), gradeAcceptance(task)].filter(Boolean);
    const passed = grades.length > 0 && grades.every(g => g.score === 1);
    const row = { taskId: task.id, sha, ts: new Date().toISOString(), transcriptPath, filesChanged: files, toolUses: tools.length, grades, passed };
    results.push(row);
    await appendFile(outPath, JSON.stringify(row) + '\n');
  }
  return { results, passed: results.filter(r => r.passed).length, outPath, sha };
}

function summarize(summary) {
  console.log(`\nEval v2 ${summary.sha} — ${summary.passed}/${summary.results.length} passed (${summary.outPath})`);
  for (const r of summary.results) {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.taskId}`);
    for (const g of r.grades) console.log(`      ${g.score === 1 ? '✓' : '✗'} ${g.dim}: ${g.info}`);
    console.log(`      transcript: ${r.transcriptPath}`);
  }
}

const opts = parseArgs(argv);
try {
  const summary = await runEval(opts);
  summarize(summary);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
