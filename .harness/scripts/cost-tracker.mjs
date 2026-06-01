#!/usr/bin/env node
/**
 * cost-tracker.mjs — Track and analyze AI provider costs
 *
 * Calculates costs from telemetry data, tracks budget burn rate,
 * and provides alerts when approaching limits.
 *
 * Usage:
 *   node scripts/cost-tracker.mjs                    # Show current costs
 *   node scripts/cost-tracker.mjs --daily            # Daily breakdown
 *   node scripts/cost-tracker.mjs --by-provider      # Group by provider
 *   node scripts/cost-tracker.mjs --by-session       # Group by session
 *   node scripts/cost-tracker.mjs --by-skill         # Group by active skill
 *   node scripts/cost-tracker.mjs --by-task          # Group by task/eval id
 *   node scripts/cost-tracker.mjs --cache-buckets    # Show cache read/write buckets
 *   node scripts/cost-tracker.mjs --json             # Machine-readable attribution
 *   node scripts/cost-tracker.mjs --budget-check     # Check against budgets
 */

import { readFile, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  annotateProviderCalls,
  calculateCost,
  calculateStats,
  groupBy,
  skillCostRows,
  taskCostRows,
} from './_lib/cost-attribution.mjs';

const readFileAsync = promisify(readFile);

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TELEMETRY_PATH = resolve(ROOT, '.harness/telemetry.jsonl');
const CONFIG_PATH = resolve(ROOT, 'harness.config.json');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function colorize(text, color) {
  return `${colors[color] || ''}${text}${colors.reset}`;
}

// Read telemetry
async function readTelemetry() {
  if (!existsSync(TELEMETRY_PATH)) {
    return [];
  }

  const content = await readFileAsync(TELEMETRY_PATH, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  const records = [];

  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch (e) {
      // Skip malformed
    }
  }

  return records;
}

// Read config
async function readConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }

  try {
    const content = await readFileAsync(CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

// Get provider calls
function getProviderCalls(records) {
  return annotateProviderCalls(records);
}

// Group by time period
function groupByDay(calls) {
  const byDay = new Map();

  for (const call of calls) {
    const day = call.ts.slice(0, 10); // YYYY-MM-DD
    if (!byDay.has(day)) {
      byDay.set(day, []);
    }
    byDay.get(day).push(call);
  }

  return byDay;
}

// Group by provider
function groupByProvider(calls) {
  return groupBy(calls, call => call.provider || 'unknown');
}

// Group by session
function groupBySession(calls) {
  return groupBy(calls, call => call.session_id || 'unknown');
}

// Show overview
function showOverview(calls) {
  const stats = calculateStats(calls);

  console.log(colorize('\n╔════════════════════════════════════════════════════════════════╗', 'bright'));
  console.log(colorize('║                     COST TRACKER                               ║', 'bright'));
  console.log(colorize('╚════════════════════════════════════════════════════════════════╝\n', 'bright'));

  console.log(colorize('=== Overall Stats ===\n', 'bright'));
  console.log(`  Total calls:        ${colorize(String(stats.count), 'cyan')}`);
  console.log(`  Total cost:         ${colorize(`$${stats.totalCost.toFixed(4)}`, 'yellow')}`);
  console.log(`  Avg cost/call:      ${colorize(`$${stats.avgCost.toFixed(4)}`, 'yellow')}`);
  console.log(`  Total tokens:       ${colorize(String(stats.totalTokens.toLocaleString()), 'cyan')}`);
  console.log(`  Input tokens:       ${colorize(String(stats.totalInputTokens.toLocaleString()), 'dim')}`);
  console.log(`  Output tokens:      ${colorize(String(stats.totalOutputTokens.toLocaleString()), 'dim')}`);
  console.log(`  Cache write tokens: ${colorize(String(stats.cacheCreationInputTokens.toLocaleString()), 'dim')}`);
  console.log(`  Cache read tokens:  ${colorize(String(stats.cacheReadInputTokens.toLocaleString()), 'dim')}`);
  console.log(`  Errors:             ${colorize(String(stats.errorCount), stats.errorCount > 0 ? 'red' : 'green')}`);
  console.log('');
}

// Show daily breakdown
function showDaily(calls) {
  const byDay = groupByDay(calls);
  const sorted = Array.from(byDay.entries()).sort((a, b) => b[0].localeCompare(a[0]));

  console.log(colorize('=== Daily Breakdown (last 30 days) ===\n', 'bright'));
  console.log(colorize('  Date          Calls    Cost       Tokens', 'dim'));
  console.log(colorize('  ----------    -----    --------   ----------', 'dim'));

  for (const [day, dayCalls] of sorted.slice(0, 30)) {
    const stats = calculateStats(dayCalls);
    const calls = String(stats.count).padStart(5);
    const cost = `$${stats.totalCost.toFixed(4)}`.padStart(8);
    const tokens = String(stats.totalTokens.toLocaleString()).padStart(10);
    console.log(`  ${day}    ${calls}    ${colorize(cost, 'yellow')}   ${tokens}`);
  }
  console.log('');
}

// Show by provider
function showByProvider(calls) {
  const byProvider = groupByProvider(calls);

  console.log(colorize('=== By Provider ===\n', 'bright'));
  console.log(colorize('  Provider      Calls    Cost       Tokens       Avg Cost', 'dim'));
  console.log(colorize('  -----------   -----    --------   ----------   --------', 'dim'));

  for (const [provider, providerCalls] of byProvider.entries()) {
    const stats = calculateStats(providerCalls);
    const calls = String(stats.count).padStart(5);
    const cost = `$${stats.totalCost.toFixed(4)}`.padStart(8);
    const tokens = String(stats.totalTokens.toLocaleString()).padStart(10);
    const avg = `$${stats.avgCost.toFixed(4)}`.padStart(8);
    console.log(`  ${provider.padEnd(11)}   ${calls}    ${colorize(cost, 'yellow')}   ${tokens}   ${avg}`);
  }
  console.log('');
}

// Show by session
function showBySession(calls) {
  const bySession = groupBySession(calls);
  const sorted = Array.from(bySession.entries())
    .map(([id, calls]) => ({ id, stats: calculateStats(calls) }))
    .sort((a, b) => b.stats.totalCost - a.stats.totalCost);

  console.log(colorize('=== By Session (top 20) ===\n', 'bright'));
  console.log(colorize('  Session ID                            Calls    Cost       Tokens', 'dim'));
  console.log(colorize('  ------------------------------------  -----    --------   ----------', 'dim'));

  for (const { id, stats } of sorted.slice(0, 20)) {
    const sessionId = id.slice(0, 36).padEnd(36);
    const calls = String(stats.count).padStart(5);
    const cost = `$${stats.totalCost.toFixed(4)}`.padStart(8);
    const tokens = String(stats.totalTokens.toLocaleString()).padStart(10);
    console.log(`  ${colorize(sessionId, 'cyan')}  ${calls}    ${colorize(cost, 'yellow')}   ${tokens}`);
  }
  console.log('');
}

function showBySkill(calls) {
  const rows = skillCostRows(calls);

  console.log(colorize('=== By Skill (top 20) ===\n', 'bright'));
  console.log(colorize('  Skill                         Calls    Cost       Tokens       Cache R/W', 'dim'));
  console.log(colorize('  ---------------------------   -----    --------   ----------   ----------', 'dim'));

  for (const { key, stats } of rows.slice(0, 20)) {
    const skill = key.slice(0, 27).padEnd(27);
    const count = String(stats.count).padStart(5);
    const cost = `$${stats.totalCost.toFixed(4)}`.padStart(8);
    const tokens = String(stats.totalTokens.toLocaleString()).padStart(10);
    const cache = `${stats.cacheReadInputTokens.toLocaleString()}/${stats.cacheCreationInputTokens.toLocaleString()}`.padStart(10);
    console.log(`  ${colorize(skill, 'cyan')}   ${count}    ${colorize(cost, 'yellow')}   ${tokens}   ${cache}`);
  }
  console.log('');
}

function showByTask(calls) {
  const rows = taskCostRows(calls);

  console.log(colorize('=== By Task (top 20) ===\n', 'bright'));
  console.log(colorize('  Task                          Calls    Cost       Tokens       Cache R/W', 'dim'));
  console.log(colorize('  ---------------------------   -----    --------   ----------   ----------', 'dim'));

  for (const { key, stats } of rows.slice(0, 20)) {
    const task = key.slice(0, 27).padEnd(27);
    const count = String(stats.count).padStart(5);
    const cost = `$${stats.totalCost.toFixed(4)}`.padStart(8);
    const tokens = String(stats.totalTokens.toLocaleString()).padStart(10);
    const cache = `${stats.cacheReadInputTokens.toLocaleString()}/${stats.cacheCreationInputTokens.toLocaleString()}`.padStart(10);
    console.log(`  ${colorize(task, 'cyan')}   ${count}    ${colorize(cost, 'yellow')}   ${tokens}   ${cache}`);
  }
  console.log('');
}

function showCacheBuckets(calls) {
  const stats = calculateStats(calls);

  console.log(colorize('=== Cache Token Buckets ===\n', 'bright'));
  console.log(colorize('  Bucket          Tokens       Est. Cost', 'dim'));
  console.log(colorize('  -------------   ----------   ---------', 'dim'));
  console.log(`  input           ${String(stats.totalInputTokens.toLocaleString()).padStart(10)}   ${colorize(`$${stats.inputCost.toFixed(4)}`, 'yellow')}`);
  console.log(`  output          ${String(stats.totalOutputTokens.toLocaleString()).padStart(10)}   ${colorize(`$${stats.outputCost.toFixed(4)}`, 'yellow')}`);
  console.log(`  cache-write     ${String(stats.cacheCreationInputTokens.toLocaleString()).padStart(10)}   ${colorize(`$${stats.cacheCreationCost.toFixed(4)}`, 'yellow')}`);
  console.log(`  cache-read      ${String(stats.cacheReadInputTokens.toLocaleString()).padStart(10)}   ${colorize(`$${stats.cacheReadCost.toFixed(4)}`, 'yellow')}`);
  console.log('');
}

function showJson(calls) {
  const stats = calculateStats(calls);
  const payload = {
    summary: stats,
    bySkill: skillCostRows(calls),
    byTask: taskCostRows(calls),
  };
  console.log(JSON.stringify(payload, null, 2));
}

// Check budget
async function checkBudget(calls, config) {
  if (!config || !config.budgets) {
    console.log(colorize('⚠️  No budget configuration found in harness.config.json', 'yellow'));
    return;
  }

  const { perRunUsd, perDayUsd } = config.budgets;

  console.log(colorize('=== Budget Check ===\n', 'bright'));

  // Today's costs
  const today = new Date().toISOString().slice(0, 10);
  const todayCalls = calls.filter(c => c.ts.startsWith(today));
  const todayStats = calculateStats(todayCalls);

  console.log(`  Daily budget:       ${colorize(`$${perDayUsd.toFixed(2)}`, 'cyan')}`);
  console.log(`  Today's cost:       ${colorize(`$${todayStats.totalCost.toFixed(4)}`, 'yellow')}`);

  const dailyPct = (todayStats.totalCost / perDayUsd) * 100;
  const dailyBar = renderProgressBar(dailyPct);
  const dailyColor = dailyPct > 90 ? 'red' : dailyPct > 70 ? 'yellow' : 'green';
  console.log(`  Daily usage:        ${colorize(dailyBar, dailyColor)} ${dailyPct.toFixed(1)}%`);

  if (dailyPct > 100) {
    console.log(colorize(`  ⚠️  OVER BUDGET by $${(todayStats.totalCost - perDayUsd).toFixed(4)}`, 'red'));
  } else if (dailyPct > 80) {
    console.log(colorize(`  ⚠️  Approaching limit ($${(perDayUsd - todayStats.totalCost).toFixed(4)} remaining)`, 'yellow'));
  } else {
    console.log(colorize(`  ✓ Within budget ($${(perDayUsd - todayStats.totalCost).toFixed(4)} remaining)`, 'green'));
  }

  console.log('');

  // Per-run budget (last session)
  const bySession = groupBySession(calls);
  const sessions = Array.from(bySession.entries())
    .map(([id, calls]) => ({
      id,
      stats: calculateStats(calls),
      lastTs: calls.reduce((max, c) => c.ts > max ? c.ts : max, ''),
    }))
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs));

  if (sessions.length > 0) {
    const lastSession = sessions[0];
    console.log(`  Per-run budget:     ${colorize(`$${perRunUsd.toFixed(2)}`, 'cyan')}`);
    console.log(`  Last session cost:  ${colorize(`$${lastSession.stats.totalCost.toFixed(4)}`, 'yellow')}`);

    const runPct = (lastSession.stats.totalCost / perRunUsd) * 100;
    const runBar = renderProgressBar(runPct);
    const runColor = runPct > 90 ? 'red' : runPct > 70 ? 'yellow' : 'green';
    console.log(`  Session usage:      ${colorize(runBar, runColor)} ${runPct.toFixed(1)}%`);

    if (runPct > 100) {
      console.log(colorize(`  ⚠️  Session exceeded budget by $${(lastSession.stats.totalCost - perRunUsd).toFixed(4)}`, 'red'));
    }
  }

  console.log('');
}

// Render progress bar
function renderProgressBar(percentage, width = 30) {
  const filled = Math.min(Math.round((percentage / 100) * width), width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// Main
async function main() {
  const args = process.argv.slice(2);

  const records = await readTelemetry();
  if (records.length === 0) {
    console.error(colorize('No telemetry data found in .harness/telemetry.jsonl', 'red'));
    process.exit(1);
  }

  const calls = getProviderCalls(records);
  if (calls.length === 0) {
    console.error(colorize('No provider calls found in telemetry data', 'yellow'));
    process.exit(0);
  }

  const config = await readConfig();

  if (args.includes('--daily')) {
    showOverview(calls);
    showDaily(calls);
  } else if (args.includes('--by-provider')) {
    showOverview(calls);
    showByProvider(calls);
  } else if (args.includes('--by-session')) {
    showOverview(calls);
    showBySession(calls);
  } else if (args.includes('--by-skill')) {
    showOverview(calls);
    showBySkill(calls);
  } else if (args.includes('--by-task')) {
    showOverview(calls);
    showByTask(calls);
  } else if (args.includes('--cache-buckets')) {
    showOverview(calls);
    showCacheBuckets(calls);
  } else if (args.includes('--json')) {
    showJson(calls);
  } else if (args.includes('--budget-check')) {
    await checkBudget(calls, config);
  } else {
    showOverview(calls);
    showByProvider(calls);
    showBySkill(calls);
    showCacheBuckets(calls);
    await checkBudget(calls, config);
  }
}

main().catch(err => {
  console.error(colorize(`Error: ${err.message}`, 'red'));
  process.exit(1);
});
