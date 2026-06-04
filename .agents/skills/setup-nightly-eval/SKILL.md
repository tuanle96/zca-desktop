---
name: setup-nightly-eval
description: Use this skill when the user wants to schedule the harness eval to run every night, asks "how do I set up nightly evals", "schedule the eval", "run evals on a cron", or "nightly regression for the harness". The kit already ships a GitHub Actions workflow at .github/workflows/eval-nightly.yml — this skill walks the user through enabling it (secret setup, smoke run via workflow_dispatch, verifying the first scheduled run). Do NOT use this skill to "remind me to run eval every night in this Claude session" — that is the /loop skill or CronCreate (which is session-only), a different concern.
allowed-tools: Read, Bash(gh workflow run:*), Bash(gh run watch:*), Bash(gh secret list:*), Bash(ls:*), Bash(cat:*), Bash(test:*)
suggested-turns: 4
---

## Background — why GitHub Actions, not CronCreate

A common request is "use CronCreate to run the eval every night". That
does not do what the user wants:

- `CronCreate` jobs live only in the **current Claude Code session**.
  Closing the REPL deletes them. Auto-expire after 7 days regardless.
- Jobs only fire while the REPL is **idle**, not when the laptop is
  asleep or off.
- They run *Claude turns*, which spend tokens for every fire.

For a real nightly cadence ("runs at 6am whether I'm at the keyboard or
not"), the right substrate is OS-level cron / launchd / GitHub Actions.
This kit ships a GitHub Actions workflow as the default because:

1. No local daemon to babysit.
2. Free for public repos and within the free tier for most private ones.
3. Results land in workflow artifacts — visible from anywhere.

## When to use

Trigger phrases (English / Vietnamese):

- "set up nightly eval" / "lập lịch eval mỗi đêm"
- "schedule the harness eval"
- "make the eval run on a cron"
- "nightly regression for the harness"

Do **NOT** invoke for:

- One-off ad-hoc eval runs — use `/eval-runner` directly.
- In-session polling ("re-run every 10 min until I say stop") — that's
  the `/loop` skill.
- Local-machine cron setup (launchd / crontab) — that path is on the
  user's machine and a skill cannot install OS daemons. Print the
  recipe and let them paste it.

## Steps

1. **Verify the workflow file exists.** It ships via `installCi: true`.

   ```bash
   test -f .github/workflows/eval-nightly.yml && echo OK || echo MISSING
   ```

   If MISSING: the user opted out of CI files at scaffold time. Tell
   them to re-run `agent-harness-kit init --yes` without `--no-ci` (or to
   manually copy from `node_modules/agent-harness-kit/src/templates/_ci/`).
   The workflow should run harness readiness and `git diff --check` before
   eval work, and should conditionally install Node/Python dependencies.

2. **Check the eval transport.** The workflow defaults to `mock`
   transport unless `ANTHROPIC_API_KEY` is set in repo secrets. Decide
   with the user:

   - **Mock (free):** smoke-tests the eval runner shape — catches a
     broken JSONL writer, but does not exercise the model. Good
     default for forks / OSS.
   - **claude-cli (real, costs tokens):** runs the actual model on
     each task. Catches regressions caused by prompt/skill changes.
     Costs ~$0.05–0.50/night depending on task set size.

3. **(If real transport) ensure the secret is set:**

   ```bash
   gh secret list | grep ANTHROPIC_API_KEY
   ```

   If absent, ask the user to set it via:

   ```bash
   gh secret set ANTHROPIC_API_KEY
   # paste the key when prompted (it never appears in shell history)
   ```

4. **Trigger a first manual run** via `workflow_dispatch` so the user
   does not wait 24h to confirm the wiring:

   ```bash
   gh workflow run eval-nightly.yml --field set=quick --field transport=mock
   # then watch:
   gh run watch
   ```

5. **Print the contract.** What the user just enabled:

   ```
   ### Nightly eval enabled
   **Workflow:** .github/workflows/eval-nightly.yml
   **Cron:** 0 6 * * * UTC (offset: see `gh run list` for actual fire times)
   **Transport:** mock | claude-cli
   **Set:** quick (3 tasks) | full (all tasks)
   **Results:** uploaded as `eval-results` artifact on each run
   ```

## Output contract

The skill prints a single block matching the shape above. Do not edit
the workflow file from here — if the user wants to change the cron, the
task set, or the transport default, they edit
`.github/workflows/eval-nightly.yml` directly (it is a normal yml file,
not a templated artifact, after install).

## When the workflow file is owned by the kit

Re-running `agent-harness-kit upgrade` will refresh
`.github/workflows/eval-nightly.yml`. If the user has hand-tuned cron
or transport defaults, mention this — they should either:

- Move their customisation into `.harness/config.json#evals` (kit reads
  it on next render) and let the workflow stay vanilla, or
- Document the customisation in a comment so the next upgrade does not
  silently overwrite it.
