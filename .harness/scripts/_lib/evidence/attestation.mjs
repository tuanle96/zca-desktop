import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    taskId: "",
    name: "",
    evidencePath: "",
    append: false,
    json: false,
    summary: "",
  };
  const command = [];
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--") {
      command.push(...argv.slice(idx + 1));
      break;
    } else if (arg === "--json") opts.json = true;
    else if (arg === "--append") opts.append = true;
    else if (arg === "--task") opts.taskId = String(argv[++idx] || "").trim();
    else if (arg.startsWith("--task=")) opts.taskId = arg.slice("--task=".length).trim();
    else if (arg === "--name") opts.name = String(argv[++idx] || "").trim();
    else if (arg.startsWith("--name=")) opts.name = arg.slice("--name=".length).trim();
    else if (arg === "--evidence") opts.evidencePath = String(argv[++idx] || "").trim();
    else if (arg.startsWith("--evidence=")) opts.evidencePath = arg.slice("--evidence=".length).trim();
    else if (arg === "--summary") opts.summary = String(argv[++idx] || "").trim();
    else if (arg.startsWith("--summary=")) opts.summary = arg.slice("--summary=".length).trim();
    else if (arg === "--cwd") opts.cwd = resolve(String(argv[++idx] || process.cwd()));
    else if (arg.startsWith("--cwd=")) opts.cwd = resolve(arg.slice("--cwd=".length));
  }
  return { opts, command };
}

function stableId(value) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(String(value || ""));
}

function inferCheckName(command) {
  const text = command.join(" ").toLowerCase();
  if (/\b(harness:check|structural|structural-test)\b/.test(text)) return "structural";
  if (/\b(lint|ruff|clippy|detekt|go vet)\b/.test(text)) return "lint";
  if (/\b(test|vitest|jest|pytest|go test|cargo test)\b/.test(text)) return "tests";
  if (/\b(verify-ui|playwright|browser|ui)\b/.test(text)) return "ui";
  if (/\b(curl|smoke)\b/.test(text)) return "smoke";
  return "check";
}

function quoteArg(arg) {
  const text = String(arg);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function commandText(command) {
  return command.map(quoteArg).join(" ");
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gitOutput(cwd, args, encoding = "utf8") {
  const result = spawnSync("git", args, {
    cwd,
    encoding,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function gitHead(cwd) {
  return String(gitOutput(cwd, ["rev-parse", "HEAD"]) || "unknown").trim() || "unknown";
}

function workingTreeHash(cwd) {
  const diff = gitOutput(cwd, ["diff", "--binary", "HEAD", "--", "."], "buffer");
  const status = gitOutput(cwd, ["status", "--porcelain=v1", "-z"], "buffer");
  if (Buffer.isBuffer(diff) && Buffer.isBuffer(status)) {
    return sha256(Buffer.concat([diff, Buffer.from("\0"), status]));
  }
  return sha256(`nogit:${cwd}`);
}

function toRepoPath(root, path) {
  const rel = relative(root, path).replaceAll("\\", "/");
  return rel && rel !== "" ? rel : ".";
}

function runId(name, startedAt) {
  return `${name}-${startedAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
}

function appendCheck({ root, evidencePath, taskId, check }) {
  const target = resolve(root, evidencePath || `.harness/evidence/${taskId}.json`);
  if (!target.startsWith(root.endsWith("/") ? root : `${root}/`)) {
    throw new Error(`${evidencePath}: evidence path must stay inside the project root`);
  }
  if (!existsSync(target)) {
    throw new Error(`${toRepoPath(root, target)} not found; create the evidence bundle before using --append`);
  }
  const evidence = JSON.parse(readFileSync(target, "utf8"));
  evidence.checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  const idx = evidence.checks.findIndex((item) => item?.name === check.name);
  if (idx >= 0) evidence.checks[idx] = check;
  else evidence.checks.push(check);
  evidence.updatedAt = new Date().toISOString();
  writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
  return toRepoPath(root, target);
}

function renderText(payload) {
  const lines = [
    "evidence-run:",
    `- task: ${payload.taskId}`,
    `- check: ${payload.check.name}`,
    `- status: ${payload.check.status}`,
    `- exitCode: ${payload.check.exitCode}`,
    `- record: ${payload.recordPath}`,
    `- stdout: ${payload.check.stdoutPath}`,
    `- stderr: ${payload.check.stderrPath}`,
  ];
  if (payload.appendedTo) lines.push(`- appendedTo: ${payload.appendedTo}`);
  if (payload.error) lines.push(`- error: ${payload.error}`);
  return `${lines.join("\n")}\n`;
}

export async function runEvidenceCli(argv = [], { exit = true } = {}) {
  const { opts, command } = parseArgs(argv);
  const root = resolve(opts.cwd);
  const taskId = opts.taskId;
  const name = opts.name || inferCheckName(command);
  const errors = [];
  if (!stableId(taskId)) errors.push("--task must be a stable lowercase id");
  if (!stableId(name)) errors.push("--name must be a stable lowercase id when provided");
  if (command.length === 0) errors.push("missing command after --");
  if (errors.length > 0) {
    const payload = { status: "failed", errors };
    if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stderr.write(`evidence-run: FAILED\n- ${errors.join("\n- ")}\n`);
    if (exit) process.exit(2);
    return { payload, exitCode: 2 };
  }

  const startedAt = new Date().toISOString();
  const id = runId(name, startedAt);
  const recordDir = resolve(root, ".harness/evidence", taskId, "checks", id);
  mkdirSync(recordDir, { recursive: true });

  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: process.env,
    encoding: "buffer",
    maxBuffer: 50 * 1024 * 1024,
  });
  const finishedAt = new Date().toISOString();
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from("");
  const stderrParts = [];
  if (Buffer.isBuffer(result.stderr)) stderrParts.push(result.stderr);
  if (result.error) stderrParts.push(Buffer.from(`${result.error.message}\n`));
  const stderr = Buffer.concat(stderrParts);
  const exitCode = Number.isInteger(result.status) ? result.status : 1;

  const stdoutPath = resolve(recordDir, "stdout.txt");
  const stderrPath = resolve(recordDir, "stderr.txt");
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);

  const check = {
    name,
    command: commandText(command),
    status: exitCode === 0 ? "pass" : "fail",
    summary: opts.summary || `${commandText(command)} exited ${exitCode}`,
    exitCode,
    cwd: ".",
    startedAt,
    finishedAt,
    gitHead: gitHead(root),
    workingTreeHash: workingTreeHash(root),
    stdoutHash: sha256(stdout),
    stderrHash: sha256(stderr),
    stdoutPath: toRepoPath(root, stdoutPath),
    stderrPath: toRepoPath(root, stderrPath),
    artifactPaths: [toRepoPath(root, stdoutPath), toRepoPath(root, stderrPath)],
  };

  const recordPath = resolve(recordDir, "check.json");
  writeFileSync(recordPath, `${JSON.stringify(check, null, 2)}\n`);

  const payload = {
    status: check.status,
    taskId,
    recordPath: toRepoPath(root, recordPath),
    check,
  };
  try {
    if (opts.append) payload.appendedTo = appendCheck({ root, evidencePath: opts.evidencePath, taskId, check });
  } catch (err) {
    payload.status = "failed";
    payload.error = err.message;
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(renderText(payload));
  const finalExitCode = payload.error ? 1 : exitCode;
  if (exit) process.exit(finalExitCode);
  return { payload, exitCode: finalExitCode };
}
