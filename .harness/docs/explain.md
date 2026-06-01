# Explain Guide

Use `agent-harness-kit explain` when a harness gate blocks work or when an
artifact looks incomplete and you need the shortest repair path.

## Commands

```bash
npx agent-harness-kit explain --last-block
npx agent-harness-kit explain --task <taskId>
npx agent-harness-kit explain --permission "Bash(npm test)" --task <taskId>
npx agent-harness-kit explain --evidence .harness/evidence/<taskId>.json
npx agent-harness-kit explain --bypass <fingerprint>
npx agent-harness-kit explain --readiness --strict
```

Every mode supports `--json` for automation. JSON output includes the mode,
status, `blockedBy`, `sourceRule`, task/feature ids when known, runtime,
missing files, missing fields, the next command, override policy, and details.

## Modes

- `--last-block` reads `.harness/telemetry.jsonl` and reports the newest block,
  denial, or failed gate row.
- `--task <taskId>` checks the task contract and linked evidence path, then
  reports missing contract fields, missing evidence, and the evidence checker
  command.
- `--permission <tool>` explains default, skill, and task permission decisions
  using the same matching semantics as the PreToolUse guard.
- `--evidence <path>` checks evidence shape, pass proof fields, and UI artifact
  requirements without rerunning the full Stop hook.
- `--bypass <fingerprint>` explains a bypass audit row, matching approved
  request coverage, and the next strict audit or request command.
- `--readiness` runs readiness in JSON mode and surfaces the first blocking
  required gate plus the exact command to rerun.

Bypasses are not silent fixes. If a gate explicitly allows override, record it
through the reviewed bypass workflow and keep the audit path linked to the task.
