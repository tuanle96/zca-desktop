---
name: propose-harness-improvement
description: Use this skill whenever the agent makes a mistake, the user observes an avoidable failure, a pattern recurs, or someone says "the agent keeps doing X". Files an "Engineer the Harness" entry — Mitchell Hashimoto's discipline: every failure becomes a permanent prevention mechanism. Always invoke this instead of just fixing the immediate symptom.
allowed-tools: Read, Edit, Write, Bash(git diff:*), Bash(node .harness/scripts/improvement-bundle.mjs:*), Bash(node .harness/scripts/record-failure.mjs:*), Bash(node .harness/scripts/check-failure-records.mjs:*)
suggested-turns: 8
---

## Steps

1. **Triage.** Ask: "What just went wrong? What was the agent's intended
   behavior? What's the symptom?"
2. **Gather deterministic signals.** Run the runtime-agnostic bundle when local
   telemetry/bypass logs exist:
   `node .harness/scripts/improvement-bundle.mjs`.
   Use its `taxonomy_classification`,
   `suggested_records`, and `nextSteps` as evidence, not as a substitute for
   judgment.
3. **Classify.** Read `.harness/failures/taxonomy.json` and pick exactly one
   primary class: `context-miss`, `false-done`, `architecture-drift`,
   `test-gap`, `doc-drift`, `tool-misuse`, `permission-gap`, `runtime-gap`,
   `eval-gap`, `cost-spike`, or `model-behavior`.
4. **Write a failure record** with `.harness/scripts/record-failure.mjs`.
   Include evidence paths, prevention target, proposed prevention, and
   verification command when the prevention is already applied or verified.
   If the prevention target differs from the taxonomy class
   `preferredPrevention`, include a concrete prevention justification.
   Hand-write JSON only if the helper is unavailable.
   To promote an existing record after applying the prevention, use
   `.harness/scripts/record-failure.mjs --update=<id> --status=applied|verified`
   so the helper preserves the original failure fields and reruns the checker.
5. **Append a human summary** to `.harness/docs/agent-failures.md` with: date,
   symptom, failure class, prevention target, file modified.
6. **Apply the fix in the right place.** NEVER paper over with a CLAUDE.md
   "be careful" sentence unless rule (a) applies — and even then, only as a
   pointer to a longer doc.
7. **Update PROGRESS.** Append `harness-improvement: <slug>` to
   `.harness/PROGRESS.md`.

## Output contract

```
### Failure: <one-line summary>
### Classification: <taxonomy class>
### Prevention target: <target>
### Fix applied at: <file:line>
### Failure record: .harness/failures/records/<id>.json
### .harness/docs/agent-failures.md entry: §<n>
```

## Anti-patterns (block on these)

- Don't add a vague "be careful with X" sentence to CLAUDE.md.
- Don't add a rule whose enforcement is also LLM-based.
- Don't use this skill to log unrelated cleanup ideas — those go in
  `.harness/docs/tech-debt-tracker.md`.
