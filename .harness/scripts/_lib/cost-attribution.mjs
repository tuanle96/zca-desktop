export const PRICING = Object.freeze({
  "claude-opus-4-7": { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
  "gpt-4-turbo": { input: 10.0, output: 30.0, cacheWrite: 10.0, cacheRead: 1.0 },
  "gpt-4": { input: 30.0, output: 60.0, cacheWrite: 30.0, cacheRead: 3.0 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5, cacheWrite: 0.5, cacheRead: 0.05 },
});

const UNKNOWN = "unattributed";

export function asNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function callTaskId(call) {
  return call.task_id || call.taskId || call.eval_task_id || call.regression_task_id || UNKNOWN;
}

export function tokenBuckets(call) {
  return {
    input: asNumber(call.input_tokens ?? call.inputTokens),
    output: asNumber(call.output_tokens ?? call.outputTokens),
    cacheWrite: asNumber(call.cache_creation_input_tokens ?? call.cacheCreationInputTokens),
    cacheRead: asNumber(call.cache_read_input_tokens ?? call.cacheReadInputTokens),
  };
}

export function totalTokens(call) {
  const buckets = tokenBuckets(call);
  return buckets.input + buckets.output + buckets.cacheWrite + buckets.cacheRead;
}

export function calculateCost(call) {
  const explicit = asNumber(call.cost_usd ?? call.costUSD);
  if (explicit > 0) return explicit;

  const pricing = PRICING[call.model || ""];
  if (!pricing) return 0;

  const buckets = tokenBuckets(call);
  return (
    (buckets.input / 1_000_000) * pricing.input +
    (buckets.output / 1_000_000) * pricing.output +
    (buckets.cacheWrite / 1_000_000) * pricing.cacheWrite +
    (buckets.cacheRead / 1_000_000) * pricing.cacheRead
  );
}

export function costBuckets(call) {
  const explicit = {
    input: asNumber(call.input_cost_usd ?? call.inputCostUSD),
    output: asNumber(call.output_cost_usd ?? call.outputCostUSD),
    cacheWrite: asNumber(call.cache_creation_cost_usd ?? call.cacheCreationCostUSD),
    cacheRead: asNumber(call.cache_read_cost_usd ?? call.cacheReadCostUSD),
  };
  const explicitTotal = explicit.input + explicit.output + explicit.cacheWrite + explicit.cacheRead;
  if (explicitTotal > 0) return explicit;

  const pricing = PRICING[call.model || ""];
  if (!pricing) {
    return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  }
  const buckets = tokenBuckets(call);
  return {
    input: (buckets.input / 1_000_000) * pricing.input,
    output: (buckets.output / 1_000_000) * pricing.output,
    cacheWrite: (buckets.cacheWrite / 1_000_000) * pricing.cacheWrite,
    cacheRead: (buckets.cacheRead / 1_000_000) * pricing.cacheRead,
  };
}

export function annotateProviderCalls(records) {
  const contextBySession = new Map();
  const calls = [];

  for (const record of records) {
    const sessionId = record.session_id || record.sessionId || UNKNOWN;
    if (!contextBySession.has(sessionId)) {
      contextBySession.set(sessionId, { skill: UNKNOWN, taskId: UNKNOWN });
    }
    const context = contextBySession.get(sessionId);

    if (record.event === "skill_invoked" && record.skill) {
      context.skill = record.skill;
    }
    if (record.event === "eval_run" && (record.taskId || record.task_id)) {
      context.taskId = record.taskId || record.task_id;
    }
    if (record.task_id || record.taskId || record.eval_task_id || record.regression_task_id) {
      context.taskId = callTaskId(record);
    }

    if (record.event !== "provider_call") continue;

    const skill = record.skill || record.skill_name || context.skill || UNKNOWN;
    const taskId = callTaskId(record) !== UNKNOWN ? callTaskId(record) : context.taskId || UNKNOWN;
    const buckets = tokenBuckets(record);
    const bucketCosts = costBuckets(record);

    calls.push({
      ...record,
      session_id: sessionId,
      skill,
      task_id: taskId,
      token_buckets: buckets,
      cost_buckets_usd: bucketCosts,
      attributed_cost_usd: calculateCost(record),
      attributed_tokens: buckets.input + buckets.output + buckets.cacheWrite + buckets.cacheRead,
    });
  }

  return calls;
}

export function groupBy(calls, keyFn) {
  const groups = new Map();
  for (const call of calls) {
    const key = keyFn(call) || UNKNOWN;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(call);
  }
  return groups;
}

export function calculateStats(calls) {
  const stats = {
    count: calls.length,
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheCreationCost: 0,
    cacheReadCost: 0,
    errorCount: 0,
  };

  for (const call of calls) {
    const buckets = tokenBuckets(call);
    const costs = costBuckets(call);
    stats.totalCost += calculateCost(call);
    stats.totalInputTokens += buckets.input;
    stats.totalOutputTokens += buckets.output;
    stats.cacheCreationInputTokens += buckets.cacheWrite;
    stats.cacheReadInputTokens += buckets.cacheRead;
    stats.inputCost += costs.input;
    stats.outputCost += costs.output;
    stats.cacheCreationCost += costs.cacheWrite;
    stats.cacheReadCost += costs.cacheRead;
    if (call.error) stats.errorCount += 1;
  }

  stats.totalTokens =
    stats.totalInputTokens +
    stats.totalOutputTokens +
    stats.cacheCreationInputTokens +
    stats.cacheReadInputTokens;
  stats.avgCost = calls.length > 0 ? stats.totalCost / calls.length : 0;
  return stats;
}

export function skillCostRows(calls) {
  return Array.from(groupBy(calls, (call) => call.skill).entries())
    .map(([skill, rows]) => ({ key: skill, stats: calculateStats(rows) }))
    .sort((a, b) => b.stats.totalCost - a.stats.totalCost || a.key.localeCompare(b.key));
}

export function taskCostRows(calls) {
  return Array.from(groupBy(calls, (call) => call.task_id).entries())
    .map(([taskId, rows]) => ({ key: taskId, stats: calculateStats(rows) }))
    .sort((a, b) => b.stats.totalCost - a.stats.totalCost || a.key.localeCompare(b.key));
}
