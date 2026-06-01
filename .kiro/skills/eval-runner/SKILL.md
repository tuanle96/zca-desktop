---
name: eval-runner
description: Use this skill whenever a skill, subagent, or hook is changed, before merging to main, or when the user mentions "eval", "regression test for the harness", or "is the harness still working". This skill is a thin wrapper — it runs a single shell command (`npm run harness:eval` or `python -m harness.eval_runner`) and summarizes the JSONL output. Do not implement the eval logic yourself; the runner is already deterministic.
allowed-tools: Bash(npm run harness:eval:*), Bash(python -m harness.eval_runner:*), Read
suggested-turns: 2
---

## When to use

The user said any of: "run the evals", "regression-test the harness", "is the
harness still working", "eval the kit changes".

## Steps

This is a **2-turn skill**. Don't over-engineer.

1. **Run the script.** Pick the right invocation based on stack:
   - TypeScript: `npm run harness:eval -- --quick --transport=mock`
   - Python: `python -m harness.eval_runner --quick --transport=mock`

   Use `--quick` (3 tasks, ~30s) by default. Switch to `--full` only if the
   user asked for it. Use `--transport=claude-cli` only if the user explicitly
   wants a real (paid) run.

2. **Summarize the JSONL output.** Read the latest file in
   `.harness/eval/results/` and produce:

   ```
   ### Eval run: <sha>
   ### Set: quick | full
   ### Transport: mock | claude-cli
   ### Tasks: <pass>/<total>
   ### Failed dimensions:
   - <task-id>.acceptance: acceptance checks failed [<ids>]
   - <task-id>.outcome: <info>
   - <task-id>.process: missing skills [<list>]
   ### Verdict: PASS | FAIL
   ```

That's it. Stop after the summary.

## What NOT to do

- **Don't re-implement the eval logic.** The runner is a deterministic script.
  If you find yourself writing tool calls one by one, you've misread this skill.
- **Don't run `--full --transport=claude-cli` without permission.** That's a
  ~$2 paid API run. Always confirm first.
- **Don't fix failing tasks.** This skill reports the result; fixing is a
  separate task that uses `/structural-test-author` or
  `/propose-harness-improvement`.

## Anti-pattern flag

If you (the agent reading this skill) feel like you need >3 turns to do this,
stop and re-read the steps. The whole skill is: spawn a subprocess, read a
file, format a summary.
