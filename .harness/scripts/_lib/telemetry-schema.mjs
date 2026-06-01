// Canonical telemetry taxonomy for .harness/telemetry.jsonl.
//
// Keep this file dependency-free: generated scripts import it from
// .harness/scripts/_lib/ after install. Readers accept legacy rows where
// practical, but writers should emit schemaVersion: 1 and one of these event
// names.

export const TELEMETRY_SCHEMA_VERSION = 1;

export const TELEMETRY_EVENTS = Object.freeze({
  skillInvoked: "skill_invoked",
  notification: "notification",
  subagentStop: "subagent_stop",
  sessionRollup: "session_rollup",
  providerCall: "provider_call",
  toolExecution: "tool_execution",
  evalRun: "eval_run",
  structuralTestFail: "structural_test_fail",
  precompletionBlock: "precompletion_block",
  precompletionLoopGuard: "precompletion_loop_guard",
  permissionDenied: "permission_denied",
  userpromptBlock: "userprompt_block",
  blockRemediated: "block_remediated",
});

export const TELEMETRY_REQUIRED_KEYS = Object.freeze({
  [TELEMETRY_EVENTS.skillInvoked]: ["ts", "event", "skill", "sha"],
  [TELEMETRY_EVENTS.notification]: ["ts", "event", "hook", "type", "title", "body"],
  [TELEMETRY_EVENTS.subagentStop]: ["ts", "event", "subagent", "sha"],
  [TELEMETRY_EVENTS.sessionRollup]: ["ts", "event", "reason", "session_id", "sha"],
  [TELEMETRY_EVENTS.providerCall]: ["ts", "event", "provider"],
  [TELEMETRY_EVENTS.toolExecution]: ["ts", "event", "tool_name"],
  [TELEMETRY_EVENTS.evalRun]: ["ts", "event", "taskId", "passed"],
  [TELEMETRY_EVENTS.structuralTestFail]: ["ts", "event", "source"],
  [TELEMETRY_EVENTS.precompletionBlock]: ["ts", "event", "rule"],
  [TELEMETRY_EVENTS.precompletionLoopGuard]: ["ts", "event", "rule"],
  [TELEMETRY_EVENTS.permissionDenied]: ["ts", "event", "rule", "reason"],
  [TELEMETRY_EVENTS.userpromptBlock]: ["ts", "event", "rule", "reason"],
  [TELEMETRY_EVENTS.blockRemediated]: ["ts", "event", "rule"],
});

export const TELEMETRY_OPTIONAL_KEYS = Object.freeze({
  [TELEMETRY_EVENTS.skillInvoked]: [
    "session_id",
    "task_id",
  ],
  [TELEMETRY_EVENTS.providerCall]: [
    "session_id",
    "skill",
    "lane",
    "risk_tier",
    "task_id",
    "model",
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "cost_usd",
  ],
  [TELEMETRY_EVENTS.precompletionBlock]: ["session_id", "task_id", "failures"],
  [TELEMETRY_EVENTS.permissionDenied]: ["session_id", "skill", "task_id", "tool"],
  [TELEMETRY_EVENTS.userpromptBlock]: ["session_id", "prompt"],
  [TELEMETRY_EVENTS.blockRemediated]: ["session_id", "task_id", "fingerprint", "source"],
});

export function telemetryEventName(row) {
  if (typeof row?.event === "string" && row.event.length > 0) return row.event;
  // Legacy Notification rows shipped with hook but no event.
  if (row?.hook === "Notification") return TELEMETRY_EVENTS.notification;
  return "unknown";
}

export function isKnownTelemetryEvent(row) {
  return Object.values(TELEMETRY_EVENTS).includes(telemetryEventName(row));
}

export function isSkillInvocationRecord(row) {
  return (
    typeof row?.skill === "string" &&
    row.skill.length > 0 &&
    (row.event === undefined || row.event === TELEMETRY_EVENTS.skillInvoked)
  );
}

export function validateTelemetryRecord(row) {
  const event = telemetryEventName(row);
  const required = TELEMETRY_REQUIRED_KEYS[event] ?? ["ts", "event"];
  const missing = required.filter((key) => row?.[key] === undefined || row?.[key] === "");
  return {
    ok: missing.length === 0,
    event,
    schemaVersion: row?.schemaVersion ?? null,
    missing,
  };
}
