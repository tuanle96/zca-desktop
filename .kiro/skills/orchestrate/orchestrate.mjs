#!/usr/bin/env node
import { mkdir, writeFile, appendFile, readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, isAbsolute, relative } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const PATTERNS = {
  pipeline: ["Explore current state", "Plan implementation", "Implement scoped change", "Review result"],
  fanout: ["Search implementation patterns", "Search tests and validation", "Search docs and user-facing behavior"],
  fanin: ["Collect candidate approaches", "Compare tradeoffs", "Recommend one path"],
  "expert-pool": ["Architecture review", "Security review", "Reliability review"],
  "red-team": ["Find failure modes", "Find unsafe assumptions", "Find missing verification"],
  supervisor: ["Define subtasks", "Assign owners", "Track blockers and completion"],
};

function parseArgs(argv) {
  const opts = {
    pattern: "fanout",
    run: false,
    transport: defaultTransport(),
    maxConcurrency: 3,
    maxTurns: 8,
    failFast: true,
    outDir: null,
    permissionMode: "bypassPermissions",
    model: defaultModel(),
    sandbox: null,
    timeoutMs: 180_000,
    retries: 0,
    contract: null,
    resume: null,
    cancel: null,
    validateRun: null,
    telemetry: true,
    mockDelayMs: 0,
    mockFail: new Set(),
    mockFailOnce: new Set(),
    specified: new Set(),
  };
  const taskParts = [];

  for (const arg of argv) {
    if (arg === "--run") opts.run = true;
    else if (arg === "--no-fail-fast") opts.failFast = false;
    else if (arg === "--no-telemetry") opts.telemetry = false;
    else if (arg.startsWith("--pattern=")) {
      opts.pattern = arg.slice("--pattern=".length);
      opts.specified.add("pattern");
    } else if (arg.startsWith("--transport=")) {
      opts.transport = arg.slice("--transport=".length);
      opts.specified.add("transport");
    } else if (arg.startsWith("--max-concurrency=")) {
      opts.maxConcurrency = parsePositiveInt(arg.slice("--max-concurrency=".length), opts.maxConcurrency);
      opts.specified.add("maxConcurrency");
    } else if (arg.startsWith("--max-turns=")) {
      opts.maxTurns = parsePositiveInt(arg.slice("--max-turns=".length), opts.maxTurns);
      opts.specified.add("maxTurns");
    }
    else if (arg.startsWith("--out-dir=")) opts.outDir = arg.slice("--out-dir=".length);
    else if (arg.startsWith("--contract=")) {
      opts.contract = arg.slice("--contract=".length);
      opts.specified.add("contract");
    }
    else if (arg.startsWith("--permission-mode=")) {
      opts.permissionMode = arg.slice("--permission-mode=".length);
      opts.specified.add("permissionMode");
    } else if (arg.startsWith("--sandbox=")) {
      opts.sandbox = arg.slice("--sandbox=".length);
      opts.specified.add("sandbox");
    } else if (arg.startsWith("--model=")) {
      opts.model = arg.slice("--model=".length);
      opts.specified.add("model");
    }
    else if (arg.startsWith("--timeout-ms=")) {
      opts.timeoutMs = parsePositiveInt(arg.slice("--timeout-ms=".length), opts.timeoutMs);
      opts.specified.add("timeoutMs");
    } else if (arg.startsWith("--retries=")) {
      opts.retries = parseNonNegativeInt(arg.slice("--retries=".length), opts.retries);
      opts.specified.add("retries");
    }
    else if (arg.startsWith("--resume=")) {
      opts.run = true;
      opts.resume = arg.slice("--resume=".length);
    } else if (arg.startsWith("--cancel=")) {
      opts.cancel = arg.slice("--cancel=".length);
    } else if (arg.startsWith("--validate-run=")) {
      opts.validateRun = arg.slice("--validate-run=".length);
    } else if (arg.startsWith("--mock-delay-ms=")) {
      opts.mockDelayMs = parseNonNegativeInt(arg.slice("--mock-delay-ms=".length), opts.mockDelayMs);
    } else if (arg.startsWith("--mock-fail=")) {
      opts.mockFail = csvSet(arg.slice("--mock-fail=".length));
    } else if (arg.startsWith("--mock-fail-once=")) {
      opts.mockFailOnce = csvSet(arg.slice("--mock-fail-once=".length));
    }
    else if (!arg.startsWith("--")) taskParts.push(arg);
  }

  if (!opts.specified.has("model")) opts.model = defaultModelForTransport(opts.transport);
  return { task: taskParts.join(" ").trim(), opts };
}

function usage() {
  console.error('Usage: node .claude/skills/orchestrate/orchestrate.mjs "task" [--pattern=fanout] [--run] [--transport=claude-cli|codex-cli|kiro-cli|mock]');
  console.error('       node .claude/skills/orchestrate/orchestrate.mjs "task" --contract=<id-or-path> [--run]');
  console.error("       node .claude/skills/orchestrate/orchestrate.mjs --resume=<run-id-or-dir>");
  console.error("       node .claude/skills/orchestrate/orchestrate.mjs --validate-run=<run-id-or-dir>");
  console.error("       node .claude/skills/orchestrate/orchestrate.mjs --cancel=<run-id-or-dir>");
}

function defaultTransport() {
  if (process.env.AHK_ORCHESTRATE_TRANSPORT) return process.env.AHK_ORCHESTRATE_TRANSPORT;
  if (process.env.AHK_RUNTIME === "codex") return "codex-cli";
  if (process.env.AHK_RUNTIME === "kiro") return "kiro-cli";
  const scriptPath = String(process.argv[1] || "").split("\\").join("/");
  if (scriptPath.includes("/.agents/skills/")) return "codex-cli";
  if (scriptPath.includes("/.kiro/skills/")) return "kiro-cli";
  return "claude-cli";
}

function defaultModel() {
  if (process.env.AHK_ORCHESTRATE_MODEL) return process.env.AHK_ORCHESTRATE_MODEL;
  return defaultModelForTransport(defaultTransport());
}

function defaultModelForTransport(transport) {
  if (process.env.AHK_ORCHESTRATE_MODEL) return process.env.AHK_ORCHESTRATE_MODEL;
  if (transport === "codex" || transport === "codex-cli") {
    return process.env.AHK_E2E_CODEX_MODEL || "";
  }
  if (transport === "kiro" || transport === "kiro-cli") {
    return process.env.AHK_E2E_KIRO_MODEL || "";
  }
  return process.env.AHK_E2E_CLAUDE_MODEL || "";
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function csvSet(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function stepsFor(pattern) {
  return PATTERNS[pattern] || PATTERNS.fanout;
}

function repoRelative(path) {
  return relative(process.cwd(), path).split("\\").join("/") || ".";
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function hashFileIfExists(path) {
  try {
    return sha256(await readFile(path));
  } catch {
    return "";
  }
}

function resolveProjectPath(value) {
  if (!value) return null;
  if (isAbsolute(value) || value.startsWith(".") || value.includes("/")) {
    return resolve(process.cwd(), value);
  }
  return resolve(process.cwd(), ".harness/orchestration/contracts", `${value}.json`);
}

async function loadContract(value) {
  if (!value) return null;
  const path = resolveProjectPath(value);
  if (!(await pathExists(path))) {
    throw new Error(`Orchestration contract not found: ${value}`);
  }
  const contract = await readJson(path);
  return {
    ...contract,
    _path: repoRelative(path),
  };
}

function lanesFor(pattern, contract) {
  if (Array.isArray(contract?.lanes) && contract.lanes.length > 0) {
    return contract.lanes.map((lane, index) => ({
      id: lane.id || `lane-${index + 1}`,
      index,
      step: lane.title || lane.id || `Lane ${index + 1}`,
      prompt: lane.prompt,
      role: lane.role || "explore",
      toolPolicy: lane.toolPolicy || "read-only",
      required: lane.required !== false,
      requiredReviewer: lane.requiredReviewer || null,
      requiresEvidence: lane.requiresEvidence === true,
      outputPath: lane.outputPath || null,
    }));
  }
  return stepsFor(pattern).map((step, index) => ({
    id: `agent-${index + 1}`,
    index,
    step,
    prompt: null,
    role: "explore",
    toolPolicy: "read-only",
    required: true,
    requiredReviewer: null,
    requiresEvidence: false,
    outputPath: null,
  }));
}

function agentPrompt(task, pattern, lane, index, contract) {
  if (lane.prompt) {
    return `You are lane ${lane.id} in an agent-harness-kit ${pattern} orchestration.

Task:
${task}

Task contract: ${contract?.taskId || "none"}
Feature: ${contract?.featureId || "none"}
Tool policy: ${lane.toolPolicy}
Required output: ${lane.outputPath || "concise findings in transcript"}

Your bounded slice:
${lane.prompt}

Rules:
- Stay inside this lane and its tool policy.
- Prefer read-only inspection unless this lane is explicitly mutating.
- Report concise findings, critical files, risks, and recommended next action.
- Include verification evidence when you run commands.
`;
  }
  return `You are agent ${index + 1} in an agent-harness-kit ${pattern} orchestration.

Task:
${task}

Your bounded slice:
${lane.step}

Rules:
- Stay inside this slice.
- Prefer read-only inspection unless this prompt explicitly asks for implementation.
- Report concise findings, critical files, risks, and recommended next action.
- Include verification evidence when you run commands.
`;
}

function createManifest(task, pattern, opts, runId, outDir, contract = null) {
  const lanes = lanesFor(pattern, contract);
  return {
    schemaVersion: 1,
    runId,
    task,
    pattern,
    contractId: contract?.id || null,
    contractPath: contract?._path || null,
    taskId: contract?.taskId || null,
    featureId: contract?.featureId || null,
    requiredReviewers: contract?.requiredReviewers || [],
    requiredArtifacts: contract?.requiredArtifacts || ["manifest", "summary", "transcripts"],
    transport: opts.transport,
    maxConcurrency: opts.maxConcurrency,
    maxTurns: opts.maxTurns,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    permissionMode: opts.permissionMode,
    sandbox: opts.sandbox,
    model: opts.model,
    failFast: opts.failFast,
    outDir,
    createdAt: new Date().toISOString(),
    agents: lanes.map((lane, index) => ({
      id: `agent-${index + 1}`,
      laneId: lane.id,
      index,
      step: lane.step,
      role: lane.role,
      toolPolicy: lane.toolPolicy,
      required: lane.required,
      requiredReviewer: lane.requiredReviewer,
      requiresEvidence: lane.requiresEvidence,
      outputPath: lane.outputPath,
      prompt: agentPrompt(task, pattern, lane, index, contract),
    })),
  };
}

async function writePacket(task, pattern, contract = null) {
  const dir = resolve(process.cwd(), ".harness/docs/orchestration");
  await mkdir(dir, { recursive: true });
  const created = new Date().toISOString();
  const path = `.harness/docs/orchestration/${timestamp()}-${pattern}.md`;
  const manifest = createManifest(task, pattern, { transport: "packet", maxConcurrency: 0, failFast: true }, "packet", "", contract);
  const body = `# Orchestration Packet: ${pattern}

**Task:** ${task}
**Contract:** ${contract?._path || "none"}
**Created:** ${created}
**Synthesis owner:** main agent

## Agent prompts

${manifest.agents.map((agent) => `### ${agent.id}: ${agent.step}

Lane: ${agent.laneId}
Role: ${agent.role}
Tool policy: ${agent.toolPolicy}
Output: ${agent.outputPath || "transcript"}

${agent.prompt}
`).join("\n")}
## Completion checklist

${manifest.agents.map((agent) => `- [ ] ${agent.step}`).join("\n")}
- [ ] Main agent synthesizes results and chooses next step
`;
  await writeFile(resolve(process.cwd(), path), body);
  return { pattern, agents: manifest.agents.length, path, task, contractId: contract?.id || null };
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolveSleep) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolveSleep(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolveSleep(true);
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function runMockAgent(agent, transcriptPath, opts, attempt, signal) {
  if (opts.mockDelayMs > 0) {
    const completed = await sleep(opts.mockDelayMs, signal);
    if (!completed || signal?.aborted) {
      return {
        exitCode: 124,
        events: [],
        stderr: `timeout after ${opts.timeoutMs}ms`,
        output: "",
        timedOut: true,
      };
    }
  }
  const shouldFail = opts.mockFail.has(agent.id) || (attempt === 1 && opts.mockFailOnce.has(agent.id));
  const event = {
    type: "result",
    subtype: "mock",
    agent_id: agent.id,
    total_cost_usd: shouldFail ? 0.0002 : 0.0001,
    usage: {
      input_tokens: agent.prompt.length,
      output_tokens: 64,
      cache_creation_input_tokens: 8,
      cache_read_input_tokens: 16,
    },
    is_error: shouldFail,
    result: shouldFail ? `Mock failure for ${agent.step}` : `Mock result for ${agent.step}`,
  };
  await writeFile(transcriptPath, JSON.stringify(event) + "\n");
  return { exitCode: shouldFail ? 1 : 0, events: [event], stderr: shouldFail ? "mock failure" : "", output: event.result };
}

async function runClaudeAgent(agent, transcriptPath, opts) {
  return await new Promise((resolveRun) => {
    let timedOut = false;
    const proc = spawn(
      "claude",
      [
        "-p",
        agent.prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        ...(opts.model ? ["--model", opts.model] : []),
        "--permission-mode",
        opts.permissionMode,
        "--max-turns",
        String(opts.maxTurns),
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 2_000).unref();
    }, opts.timeoutMs);
    timeout.unref();

    const events = [];
    let stderr = "";
    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          events.push(event);
          appendFile(transcriptPath, JSON.stringify(event) + "\n");
        } catch {
          appendFile(transcriptPath, JSON.stringify({ type: "raw", line }) + "\n");
        }
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      const result = [...events].reverse().find((event) => event.type === "result") || {};
      resolveRun({
        exitCode: timedOut ? 124 : code ?? 1,
        events,
        stderr: timedOut ? `${stderr}\ntimeout after ${opts.timeoutMs}ms`.trim() : stderr,
        output: result.result || "",
        timedOut,
      });
    });
  });
}

function codexSandboxForAgent(agent, opts) {
  if (opts.sandbox) return opts.sandbox;
  return agent.toolPolicy === "mutating" ? "workspace-write" : "read-only";
}

function codexTextFromEvent(event) {
  if (!event || typeof event !== "object") return "";
  if (typeof event.result === "string") return event.result;
  if (typeof event.message === "string") return event.message;
  if (typeof event.text === "string") return event.text;
  if (typeof event.output === "string") return event.output;
  const item = event.item || event.msg || event.delta;
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    if (typeof item.text === "string") return item.text;
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) {
      return item.content
        .map((part) => typeof part === "string" ? part : part?.text || part?.content || "")
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

function codexUsageFromEvents(events) {
  for (const event of [...events].reverse()) {
    if (event?.usage && typeof event.usage === "object") return event.usage;
    if (event?.token_usage && typeof event.token_usage === "object") return event.token_usage;
  }
  return {};
}

function codexCostFromEvents(events) {
  for (const event of [...events].reverse()) {
    const value =
      event?.total_cost_usd ??
      event?.cost_usd ??
      event?.cost?.total_cost_usd ??
      event?.cost?.usd;
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function codexModelFromEvents(events, fallback = "") {
  for (const event of [...events].reverse()) {
    if (typeof event?.model === "string" && event.model) return event.model;
    if (typeof event?.response?.model === "string" && event.response.model) return event.response.model;
  }
  return fallback;
}

async function runCodexAgent(agent, transcriptPath, opts) {
  return await new Promise((resolveRun) => {
    let timedOut = false;
    const lastMessagePath = transcriptPath.replace(/\.jsonl$/, ".last-message.txt");
    const proc = spawn(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-rules",
        "--json",
        "--sandbox",
        codexSandboxForAgent(agent, opts),
        "-C",
        process.cwd(),
        "-o",
        lastMessagePath,
        ...(opts.model ? ["--model", opts.model] : []),
        agent.prompt,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 2_000).unref();
    }, opts.timeoutMs);
    timeout.unref();

    const events = [];
    const rawLines = [];
    let stderr = "";
    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          rawLines.push(line);
        }
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("exit", async (code) => {
      clearTimeout(timeout);
      if (buffer.trim()) {
        try {
          events.push(JSON.parse(buffer));
        } catch {
          rawLines.push(buffer);
        }
      }
      for (const line of rawLines) {
        events.push({ type: "raw", line });
      }
      const lastMessage = await pathExists(lastMessagePath)
        ? await readFile(lastMessagePath, "utf8").catch(() => "")
        : "";
      const text = lastMessage.trim() || [...events].reverse().map(codexTextFromEvent).find(Boolean) || "";
      const normalized = {
        type: "result",
        subtype: "codex-cli",
        model: codexModelFromEvents(events, opts.model),
        total_cost_usd: codexCostFromEvents(events),
        usage: codexUsageFromEvents(events),
        is_error: timedOut || (code ?? 1) !== 0,
        result: timedOut ? "" : text,
        error: timedOut ? `timeout after ${opts.timeoutMs}ms` : "",
      };
      const transcriptEvents = [...events, normalized];
      await writeFile(transcriptPath, transcriptEvents.map(JSON.stringify).join("\n") + "\n").catch(() => {});
      resolveRun({
        exitCode: timedOut ? 124 : code ?? 1,
        events: transcriptEvents,
        stderr: timedOut ? `${stderr}\ntimeout after ${opts.timeoutMs}ms`.trim() : stderr,
        output: normalized.result || "",
        timedOut,
      });
    });
    proc.on("error", async (err) => {
      clearTimeout(timeout);
      const event = {
        type: "result",
        subtype: "codex-cli",
        is_error: true,
        total_cost_usd: 0,
        usage: {},
        result: "",
        error: err.message,
      };
      await writeFile(transcriptPath, JSON.stringify(event) + "\n").catch(() => {});
      resolveRun({
        exitCode: 127,
        events: [event],
        stderr: err.message,
        output: "",
        timedOut: false,
      });
    });
  });
}

function kiroBinName() {
  return process.env.AHK_KIRO_BIN || "kiro-cli";
}

// Kiro transport: `kiro-cli chat --no-interactive` runs one headless turn. Kiro
// has no stream-json output, so stdout is captured as the lane result text. Tool
// policy maps to trust flags (read-only lanes trust only inspection tools); a
// non-"explore" role selects a matching .kiro/agents/<role>.json crew agent.
async function runKiroAgent(agent, transcriptPath, opts) {
  return await new Promise((resolveRun) => {
    let timedOut = false;
    const agentName = agent.role && agent.role !== "explore" ? agent.role : null;
    const trustArgs = agent.toolPolicy === "mutating"
      ? ["--trust-all-tools"]
      : ["--trust-tools=read,grep,glob,code"];
    const proc = spawn(
      kiroBinName(),
      [
        "chat",
        "--no-interactive",
        ...trustArgs,
        ...(agentName ? ["--agent", agentName] : []),
        ...(opts.model ? ["--model", opts.model] : []),
        agent.prompt,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 2_000).unref();
    }, opts.timeoutMs);
    timeout.unref();

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("exit", async (code) => {
      clearTimeout(timeout);
      const text = timedOut ? "" : stdout.trim();
      const normalized = {
        type: "result",
        subtype: "kiro-cli",
        model: opts.model || "",
        total_cost_usd: 0,
        usage: {},
        is_error: timedOut || (code ?? 1) !== 0,
        result: text,
        error: timedOut ? `timeout after ${opts.timeoutMs}ms` : "",
      };
      await writeFile(transcriptPath, JSON.stringify(normalized) + "\n").catch(() => {});
      resolveRun({
        exitCode: timedOut ? 124 : code ?? 1,
        events: [normalized],
        stderr: timedOut ? `${stderr}\ntimeout after ${opts.timeoutMs}ms`.trim() : stderr,
        output: normalized.result,
        timedOut,
      });
    });
    proc.on("error", async (err) => {
      clearTimeout(timeout);
      const event = { type: "result", subtype: "kiro-cli", is_error: true, total_cost_usd: 0, usage: {}, result: "", error: err.message };
      await writeFile(transcriptPath, JSON.stringify(event) + "\n").catch(() => {});
      resolveRun({ exitCode: 127, events: [event], stderr: err.message, output: "", timedOut: false });
    });
  });
}

function summarizeRun(run) {
  const result = [...run.events].reverse().find((event) => event.type === "result") || {};
  const usage = result.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheCreationInputTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadInputTokens = usage.cache_read_input_tokens || 0;
  return {
    model: result.model || run.model || "",
    costUSD: result.total_cost_usd || 0,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
    isError: Boolean(result.is_error) || run.exitCode !== 0,
    error: run.timedOut ? `timeout after ${run.timeoutMs || 0}ms` : result.error || "",
  };
}

async function runAttempt(agent, opts, transcriptDir, attempt) {
  const transcriptPath = join(transcriptDir, attempt === 1 ? `${agent.id}.jsonl` : `${agent.id}.attempt-${attempt}.jsonl`);
  const startedAt = Date.now();
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const work = opts.transport === "mock"
    ? runMockAgent(agent, transcriptPath, opts, attempt, controller?.signal)
    : ["codex", "codex-cli"].includes(opts.transport)
      ? runCodexAgent(agent, transcriptPath, opts)
      : ["kiro", "kiro-cli"].includes(opts.transport)
        ? runKiroAgent(agent, transcriptPath, opts)
        : runClaudeAgent(agent, transcriptPath, opts);
  const run = await withTimeout(work, opts.timeoutMs, transcriptPath, controller);
  run.timeoutMs = opts.timeoutMs;
  const metrics = summarizeRun(run);
  return {
    attempt,
    agentId: agent.id,
    laneId: agent.laneId || agent.id,
    step: agent.step,
    role: agent.role || "explore",
    toolPolicy: agent.toolPolicy || "read-only",
    requiredReviewer: agent.requiredReviewer || null,
    requiresEvidence: agent.requiresEvidence === true,
    outputPath: agent.outputPath || null,
    status: metrics.isError ? "failed" : "passed",
    transcriptPath,
    durationMs: Date.now() - startedAt,
    stderr: run.stderr,
    output: run.output,
    ...metrics,
  };
}

async function withTimeout(promise, timeoutMs, transcriptPath, controller = null) {
  let timeout;
  const timeoutPromise = new Promise((resolveTimeout) => {
    timeout = setTimeout(async () => {
      controller?.abort?.();
      const event = {
        type: "result",
        subtype: "timeout",
        is_error: true,
        total_cost_usd: 0,
        usage: {},
        result: `timeout after ${timeoutMs}ms`,
      };
      await appendFile(transcriptPath, JSON.stringify(event) + "\n").catch(() => {});
      resolveTimeout({
        exitCode: 124,
        events: [event],
        stderr: `timeout after ${timeoutMs}ms`,
        output: "",
        timedOut: true,
      });
    }, timeoutMs);
    timeout.unref();
  });
  const result = await Promise.race([promise, timeoutPromise]);
  clearTimeout(timeout);
  return result;
}

async function runAgent(agent, opts, transcriptDir) {
  const attempts = [];
  for (let attempt = 1; attempt <= opts.retries + 1; attempt += 1) {
    const result = await runAttempt(agent, opts, transcriptDir, attempt);
    attempts.push({
      attempt,
      status: result.status,
      transcriptPath: result.transcriptPath,
      durationMs: result.durationMs,
      error: result.error || result.stderr || "",
    });
    if (result.status === "passed" || attempt > opts.retries) {
      return {
        ...result,
        attempts,
        retries: attempt - 1,
      };
    }
  }
  throw new Error(`unreachable retry loop for ${agent.id}`);
}

async function runWithLimit(items, limit, worker, failFast) {
  const results = [];
  let cursor = 0;
  let failed = false;

  async function next() {
    if (failed && failFast) return;
    const current = cursor;
    cursor += 1;
    if (current >= items.length) return;
    const result = await worker(items[current]);
    results[current] = result;
    if (result.status === "failed") failed = true;
    await next();
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => next());
  await Promise.all(workers);
  return results.filter(Boolean);
}

function resolveRunDir(value) {
  if (!value) return null;
  if (isAbsolute(value) || value.startsWith(".") || value.includes("/")) {
    return resolve(process.cwd(), value);
  }
  return resolve(process.cwd(), ".harness/orchestration", value);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function cancelRun(value) {
  const outDir = resolveRunDir(value);
  await mkdir(outDir, { recursive: true });
  const cancelledAt = new Date().toISOString();
  await writeFile(join(outDir, "CANCELLED"), JSON.stringify({ cancelledAt }, null, 2) + "\n");
  return { status: "cancelled", outDir, cancelledAt };
}

async function isCancelled(outDir) {
  return await pathExists(join(outDir, "CANCELLED"));
}

async function loadPreviousSummary(outDir) {
  const path = join(outDir, "summary.json");
  if (!(await pathExists(path))) return null;
  return await readJson(path);
}

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") errors.push("manifest must be an object");
  if (manifest?.schemaVersion !== 1) errors.push("manifest.schemaVersion must be 1");
  if (!manifest?.runId) errors.push("manifest.runId is required");
  if (!manifest?.task) errors.push("manifest.task is required");
  if (!PATTERNS[manifest?.pattern]) errors.push(`manifest.pattern is invalid: ${manifest?.pattern}`);
  if (manifest?.contractId && !manifest?.contractPath) errors.push("manifest.contractPath is required when contractId is set");
  if (manifest?.contractPath && !manifest?.contractId) errors.push("manifest.contractId is required when contractPath is set");
  if (!Array.isArray(manifest?.agents) || manifest.agents.length === 0) errors.push("manifest.agents must be a non-empty array");
  for (const [index, agent] of (manifest?.agents || []).entries()) {
    if (!agent.id) errors.push(`manifest.agents[${index}].id is required`);
    if (!agent.laneId) errors.push(`manifest.agents[${index}].laneId is required`);
    if (!agent.step) errors.push(`manifest.agents[${index}].step is required`);
    if (!agent.prompt) errors.push(`manifest.agents[${index}].prompt is required`);
    if (!agent.toolPolicy) errors.push(`manifest.agents[${index}].toolPolicy is required`);
    if (agent.toolPolicy === "mutating" && !manifest.taskId) {
      errors.push(`manifest.agents[${index}] mutating lane requires manifest.taskId`);
    }
  }
  return errors;
}

function validateSummary(summary, manifest) {
  const errors = [];
  if (!summary || typeof summary !== "object") errors.push("summary must be an object");
  if (summary?.schemaVersion !== 1) errors.push("summary.schemaVersion must be 1");
  if (manifest && summary?.runId !== manifest.runId) errors.push("summary.runId must match manifest.runId");
  if (manifest?.contractId && summary?.contractId !== manifest.contractId) errors.push("summary.contractId must match manifest.contractId");
  if (manifest?.taskId && summary?.taskId !== manifest.taskId) errors.push("summary.taskId must match manifest.taskId");
  if (!["passed", "failed", "cancelled"].includes(summary?.status)) errors.push("summary.status must be passed, failed, or cancelled");
  if (!Array.isArray(summary?.results)) errors.push("summary.results must be an array");
  for (const [index, result] of (summary?.results || []).entries()) {
    if (!result.agentId) errors.push(`summary.results[${index}].agentId is required`);
    if (!["passed", "failed", "skipped"].includes(result.status)) errors.push(`summary.results[${index}].status is invalid`);
    if (!result.transcriptPath) errors.push(`summary.results[${index}].transcriptPath is required`);
    if (result.runtimeProof !== undefined) {
      if (!result.runtimeProof || typeof result.runtimeProof !== "object" || Array.isArray(result.runtimeProof)) {
        errors.push(`summary.results[${index}].runtimeProof must be an object`);
      } else {
        if (result.runtimeProof.type !== "orchestration-run") {
          errors.push(`summary.results[${index}].runtimeProof.type must be orchestration-run`);
        }
        if (result.runtimeProof.eventId !== `${summary.runId}:${result.agentId}`) {
          errors.push(`summary.results[${index}].runtimeProof.eventId must be ${summary.runId}:${result.agentId}`);
        }
        if (!/^sha256:[a-f0-9]{64}$/.test(String(result.runtimeProof.inputHash || ""))) {
          errors.push(`summary.results[${index}].runtimeProof.inputHash must be sha256:<64 lowercase hex chars>`);
        }
        if (typeof result.runtimeProof.path !== "string" || result.runtimeProof.path.trim().length === 0 || isAbsolute(result.runtimeProof.path) || result.runtimeProof.path.split("/").includes("..")) {
          errors.push(`summary.results[${index}].runtimeProof.path must be a repo-local summary path`);
        }
      }
    }
  }
  return errors;
}

async function validateTranscript(path) {
  const errors = [];
  const warnings = [];
  if (!(await pathExists(path))) return { errors: [`transcript missing: ${path}`], warnings };
  const text = await readFile(path, "utf8");
  const lines = text.split("\n").filter(Boolean);
  if (lines.length === 0) errors.push(`transcript empty: ${path}`);
  for (const [index, line] of lines.entries()) {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object") errors.push(`${path}:${index + 1} event must be an object`);
      if (!event.type) errors.push(`${path}:${index + 1} event.type is required`);
    } catch {
      errors.push(`${path}:${index + 1} invalid JSON event`);
    }
  }
  return { errors, warnings };
}

async function validateRunDir(value) {
  const outDir = resolveRunDir(value);
  const errors = [];
  const warnings = [];
  const manifestPath = join(outDir, "manifest.json");
  const summaryPath = join(outDir, "summary.json");

  if (!(await pathExists(manifestPath))) errors.push(`missing manifest.json in ${outDir}`);
  if (!(await pathExists(summaryPath))) errors.push(`missing summary.json in ${outDir}`);
  if (errors.length > 0) return { status: "failed", outDir, errors, warnings };

  const manifest = await readJson(manifestPath);
  const summary = await readJson(summaryPath);
  errors.push(...validateManifest(manifest));
  errors.push(...validateSummary(summary, manifest));
  for (const result of summary.results || []) {
    const transcript = await validateTranscript(result.transcriptPath);
    errors.push(...transcript.errors);
    warnings.push(...transcript.warnings);
    if (result.runtimeProof?.inputHash) {
      const actualHash = await hashFileIfExists(result.transcriptPath);
      if (actualHash && actualHash !== result.runtimeProof.inputHash) {
        errors.push(`${result.transcriptPath}: hash does not match summary runtimeProof.inputHash`);
      }
    }
  }
  return {
    status: errors.length === 0 ? "passed" : "failed",
    outDir,
    errors,
    warnings,
    manifestAgents: manifest.agents?.length || 0,
    summaryResults: summary.results?.length || 0,
  };
}

function renderSummaryMarkdown(summary) {
  return `# Orchestration Run: ${summary.pattern}

Task: ${summary.task}
Contract: ${summary.contractId || "none"}
Task contract: ${summary.taskId || "none"}

Status: ${summary.status}
Agents: ${summary.passed}/${summary.total} passed
Cost: $${summary.totalCostUSD.toFixed(4)}
Tokens: ${summary.totalTokens}
Cache read/write: ${summary.cacheReadInputTokens}/${summary.cacheCreationInputTokens}
Retries: ${summary.totalRetries}
Skipped on resume: ${summary.skipped}

| Agent | Step | Status | Cost | Tokens | Transcript |
| --- | --- | --- | ---: | ---: | --- |
${summary.results.map((r) => `| ${r.agentId} | ${r.step.replaceAll("|", "\\|")} | ${r.status} | $${r.costUSD.toFixed(4)} | ${r.totalTokens} | ${r.transcriptPath} |`).join("\n")}
`;
}

async function appendTelemetry(manifest, summary) {
  const telemetryPath = resolve(process.cwd(), ".harness/telemetry.jsonl");
  await mkdir(resolve(process.cwd(), ".harness"), { recursive: true });
  const rows = [];
  const now = new Date().toISOString();
  rows.push({
    schemaVersion: 1,
    ts: manifest.createdAt || now,
    event: "skill_invoked",
    session_id: manifest.runId,
    skill: "orchestrate",
    args: `--pattern=${manifest.pattern} --run`,
    task_id: manifest.taskId || manifest.runId,
    task_contract_id: manifest.taskId || "",
    orchestration_contract_id: manifest.contractId || "",
    orchestration_run_id: manifest.runId,
  });
  for (const result of summary.results) {
    if (result.status === "skipped") continue;
    const end = new Date().toISOString();
    const start = new Date(Date.now() - (result.durationMs || 0)).toISOString();
    rows.push({
      schemaVersion: 1,
      ts: start,
      event: "eval_run",
      session_id: manifest.runId,
      taskId: result.agentId,
      task_id: result.agentId,
      task_contract_id: manifest.taskId || "",
      orchestration_contract_id: manifest.contractId || "",
      orchestration_run_id: manifest.runId,
      orchestration_lane_id: result.laneId || result.agentId,
      orchestration_step: result.step,
      passed: result.status === "passed",
    });
    rows.push({
      schemaVersion: 1,
      ts: end,
      event: "provider_call",
      session_id: manifest.runId,
      provider: manifest.transport === "mock" ? "mock" : ["codex", "codex-cli"].includes(manifest.transport) ? "codex" : ["kiro", "kiro-cli"].includes(manifest.transport) ? "kiro" : "claude",
      model: result.model || (manifest.transport === "mock" ? "mock" : ""),
      skill: "orchestrate",
      task_id: result.agentId,
      task_contract_id: manifest.taskId || "",
      orchestration_contract_id: manifest.contractId || "",
      orchestration_run_id: manifest.runId,
      orchestration_lane_id: result.laneId || result.agentId,
      orchestration_step: result.step,
      input_tokens: result.inputTokens || 0,
      output_tokens: result.outputTokens || 0,
      cache_creation_input_tokens: result.cacheCreationInputTokens || 0,
      cache_read_input_tokens: result.cacheReadInputTokens || 0,
      cost_usd: result.costUSD || 0,
      start_ts: start,
      end_ts: end,
      error: result.status === "failed" ? result.error || result.stderr || "failed" : "",
    });
  }
  rows.push({
    schemaVersion: 1,
    ts: now,
    event: "orchestration_summary",
    session_id: manifest.runId,
    skill: "orchestrate",
    task_id: manifest.runId,
    task_contract_id: manifest.taskId || "",
    orchestration_contract_id: manifest.contractId || "",
    orchestration_run_id: manifest.runId,
    status: summary.status,
    total: summary.total,
    completed: summary.completed,
    passed: summary.passed,
    failed: summary.failed,
    total_cost_usd: summary.totalCostUSD,
    total_tokens: summary.totalTokens,
  });
  await appendFile(telemetryPath, rows.map(JSON.stringify).join("\n") + "\n");
  return telemetryPath;
}

async function runOrchestration(task, opts) {
  let pattern = PATTERNS[opts.pattern] ? opts.pattern : "fanout";
  let runId = `${timestamp()}-${pattern}`;
  let outDir = resolve(process.cwd(), opts.outDir || `.harness/orchestration/${runId}`);
  let manifest;
  let previousSummary = null;
  let contract = null;

  if (opts.resume) {
    outDir = resolveRunDir(opts.resume);
    manifest = await readJson(join(outDir, "manifest.json"));
    const manifestErrors = validateManifest(manifest);
    if (manifestErrors.length > 0) {
      throw new Error(`Cannot resume invalid manifest:\n${manifestErrors.join("\n")}`);
    }
    previousSummary = await loadPreviousSummary(outDir);
    pattern = manifest.pattern;
    runId = manifest.runId;
    task = task || manifest.task;
    opts = {
      ...opts,
      pattern,
      transport: opts.specified.has("transport") ? opts.transport : manifest.transport,
      maxConcurrency: opts.specified.has("maxConcurrency") ? opts.maxConcurrency : manifest.maxConcurrency,
      maxTurns: opts.specified.has("maxTurns") ? opts.maxTurns : manifest.maxTurns,
      timeoutMs: opts.specified.has("timeoutMs") ? opts.timeoutMs : manifest.timeoutMs,
      retries: opts.specified.has("retries") ? opts.retries : manifest.retries ?? 0,
      failFast: manifest.failFast,
      permissionMode: opts.specified.has("permissionMode") ? opts.permissionMode : manifest.permissionMode,
      sandbox: opts.specified.has("sandbox") ? opts.sandbox : manifest.sandbox || opts.sandbox,
      model: opts.specified.has("model") ? opts.model : manifest.model || opts.model,
    };
  } else if (opts.contract) {
    contract = await loadContract(opts.contract);
    if (contract.pattern && !opts.specified.has("pattern")) {
      pattern = PATTERNS[contract.pattern] ? contract.pattern : pattern;
      opts = { ...opts, pattern };
    }
    if (Number.isInteger(contract.maxConcurrency) && !opts.specified.has("maxConcurrency")) {
      opts = { ...opts, maxConcurrency: contract.maxConcurrency };
    }
    task = task || contract.task || contract.taskId || contract.id;
    if (!opts.outDir) {
      runId = `${timestamp()}-${pattern}`;
      outDir = resolve(process.cwd(), `.harness/orchestration/${runId}`);
    }
  }

  const transcriptDir = join(outDir, "transcripts");
  await mkdir(transcriptDir, { recursive: true });

  if (!manifest) {
    manifest = createManifest(task, pattern, opts, runId, outDir, contract);
    await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }

  const previousByAgent = new Map();
  for (const result of previousSummary?.results || []) {
    if (result.status === "passed") previousByAgent.set(result.agentId, { ...result, status: "skipped", skippedReason: "passed in previous run" });
  }
  const pendingAgents = manifest.agents.filter((agent) => !previousByAgent.has(agent.id));
  const cancelledBeforeRun = await isCancelled(outDir);

  const freshResults = cancelledBeforeRun
    ? []
    : await runWithLimit(
      pendingAgents,
      opts.maxConcurrency,
      async (agent) => {
        if (await isCancelled(outDir)) {
          return {
            agentId: agent.id,
            laneId: agent.laneId || agent.id,
            step: agent.step,
            role: agent.role || "explore",
            toolPolicy: agent.toolPolicy || "read-only",
            requiredReviewer: agent.requiredReviewer || null,
            requiresEvidence: agent.requiresEvidence === true,
            outputPath: agent.outputPath || null,
            status: "failed",
            transcriptPath: join(transcriptDir, `${agent.id}.jsonl`),
            durationMs: 0,
            stderr: "run cancelled",
            output: "",
            model: "",
            costUSD: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            totalTokens: 0,
            isError: true,
            error: "run cancelled",
            attempts: [],
            retries: 0,
          };
        }
        return runAgent(agent, opts, transcriptDir);
      },
      opts.failFast,
    );

  const freshByAgent = new Map(freshResults.map((result) => [result.agentId, result]));
  let results = manifest.agents
    .map((agent) => freshByAgent.get(agent.id) || previousByAgent.get(agent.id))
    .filter(Boolean);
  const summaryPath = join(outDir, "summary.json");
  const summaryRelPath = repoRelative(summaryPath);
  results = await Promise.all(results.map(async (result) => {
    if (result.runtimeProof) return result;
    const inputHash = result.transcriptPath ? await hashFileIfExists(result.transcriptPath) : "";
    if (!inputHash) return result;
    return {
      ...result,
      runtimeProof: {
        type: "orchestration-run",
        eventId: `${runId}:${result.agentId}`,
        inputHash,
        path: summaryRelPath,
      },
    };
  }));

  const passed = results.filter((result) => result.status === "passed" || result.status === "skipped").length;
  const cancelled = cancelledBeforeRun || await isCancelled(outDir);
  const summary = {
    schemaVersion: 1,
    runId,
    task,
    pattern,
    contractId: manifest.contractId || null,
    contractPath: manifest.contractPath || null,
    taskId: manifest.taskId || null,
    featureId: manifest.featureId || null,
    requiredReviewers: manifest.requiredReviewers || [],
    requiredArtifacts: manifest.requiredArtifacts || [],
    status: cancelled ? "cancelled" : passed === manifest.agents.length ? "passed" : "failed",
    total: manifest.agents.length,
    completed: results.length,
    passed: results.filter((result) => result.status === "passed" || result.status === "skipped").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    pending: manifest.agents.length - results.length,
    totalCostUSD: results.reduce((sum, result) => sum + result.costUSD, 0),
    totalTokens: results.reduce((sum, result) => sum + result.totalTokens, 0),
    cacheCreationInputTokens: results.reduce((sum, result) => sum + result.cacheCreationInputTokens, 0),
    cacheReadInputTokens: results.reduce((sum, result) => sum + result.cacheReadInputTokens, 0),
    totalRetries: results.reduce((sum, result) => sum + (result.retries || 0), 0),
    maxConcurrency: opts.maxConcurrency,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    failFast: opts.failFast,
    resumed: Boolean(opts.resume),
    outDir,
    results,
  };

  await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  await writeFile(join(outDir, "summary.md"), renderSummaryMarkdown(summary));
  if (opts.telemetry) {
    summary.telemetryPath = await appendTelemetry(manifest, summary);
    await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  }
  const validation = await validateRunDir(outDir);
  summary.validation = validation;
  await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

const { task, opts } = parseArgs(process.argv.slice(2));
if (opts.cancel) {
  const payload = await cancelRun(opts.cancel);
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}
if (opts.validateRun) {
  const validation = await validateRunDir(opts.validateRun);
  console.log(JSON.stringify(validation, null, 2));
  process.exit(validation.status === "passed" ? 0 : 1);
}
if (!task && !opts.resume && !opts.contract) {
  usage();
  process.exit(1);
}

let pattern = PATTERNS[opts.pattern] ? opts.pattern : "fanout";
if (!opts.run) {
  const contract = opts.contract ? await loadContract(opts.contract) : null;
  if (contract?.pattern && !opts.specified.has("pattern")) {
    pattern = PATTERNS[contract.pattern] ? contract.pattern : pattern;
  }
  const packet = await writePacket(task || contract?.task || contract?.taskId || contract?.id, pattern, contract);
  console.log(JSON.stringify(packet, null, 2));
} else {
  const summary = await runOrchestration(task, { ...opts, pattern });
  console.log(JSON.stringify({
    runId: summary.runId,
    status: summary.status,
    pattern: summary.pattern,
    contractId: summary.contractId,
    taskId: summary.taskId,
    featureId: summary.featureId,
    completed: summary.completed,
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    pending: summary.pending,
    totalCostUSD: summary.totalCostUSD,
    totalTokens: summary.totalTokens,
    validation: summary.validation.status,
    outDir: summary.outDir,
  }, null, 2));
  if (summary.status !== "passed") process.exit(1);
}
