#!/usr/bin/env node
/**
 * telemetry-export.mjs — Export telemetry data in OpenTelemetry format
 *
 * Reads .harness/telemetry.jsonl and exports traces in OTLP JSON format.
 * Supports exporting to:
 * - Console (JSON output)
 * - File (OTLP JSON)
 * - HTTP endpoint (OTLP/HTTP)
 *
 * Usage:
 *   node scripts/telemetry-export.mjs [--format=otlp|console] [--output=file.json] [--endpoint=http://...]
 *   node scripts/telemetry-export.mjs --last=7d  # Last 7 days
 *   node scripts/telemetry-export.mjs --session=<id>  # Specific session
 */

import { readFile, writeFile, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { annotateProviderCalls } from './_lib/cost-attribution.mjs';

const readFileAsync = promisify(readFile);
const writeFileAsync = promisify(writeFile);

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TELEMETRY_PATH = resolve(ROOT, '.harness/telemetry.jsonl');

// Parse CLI args
function parseArgs() {
  const args = {
    format: 'otlp',
    output: null,
    endpoint: null,
    last: null,
    session: null,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--format=')) args.format = arg.split('=')[1];
    else if (arg.startsWith('--output=')) args.output = arg.split('=')[1];
    else if (arg.startsWith('--endpoint=')) args.endpoint = arg.split('=')[1];
    else if (arg.startsWith('--last=')) args.last = arg.split('=')[1];
    else if (arg.startsWith('--session=')) args.session = arg.split('=')[1];
  }

  return args;
}

// Parse duration like "7d", "24h", "30m"
function parseDuration(str) {
  const match = str.match(/^(\d+)([dhm])$/);
  if (!match) return null;
  const [, num, unit] = match;
  const multipliers = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return parseInt(num, 10) * multipliers[unit];
}

// Read and parse telemetry JSONL
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
      // Skip malformed lines
    }
  }

  return records;
}

// Filter records by time window or session
function filterRecords(records, args) {
  let filtered = records;

  if (args.session) {
    filtered = filtered.filter(r => r.session_id === args.session);
  }

  if (args.last) {
    const duration = parseDuration(args.last);
    if (duration) {
      const cutoff = Date.now() - duration;
      filtered = filtered.filter(r => {
        const ts = new Date(r.ts).getTime();
        return ts >= cutoff;
      });
    }
  }

  return filtered;
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

// Convert to OpenTelemetry trace format
function toOTLP(records) {
  const spans = [];
  const sessionSpans = new Map(); // session_id -> root span

  for (const record of records) {
    const spanId = generateSpanId();
    const traceId = generateTraceId(record.session_id || 'unknown');

    let span;

    switch (record.event) {
      case 'session_rollup':
        span = {
          traceId,
          spanId,
          name: 'session',
          kind: 'SPAN_KIND_INTERNAL',
          startTimeUnixNano: toNano(record.ts),
          endTimeUnixNano: toNano(record.ts),
          attributes: [
            { key: 'session.id', value: { stringValue: record.session_id || '' } },
            { key: 'session.reason', value: { stringValue: record.reason || '' } },
            { key: 'git.branch', value: { stringValue: record.branch || '' } },
            { key: 'git.sha', value: { stringValue: record.sha || '' } },
            { key: 'git.uncommitted', value: { intValue: record.uncommitted || 0 } },
            { key: 'skills.count', value: { intValue: (record.skills_invoked || []).length } },
          ],
          status: { code: 'STATUS_CODE_OK' },
        };
        sessionSpans.set(record.session_id, spanId);
        break;

      case 'skill_invoked':
        const parentSpanId = sessionSpans.get(record.session_id);
        span = {
          traceId,
          spanId,
          parentSpanId,
          name: `skill.${record.skill}`,
          kind: 'SPAN_KIND_INTERNAL',
          startTimeUnixNano: toNano(record.ts),
          endTimeUnixNano: toNano(record.ts),
          attributes: [
            { key: 'skill.name', value: { stringValue: record.skill || '' } },
            { key: 'session.id', value: { stringValue: record.session_id || '' } },
          ],
          status: { code: 'STATUS_CODE_OK' },
        };
        break;

      case 'provider_call':
        span = {
          traceId,
          spanId,
          name: `provider.${record.provider}`,
          kind: 'SPAN_KIND_CLIENT',
          startTimeUnixNano: toNano(record.start_ts || record.ts),
          endTimeUnixNano: toNano(record.end_ts || record.ts),
          attributes: [
            { key: 'provider.name', value: { stringValue: record.provider || '' } },
            { key: 'provider.model', value: { stringValue: record.model || '' } },
            { key: 'skill.name', value: { stringValue: record.skill || '' } },
            { key: 'task.id', value: { stringValue: record.task_id || record.taskId || '' } },
            { key: 'tokens.input', value: { intValue: record.input_tokens || 0 } },
            { key: 'tokens.output', value: { intValue: record.output_tokens || 0 } },
            { key: 'tokens.cache_creation', value: { intValue: record.cache_creation_input_tokens || 0 } },
            { key: 'tokens.cache_read', value: { intValue: record.cache_read_input_tokens || 0 } },
            { key: 'cost.usd', value: { doubleValue: record.cost_usd || 0 } },
            { key: 'cost.attributed_usd', value: { doubleValue: record.attributed_cost_usd || record.cost_usd || 0 } },
            { key: 'cost.cache_creation_usd', value: { doubleValue: record.cost_buckets_usd?.cacheWrite || 0 } },
            { key: 'cost.cache_read_usd', value: { doubleValue: record.cost_buckets_usd?.cacheRead || 0 } },
          ],
          status: { code: record.error ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK' },
        };
        break;

      case 'tool_execution':
        span = {
          traceId,
          spanId,
          name: `tool.${record.tool_name}`,
          kind: 'SPAN_KIND_INTERNAL',
          startTimeUnixNano: toNano(record.start_ts || record.ts),
          endTimeUnixNano: toNano(record.end_ts || record.ts),
          attributes: [
            { key: 'tool.name', value: { stringValue: record.tool_name || '' } },
            { key: 'tool.duration_ms', value: { intValue: record.duration_ms || 0 } },
          ],
          status: { code: record.error ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK' },
        };
        break;

      default:
        // Generic event
        span = {
          traceId,
          spanId,
          name: record.event || 'unknown',
          kind: 'SPAN_KIND_INTERNAL',
          startTimeUnixNano: toNano(record.ts),
          endTimeUnixNano: toNano(record.ts),
          attributes: Object.entries(record)
            .filter(([k]) => k !== 'ts' && k !== 'event')
            .map(([k, v]) => ({
              key: k,
              value: typeof v === 'string'
                ? { stringValue: v }
                : typeof v === 'number'
                ? { intValue: v }
                : { stringValue: JSON.stringify(v) }
            })),
          status: { code: 'STATUS_CODE_OK' },
        };
    }

    if (span) spans.push(span);
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'agent-harness-kit' } },
            { key: 'service.version', value: { stringValue: '0.11.2' } },
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: 'agent-harness-kit.telemetry',
              version: '1.0.0',
            },
            spans,
          },
        ],
      },
    ],
  };
}

// Generate span ID (16 hex chars)
function generateSpanId() {
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
}

// Generate trace ID (32 hex chars, deterministic from session)
function generateTraceId(sessionId) {
  const hash = sessionId.split('').reduce((acc, char) => {
    return ((acc << 5) - acc) + char.charCodeAt(0);
  }, 0);
  const hex = Math.abs(hash).toString(16).padStart(32, '0').slice(0, 32);
  return hex;
}

// Convert ISO timestamp to nanoseconds
function toNano(isoString) {
  if (!isoString) return '0';
  const ms = new Date(isoString).getTime();
  return String(ms * 1_000_000);
}

// Export to HTTP endpoint
async function exportToHTTP(data, endpoint) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Main
async function main() {
  const args = parseArgs();

  // Read telemetry
  const records = annotateTelemetryRecords(await readTelemetry());
  if (records.length === 0) {
    console.error('No telemetry data found in .harness/telemetry.jsonl');
    process.exit(1);
  }

  // Filter
  const filtered = filterRecords(records, args);
  console.error(`Loaded ${records.length} records, filtered to ${filtered.length}`);

  // Convert to OTLP
  const otlpData = toOTLP(filtered);

  // Output
  if (args.endpoint) {
    console.error(`Exporting to ${args.endpoint}...`);
    const result = await exportToHTTP(otlpData, args.endpoint);
    if (result.success) {
      console.error('✅ Export successful');
    } else {
      console.error(`❌ Export failed: ${result.error}`);
      process.exit(1);
    }
  } else if (args.output) {
    await writeFileAsync(args.output, JSON.stringify(otlpData, null, 2));
    console.error(`✅ Exported to ${args.output}`);
  } else {
    // Console output
    console.log(JSON.stringify(otlpData, null, 2));
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
