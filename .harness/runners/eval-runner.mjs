// .harness/runners/eval-runner.mjs — drive Claude Code through .harness/eval/tasks/*.json
// and grade each on outcome / process / style / efficiency.
//
// Per-task JSONL row goes to .harness/eval/results/<sha>.jsonl. On regression
// (any task failing in CI), exit 1 so the workflow blocks merge.
//
// Transports:
//   --transport=claude-cli  spawn `claude -p` and capture stream-json transcript (default)
//   --transport=mock        synthetic transcript — use in CI smoke-tests, no API key needed
//
// Sets:
//   --quick                 first 3 tasks (~$0.30, ~2 min on Sonnet)
//   --full                  all tasks (~$2, ~15 min)
//   --tasks <glob>          custom set
//
// Usage:
//   node .harness/runners/eval-runner.mjs --quick
//   node .harness/runners/eval-runner.mjs --full --transport=mock     # CI smoke-test
//   node .harness/runners/eval-runner.mjs --tasks 01-trivial-endpoint.json

import { readFile, writeFile, mkdir, readdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execSync } from "node:child_process";
import { argv, exit, env, cwd } from "node:process";

function parseArgs(argv) {
  const opts = {
    quick: false,
    full: false,
    tasksGlob: null,
    transport: "claude-cli",
    out: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quick") opts.quick = true;
    else if (a === "--full") opts.full = true;
    else if (a === "--tasks") opts.tasksGlob = argv[++i];
    else if (a.startsWith("--tasks=")) opts.tasksGlob = a.slice("--tasks=".length);
    else if (a === "--transport") opts.transport = argv[++i];
    else if (a.startsWith("--transport=")) opts.transport = a.slice("--transport=".length);
    else if (a === "--out") opts.out = argv[++i];
    else if (a.startsWith("--out=")) opts.out = a.slice("--out=".length);
    else if (a === "--help" || a === "-h") {
      console.log(USAGE);
      exit(0);
    }
  }
  return opts;
}

const USAGE = `Usage: node .harness/runners/eval-runner.mjs [--quick|--full|--tasks <glob>] [--transport <name>]

Transports:
  claude-cli   (default)  spawn \`claude -p\` and capture stream-json
  mock                    synthetic transcript for CI smoke-tests

See PUBLISHING.md for token budget and cost notes.`;

async function loadTasks(opts) {
  const dir = resolve(cwd(), ".harness/eval/tasks");
  if (!existsSync(dir)) {
    console.error(`No tasks directory at ${dir}. Run \`agent-harness-kit init\` first.`);
    exit(1);
  }
  let files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  if (opts.tasksGlob) {
    files = files.filter((f) => f === opts.tasksGlob || f.includes(opts.tasksGlob));
  } else if (opts.quick) {
    files = files.slice(0, 3);
  }
  const tasks = [];
  for (const f of files) {
    const t = JSON.parse(await readFile(join(dir, f), "utf8"));
    tasks.push({ ...t, _file: join(dir, f) });
  }
  return tasks;
}

async function loadEvalTaskPolicy() {
  const installedPolicy = resolve(cwd(), ".harness/scripts/_lib/eval-task-policy.mjs");
  if (existsSync(installedPolicy)) {
    return import(pathToFileURL(installedPolicy).href);
  }
  return import(new URL("../../scripts/_lib/eval-task-policy.mjs", import.meta.url).href);
}

async function preflightTasks(tasks) {
  const { createEvalTaskPolicy } = await loadEvalTaskPolicy();
  const policy = createEvalTaskPolicy({ root: cwd() });
  const errors = tasks.flatMap((task) => policy.validateTask(task, task._file ?? task.id ?? "<eval-task>"));
  if (errors.length > 0) {
    throw new Error(`eval task preflight failed:\n- ${errors.join("\n- ")}`);
  }
}

// ---- transports ----

const TRANSPORTS = {
  // Real driver: spawn `claude -p` with stream-json output and flatten the
  // wire format into the same shape the mock transport produces (so the
  // graders don't have to know about both shapes).
  //
  // Real wire format (Claude Code 2.1.x):
  //   {type:"assistant", message:{content:[{type:"tool_use", name, input}]}}
  //   {type:"user", message:{content:[{type:"tool_result", ...}]}}
  //   {type:"result", usage:{input_tokens, output_tokens, cache_*}, total_cost_usd}
  //
  // Flat shape graders consume:
  //   {type:"tool_use", tool:<name>, path:<input.file_path|input.path>}
  //   {type:"token_usage", total:<sum of all token fields>}
  "claude-cli": (task) =>
    new Promise((resolve, reject) => {
      const proc = spawn(
        "claude",
        [
          "-p",
          task.input,
          "--output-format",
          "stream-json",
          "--verbose",
          "--max-turns",
          "20",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const events = [];
      let stderr = "";
      let buf = "";
      const ingest = (raw) => {
        // Always keep the raw event for debugging.
        events.push({ raw, type: raw.type });
        // Flatten tool_use blocks from assistant messages.
        if (raw.type === "assistant" && raw.message?.content) {
          for (const block of raw.message.content) {
            if (block.type !== "tool_use") continue;
            // /skill invocations come in as the Skill tool with input.skill.
            if (block.name === "Skill" && block.input?.skill) {
              events.push({ type: "tool_use", tool: block.input.skill });
            }
            const path =
              block.input?.file_path ?? block.input?.path ?? null;
            events.push({ type: "tool_use", tool: block.name, path });
          }
        }
        // Final result has aggregated usage.
        if (raw.type === "result" && raw.usage) {
          const u = raw.usage;
          const total =
            (u.input_tokens ?? 0) +
            (u.output_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0);
          events.push({ type: "token_usage", total });
        }
      };
      proc.stdout.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            ingest(JSON.parse(line));
          } catch {
            /* non-JSON line (rare) — ignore */
          }
        }
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", reject);
      proc.on("exit", (code) => {
        if (code !== 0) {
          return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        }
        resolve({ events, stderr });
      });
    }),

  // Mock transport — produces a synthetic transcript that satisfies the
  // default expectations of the shipped tasks. Used in CI to verify the
  // driver shape end-to-end without burning API tokens.
  mock: async (task) => {
    const expected = task.expected ?? {};
    const events = [];
    for (const skill of expected.skillsInvoked ?? []) {
      events.push({ type: "tool_use", tool: skill });
    }
    const minFiles = expected.filesChanged?.min ?? 1;
    for (let i = 0; i < minFiles; i++) {
      events.push({ type: "tool_use", tool: "Write", path: `src/mock-${i}.ts` });
    }
    events.push({
      type: "token_usage",
      total: Math.min(expected.tokensMax ?? 5000, 5000),
    });
    return { events, stderr: "" };
  },
};

// ---- graders ----

function gradeOutcome(task) {
  if (task.expected?.structuralTest !== "pass") {
    return { dim: "outcome", score: null, info: "no expectation" };
  }
  const command = structuralCheckCommand();
  if (!command) {
    return { dim: "outcome", score: 0, info: "no structural test command found" };
  }
  try {
    execSync(command, { stdio: "ignore", shell: true });
    return { dim: "outcome", score: 1, info: `structural test passed (${command})` };
  } catch {
    return { dim: "outcome", score: 0, info: `structural test failed (${command})` };
  }
}

function structuralCheckCommand() {
  if (existsSync(resolve(cwd(), ".harness/runners/structural-check.mjs"))) {
    return "node .harness/runners/structural-check.mjs";
  }
  if (existsSync(resolve(cwd(), ".harness/runners/structural-test.mjs"))) {
    return "node .harness/runners/structural-test.mjs";
  }
  if (existsSync(resolve(cwd(), ".harness/runners/structural_check.go"))) {
    return "go run .harness/runners/structural_check.go";
  }
  if (existsSync(resolve(cwd(), ".harness/runners/structural_test.py"))) {
    return "python .harness/runners/structural_test.py";
  }
  if (existsSync(resolve(cwd(), "package.json"))) {
    return "npm run --silent harness:check";
  }
  return null;
}

function gradeProcess(task, transcript) {
  const expected = task.expected?.skillsInvoked ?? [];
  if (expected.length === 0) return { dim: "process", score: null };
  const invoked = new Set(
    transcript.events.filter((e) => e.type === "tool_use").map((e) => e.tool),
  );
  const missing = expected.filter((s) => !invoked.has(s));
  return {
    dim: "process",
    score: missing.length === 0 ? 1 : 0,
    info:
      missing.length === 0
        ? "all expected skills invoked"
        : `missing skills: ${missing.join(", ")}`,
  };
}

function gradeStyle(task, transcript) {
  const range = task.expected?.filesChanged;
  if (!range) return { dim: "style", score: null };
  const writes = transcript.events.filter(
    (e) => e.type === "tool_use" && (e.tool === "Write" || e.tool === "Edit" || e.tool === "MultiEdit"),
  );
  const distinct = new Set(writes.map((e) => e.path).filter(Boolean)).size;
  const ok = distinct >= range.min && distinct <= range.max;
  return {
    dim: "style",
    score: ok ? 1 : 0,
    info: `${distinct} files changed (expected ${range.min}-${range.max})`,
  };
}

function gradeEfficiency(task, transcript) {
  const cap = task.expected?.tokensMax;
  if (!cap) return { dim: "efficiency", score: null };
  const tokens = transcript.events
    .filter((e) => e.type === "token_usage")
    .reduce((sum, e) => sum + (e.total ?? 0), 0);
  return {
    dim: "efficiency",
    score: tokens <= cap ? 1 : 0,
    info: `${tokens} tokens (cap ${cap})`,
  };
}

function normalizeAcceptanceChecks(task, transportName) {
  const expected = task.expected ?? {};
  const checks = [];
  if (expected.acceptanceCheck) {
    checks.push({
      id: "acceptance",
      command: expected.acceptanceCheck,
      // Backward compatibility: legacy single-string acceptance checks were
      // authored for real agent runs. Mock transport does not mutate fixtures.
      transports: ["claude-cli"],
    });
  }
  for (const item of expected.acceptanceChecks ?? []) {
    checks.push(typeof item === "string" ? { id: "acceptance", command: item } : item);
  }
  return checks.filter((check) => {
    if (!check?.command) return false;
    if (Array.isArray(check.transports) && !check.transports.includes(transportName)) return false;
    if (Array.isArray(check.skipTransports) && check.skipTransports.includes(transportName)) return false;
    return true;
  });
}

function commandOutputFromError(err) {
  const stdout = err.stdout?.toString?.() || "";
  const stderr = err.stderr?.toString?.() || "";
  return `${stdout}\n${stderr}`.trim().slice(-500);
}

function gradeAcceptance(task, transportName) {
  const checks = normalizeAcceptanceChecks(task, transportName);
  if (checks.length === 0) return { dim: "acceptance", score: null };
  const results = [];
  for (const [idx, check] of checks.entries()) {
    const id = check.id || `acceptance-${idx + 1}`;
    const command = check.command;
    try {
      execSync(command, {
        cwd: cwd(),
        encoding: "utf8",
        shell: true,
        stdio: "pipe",
        timeout: check.timeoutMs ?? 120_000,
      });
      results.push({ id, command, passed: true });
    } catch (err) {
      results.push({
        id,
        command,
        passed: false,
        output: commandOutputFromError(err),
      });
    }
  }
  const failed = results.filter((result) => !result.passed);
  return {
    dim: "acceptance",
    score: failed.length === 0 ? 1 : 0,
    info:
      failed.length === 0
        ? `acceptance checks passed (${results.map((result) => result.id).join(", ")})`
        : `acceptance checks failed: ${failed.map((result) => result.id).join(", ")}`,
    checks: results,
  };
}

function gitSha() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "no-git";
  }
}

export async function runEval(opts = {}) {
  const tasks = await loadTasks(opts);
  if (tasks.length === 0) {
    console.error("No tasks matched.");
    return { results: [], passed: 0 };
  }
  await preflightTasks(tasks);
  const transport = TRANSPORTS[opts.transport ?? "claude-cli"];
  if (!transport) {
    console.error(
      `Unknown transport: ${opts.transport}. Try: ${Object.keys(TRANSPORTS).join(", ")}`,
    );
    exit(2);
  }

  const sha = gitSha();
  const outPath = opts.out ?? resolve(cwd(), `.harness/eval/results/${sha}.jsonl`);
  await mkdir(dirname(outPath), { recursive: true });

  const results = [];
  for (const task of tasks) {
    let transcript;
    try {
      transcript = await transport(task);
    } catch (err) {
      transcript = { events: [], stderr: err.message };
    }
    const grades = [
      gradeOutcome(task),
      gradeProcess(task, transcript),
      gradeStyle(task, transcript),
      gradeEfficiency(task, transcript),
      gradeAcceptance(task, opts.transport ?? "claude-cli"),
    ].filter((g) => g.score !== null);

    const passed = grades.length > 0 && grades.every((g) => g.score === 1);
    const row = {
      taskId: task.id,
      sha,
      ts: new Date().toISOString(),
      grades,
      passed,
    };
    results.push(row);
    await appendFile(outPath, JSON.stringify(row) + "\n");
  }

  return { results, passed: results.filter((r) => r.passed).length, outPath, sha };
}

function summarize({ results, passed, outPath, sha }) {
  console.log(`\nEval run ${sha} — ${passed}/${results.length} passed (${outPath})`);
  for (const r of results) {
    const mark = r.passed ? "✓" : "✗";
    console.log(`  ${mark} ${r.taskId}`);
    for (const g of r.grades) {
      const m = g.score === 1 ? "✓" : "✗";
      console.log(`      ${m} ${g.dim}: ${g.info}`);
    }
  }
}

// CLI entry — only runs when invoked directly, not when imported by tests.
if (import.meta.url === `file://${argv[1]}`) {
  const opts = parseArgs(argv);
  try {
    const summary = await runEval(opts);
    summarize(summary);
    if (env.CI === "true" && summary.passed < summary.results.length) exit(1);
  } catch (error) {
    console.error(error.message);
    exit(1);
  }
}
