#!/usr/bin/env node
/**
 * session-replay.mjs — Interactive session replay viewer
 *
 * Reconstructs and displays a session timeline from telemetry data.
 * Shows chronological events, tool calls, provider interactions, and errors.
 *
 * Usage:
 *   node scripts/session-replay.mjs <session-id>
 *   node scripts/session-replay.mjs --list  # List recent sessions
 *   node scripts/session-replay.mjs --last  # Replay most recent session
 */

import { readFile, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  annotateProviderCalls,
  calculateStats,
  skillCostRows,
} from './_lib/cost-attribution.mjs';

const readFileAsync = promisify(readFile);

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TELEMETRY_PATH = resolve(ROOT, '.harness/telemetry.jsonl');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function colorize(text, color) {
  return `${colors[color] || ''}${text}${colors.reset}`;
}

function parseArgs(argv) {
  const opts = { list: false, last: false, sessionId: null, html: false, htmlPath: null, maxEvents: null };
  for (const arg of argv) {
    if (arg === '--list') opts.list = true;
    else if (arg === '--last') opts.last = true;
    else if (arg === '--html') opts.html = true;
    else if (arg.startsWith('--html=')) {
      opts.html = true;
      opts.htmlPath = arg.slice('--html='.length);
    } else if (arg.startsWith('--max-events=')) {
      const value = Number.parseInt(arg.slice('--max-events='.length), 10);
      opts.maxEvents = Number.isFinite(value) && value > 0 ? value : null;
    } else if (!arg.startsWith('--')) {
      opts.sessionId = arg;
    }
  }
  return opts;
}

// Read telemetry data
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

function annotateTelemetryRecords(records) {
  const providerCalls = annotateProviderCalls(records);
  let providerIndex = 0;
  return records.map((record) => {
    if (record.event !== 'provider_call') return record;
    const annotated = providerCalls[providerIndex];
    providerIndex += 1;
    return annotated ? { ...record, ...annotated } : record;
  });
}

// Extract unique sessions
function extractSessions(records) {
  const sessions = new Map();

  for (const record of records) {
    if (record.session_id) {
      if (!sessions.has(record.session_id)) {
        sessions.set(record.session_id, {
          id: record.session_id,
          firstSeen: record.ts,
          lastSeen: record.ts,
          events: [],
        });
      }
      const session = sessions.get(record.session_id);
      session.events.push(record);
      if (record.ts > session.lastSeen) session.lastSeen = record.ts;
      if (record.ts < session.firstSeen) session.firstSeen = record.ts;
    }
  }

  return Array.from(sessions.values()).sort((a, b) =>
    new Date(b.firstSeen).getTime() - new Date(a.firstSeen).getTime()
  );
}

// List sessions
function listSessions(sessions) {
  console.log(colorize('\n=== Recent Sessions ===\n', 'bright'));
  console.log(colorize('  ID                                    Started              Events', 'dim'));
  console.log(colorize('  ------------------------------------  -------------------  ------', 'dim'));

  for (const session of sessions.slice(0, 20)) {
    const id = session.id.slice(0, 36).padEnd(36);
    const started = new Date(session.firstSeen).toISOString().slice(0, 19).replace('T', ' ');
    const count = String(session.events.length).padStart(6);
    console.log(`  ${colorize(id, 'cyan')}  ${started}  ${count}`);
  }

  console.log('');
}

// Format timestamp
function formatTime(isoString) {
  const date = new Date(isoString);
  return date.toISOString().slice(11, 23); // HH:MM:SS.mmm
}

// Format duration
function formatDuration(startTs, endTs) {
  if (!startTs || !endTs) return '';
  const ms = new Date(endTs).getTime() - new Date(startTs).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}m`;
}

// Render event
function renderEvent(event, index, total) {
  const time = formatTime(event.ts);
  const prefix = colorize(`[${time}]`, 'gray');
  const num = colorize(`${String(index + 1).padStart(3)}/${total}`, 'dim');

  switch (event.event) {
    case 'session_rollup':
      console.log(`${prefix} ${num} ${colorize('SESSION END', 'bright')}`);
      console.log(`       ${colorize('├─', 'gray')} Reason: ${colorize(event.reason || 'unknown', 'yellow')}`);
      console.log(`       ${colorize('├─', 'gray')} Branch: ${colorize(event.branch || '?', 'cyan')}`);
      console.log(`       ${colorize('├─', 'gray')} Commit: ${colorize(event.sha || '?', 'cyan')}`);
      console.log(`       ${colorize('├─', 'gray')} Uncommitted: ${event.uncommitted || 0}`);
      if (event.skills_invoked && event.skills_invoked.length > 0) {
        console.log(`       ${colorize('└─', 'gray')} Skills: ${colorize(event.skills_invoked.join(', '), 'magenta')}`);
      }
      break;

    case 'skill_invoked':
      console.log(`${prefix} ${num} ${colorize('SKILL', 'magenta')} ${colorize(event.skill || '?', 'bright')}`);
      if (event.args) {
        console.log(`       ${colorize('└─', 'gray')} Args: ${colorize(event.args, 'dim')}`);
      }
      break;

    case 'provider_call':
      const duration = formatDuration(event.start_ts, event.end_ts);
      const status = event.error ? colorize('ERROR', 'red') : colorize('OK', 'green');
      console.log(`${prefix} ${num} ${colorize('PROVIDER', 'blue')} ${colorize(event.provider || '?', 'bright')} ${status}`);
      console.log(`       ${colorize('├─', 'gray')} Model: ${event.model || '?'}`);
      console.log(`       ${colorize('├─', 'gray')} Skill: ${event.skill || 'unattributed'}`);
      console.log(`       ${colorize('├─', 'gray')} Task: ${event.task_id || 'unattributed'}`);
      console.log(`       ${colorize('├─', 'gray')} Tokens: ${event.input_tokens || 0} in / ${event.output_tokens || 0} out`);
      if (event.cache_creation_input_tokens || event.cache_read_input_tokens) {
        console.log(`       ${colorize('├─', 'gray')} Cache: ${event.cache_creation_input_tokens || 0} write / ${event.cache_read_input_tokens || 0} read`);
      }
      if (event.cost_usd || event.attributed_cost_usd) {
        const cost = event.cost_usd || event.attributed_cost_usd || 0;
        console.log(`       ${colorize('├─', 'gray')} Cost: ${colorize(`$${cost.toFixed(4)}`, 'yellow')}`);
      }
      if (duration) {
        console.log(`       ${colorize('├─', 'gray')} Duration: ${duration}`);
      }
      if (event.error) {
        console.log(`       ${colorize('└─', 'gray')} Error: ${colorize(event.error, 'red')}`);
      }
      break;

    case 'tool_execution':
      const toolStatus = event.error ? colorize('ERROR', 'red') : colorize('OK', 'green');
      const toolDuration = event.duration_ms ? `${event.duration_ms}ms` : '';
      console.log(`${prefix} ${num} ${colorize('TOOL', 'cyan')} ${colorize(event.tool_name || '?', 'bright')} ${toolStatus}`);
      if (toolDuration) {
        console.log(`       ${colorize('├─', 'gray')} Duration: ${toolDuration}`);
      }
      if (event.error) {
        console.log(`       ${colorize('└─', 'gray')} Error: ${colorize(event.error, 'red')}`);
      }
      break;

    case 'eval_run':
      const passed = event.passed ? colorize('PASS', 'green') : colorize('FAIL', 'red');
      console.log(`${prefix} ${num} ${colorize('EVAL', 'yellow')} ${event.taskId || '?'} ${passed}`);
      if (event.grades) {
        for (const grade of event.grades) {
          const icon = grade.passed ? '✓' : '✗';
          console.log(`       ${colorize('├─', 'gray')} ${icon} ${grade.dim}: ${grade.info || ''}`);
        }
      }
      break;

    default:
      console.log(`${prefix} ${num} ${colorize(event.event || 'UNKNOWN', 'dim')}`);
      const keys = Object.keys(event).filter(k => k !== 'ts' && k !== 'event' && k !== 'session_id');
      if (keys.length > 0 && keys.length <= 3) {
        for (const key of keys) {
          console.log(`       ${colorize('├─', 'gray')} ${key}: ${JSON.stringify(event[key])}`);
        }
      }
  }

  console.log('');
}

// Replay session
function replaySession(session, opts = {}) {
  console.log(colorize('\n╔════════════════════════════════════════════════════════════════╗', 'bright'));
  console.log(colorize('║                     SESSION REPLAY                             ║', 'bright'));
  console.log(colorize('╚════════════════════════════════════════════════════════════════╝\n', 'bright'));

  console.log(`${colorize('Session ID:', 'dim')} ${colorize(session.id, 'cyan')}`);
  console.log(`${colorize('Started:', 'dim')}    ${session.firstSeen}`);
  console.log(`${colorize('Ended:', 'dim')}      ${session.lastSeen}`);
  console.log(`${colorize('Duration:', 'dim')}   ${formatDuration(session.firstSeen, session.lastSeen)}`);
  console.log(`${colorize('Events:', 'dim')}     ${session.events.length}`);
  console.log('');

  // Sort events chronologically
  const sorted = session.events.sort((a, b) =>
    new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );
  const visible = opts.maxEvents ? sorted.slice(-opts.maxEvents) : sorted;

  // Render timeline
  console.log(colorize('=== Timeline ===\n', 'bright'));
  if (visible.length < sorted.length) {
    console.log(colorize(`Showing last ${visible.length} of ${sorted.length} events. Use a higher --max-events value for full replay.\n`, 'yellow'));
  }
  visible.forEach((event, idx) => renderEvent(event, idx + (sorted.length - visible.length), sorted.length));

  // Summary stats
  const skills = sorted.filter(e => e.event === 'skill_invoked');
  const providers = sorted.filter(e => e.event === 'provider_call');
  const tools = sorted.filter(e => e.event === 'tool_execution');
  const errors = sorted.filter(e => e.error);

  console.log(colorize('=== Summary ===\n', 'bright'));
  console.log(`  Skills invoked:     ${colorize(String(skills.length), 'magenta')}`);
  console.log(`  Provider calls:     ${colorize(String(providers.length), 'blue')}`);
  console.log(`  Tool executions:    ${colorize(String(tools.length), 'cyan')}`);
  console.log(`  Errors:             ${colorize(String(errors.length), errors.length > 0 ? 'red' : 'green')}`);

  if (providers.length > 0) {
    const stats = calculateStats(providers);
    console.log(`  Total tokens:       ${colorize(String(stats.totalTokens), 'yellow')}`);
    console.log(`  Cache write tokens: ${colorize(String(stats.cacheCreationInputTokens), 'yellow')}`);
    console.log(`  Cache read tokens:  ${colorize(String(stats.cacheReadInputTokens), 'yellow')}`);
    console.log(`  Total cost:         ${colorize(`$${stats.totalCost.toFixed(4)}`, 'yellow')}`);

    const bySkill = skillCostRows(providers).slice(0, 5);
    if (bySkill.length > 0) {
      console.log('');
      console.log(colorize('=== Cost by Skill ===\n', 'bright'));
      for (const row of bySkill) {
        console.log(`  ${row.key.padEnd(28)} ${String(row.stats.count).padStart(3)} calls  $${row.stats.totalCost.toFixed(4)}  ${row.stats.totalTokens.toLocaleString()} tokens`);
      }
    }
  }

  console.log('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderHtml(session, opts = {}) {
  const sorted = [...session.events].sort((a, b) =>
    new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );
  const visible = opts.maxEvents ? sorted.slice(-opts.maxEvents) : sorted;
  const providers = sorted.filter(e => e.event === 'provider_call');
  const stats = calculateStats(providers);
  const bySkill = skillCostRows(providers);
  const rows = visible.map((event) => {
    const summary = event.event === 'provider_call'
      ? `${event.provider || 'provider'} ${event.model || ''}`
      : event.event === 'skill_invoked'
        ? event.skill || 'skill'
        : event.event || 'event';
    return `<tr>
      <td>${escapeHtml(formatTime(event.ts))}</td>
      <td>${escapeHtml(event.event || 'unknown')}</td>
      <td>${escapeHtml(event.skill || event.task_id || event.taskId || '')}</td>
      <td>${escapeHtml(summary)}</td>
      <td>${escapeHtml((event.attributed_cost_usd ?? event.cost_usd ?? 0).toFixed ? (event.attributed_cost_usd ?? event.cost_usd ?? 0).toFixed(4) : '0.0000')}</td>
      <td>${escapeHtml(event.attributed_tokens ?? '')}</td>
      <td>${escapeHtml(event.cache_read_input_tokens || 0)} / ${escapeHtml(event.cache_creation_input_tokens || 0)}</td>
    </tr>`;
  }).join('\n');
  const skillRows = bySkill.map(({ key, stats }) => `<tr>
    <td>${escapeHtml(key)}</td>
    <td>${stats.count}</td>
    <td>$${stats.totalCost.toFixed(4)}</td>
    <td>${stats.totalTokens.toLocaleString()}</td>
    <td>${stats.cacheReadInputTokens.toLocaleString()} / ${stats.cacheCreationInputTokens.toLocaleString()}</td>
  </tr>`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Session Replay ${escapeHtml(session.id)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #18212f; background: #f7f8fa; }
    h1, h2 { margin: 0 0 12px; }
    .meta, .cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin: 16px 0 28px; }
    .card { background: #fff; border: 1px solid #d9dee7; border-radius: 8px; padding: 14px; }
    .label { color: #5b6575; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .value { font-size: 22px; font-weight: 700; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d9dee7; margin-bottom: 28px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e6e9ef; font-size: 13px; vertical-align: top; }
    th { background: #eef2f7; color: #344052; }
    code { background: #eef2f7; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Session Replay</h1>
  <div class="meta">
    <div class="card"><div class="label">Session</div><div><code>${escapeHtml(session.id)}</code></div></div>
    <div class="card"><div class="label">Started</div><div>${escapeHtml(session.firstSeen)}</div></div>
    <div class="card"><div class="label">Ended</div><div>${escapeHtml(session.lastSeen)}</div></div>
    <div class="card"><div class="label">Duration</div><div>${escapeHtml(formatDuration(session.firstSeen, session.lastSeen))}</div></div>
  </div>
  <div class="cards">
    <div class="card"><div class="label">Events</div><div class="value">${sorted.length}</div></div>
    <div class="card"><div class="label">Provider Cost</div><div class="value">$${stats.totalCost.toFixed(4)}</div></div>
    <div class="card"><div class="label">Tokens</div><div class="value">${stats.totalTokens.toLocaleString()}</div></div>
    <div class="card"><div class="label">Cache read/write</div><div class="value">${stats.cacheReadInputTokens.toLocaleString()} / ${stats.cacheCreationInputTokens.toLocaleString()}</div></div>
  </div>
  <h2>Cost by Skill</h2>
  <table>
    <thead><tr><th>Skill</th><th>Calls</th><th>Cost</th><th>Tokens</th><th>Cache read/write</th></tr></thead>
    <tbody>${skillRows || '<tr><td colspan="5">No provider calls</td></tr>'}</tbody>
  </table>
  <h2>Timeline</h2>
  ${visible.length < sorted.length ? `<p>Showing last ${visible.length} of ${sorted.length} events.</p>` : ''}
  <table>
    <thead><tr><th>Time</th><th>Event</th><th>Attribution</th><th>Summary</th><th>Cost</th><th>Tokens</th><th>Cache R/W</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`;
}

async function writeHtmlReplay(session, targetPath, opts = {}) {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, renderHtml(session, opts), 'utf8');
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage:
  node scripts/session-replay.mjs <session-id>   Replay specific session
  node scripts/session-replay.mjs --list          List recent sessions
  node scripts/session-replay.mjs --last          Replay most recent session
  node scripts/session-replay.mjs --last --html   Write HTML replay to .harness/replays/
    `);
    process.exit(0);
  }

  const records = annotateTelemetryRecords(await readTelemetry());
  if (records.length === 0) {
    console.error(colorize('No telemetry data found in .harness/telemetry.jsonl', 'red'));
    process.exit(1);
  }

  const sessions = extractSessions(records);
  if (sessions.length === 0) {
    console.error(colorize('No sessions found in telemetry data', 'red'));
    process.exit(1);
  }

  if (opts.list) {
    listSessions(sessions);
  } else {
    const session = opts.last
      ? sessions[0]
      : sessions.find(s => s.id === opts.sessionId || s.id.startsWith(opts.sessionId || ''));
    if (!session) {
      const missing = opts.sessionId || '<missing>';
      console.error(colorize(`Session not found: ${missing}`, 'red'));
      console.error(colorize('\nUse --list to see available sessions', 'dim'));
      process.exit(1);
    }
    replaySession(session, opts);

    if (opts.html) {
      const target = resolve(ROOT, opts.htmlPath || `.harness/replays/${session.id}.html`);
      await writeHtmlReplay(session, target, opts);
      console.log(colorize(`HTML replay written: ${target}`, 'green'));
    }
  }
}

main().catch(err => {
  console.error(colorize(`Error: ${err.message}`, 'red'));
  process.exit(1);
});
