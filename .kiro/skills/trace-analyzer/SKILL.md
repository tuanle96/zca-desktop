---
name: trace-analyzer
description: Use this skill when an eval, regression run, hook, or long agent session fails and the next step depends on trace evidence. Classifies the failure from telemetry, transcripts, eval JSONL, git diff, and hook output before proposing a fix. Prevents prompt-only guesses by requiring a trace-backed failure class.
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*), Bash(node .harness/scripts/harness-report.mjs:*)
---

# Trace Analyzer

## When to use

- An eval or regression task failed and the cause is not obvious.
- A hook blocked completion and the agent needs to distinguish real repo risk from harness noise.
- A long session drifted, skipped a skill, edited the wrong file, or ended with weak evidence.
- The user asks "why did this harness run fail?", "analyze the trace", or "deep research this failure".

## Steps

1. Locate the freshest evidence under `.harness/eval/results/`, `.harness/regression/results/`, `.harness/telemetry.jsonl`, and any referenced transcript path.
2. Read the changed files with `git diff` and correlate the failure with the exact surface touched.
3. Read `.harness/failures/taxonomy.json` and classify one primary failure class:
   - `context-miss`
   - `false-done`
   - `architecture-drift`
   - `test-gap`
   - `doc-drift`
   - `tool-misuse`
   - `permission-gap`
   - `runtime-gap`
   - `eval-gap`
   - `cost-spike`
   - `model-behavior`
4. Identify whether the fix belongs in a skill, hook, subagent, deterministic script, eval task, README/docs, or project code.
5. Recommend the smallest prevention, not just a one-off patch.

## Output contract

```markdown
### Trace analysis
**Primary class:** <failure-class>
**Evidence:** <file/path or transcript reference>
**Root cause:** <one paragraph>
**Prevention target:** skill | hook | subagent | script | eval | docs | project-code
**Failure record:** .harness/failures/records/<id>.json
**Recommended fix:** <smallest durable change>
**Verification:** <command or eval that proves it>
```

## Anti-patterns

- Do not infer a root cause without citing trace, telemetry, or diff evidence.
- Do not classify multiple primary causes unless the trace proves independent failures.
- Do not edit files from this skill; hand off to `/harness-improvement-loop` or the normal implementation lane.
