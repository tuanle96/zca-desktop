---
name: deliver-html
description: Use this skill whenever the user asks to analyze, audit, review, summarize, produce a report, write a plan, make a proposal, draft a decision doc, list "next actions", or any other task that produces a DOCUMENT a HUMAN reads-and-acts-on. Outputs a self-contained <slug>.html at repo root using the shared dark-theme CSS. Why HTML and not Markdown: golden principle #9 — Markdown is great for files an agent reads-and-edits (CLAUDE.md, SKILL.md, ADRs), but a HUMAN reading a 700-line MD deliverable will scroll, miss the conclusion, and ask the agent to clarify — burning turns and tokens. HTML deliverable is read once, decided once. Do NOT use this skill for files the agent itself reads (those stay MD), for stdout output from /review-this-pr or /garbage-collection (pass-through MD), or for short summaries under ~30 lines (overhead not worth it).
allowed-tools: Read, Write, Bash(node .kiro/skills/deliver-html/scripts/wrap-html.mjs:*), Bash(cat:*), Bash(ls:*)
suggested-turns: 6
---

## When to use

Trigger words from the user (English / Vietnamese):

- "analyze X", "audit X", "review X for me" / "phân tích X", "audit X", "review giúp tôi"
- "produce a report on X" / "báo cáo về X", "tổng kết X"
- "plan for X", "proposal for X", "decision doc for X" / "plan cho X", "đề xuất X"
- "what should we do about X", "next actions for X" / "next actions cho X"

Do **NOT** use for:

- Editing `CLAUDE.md`, `SKILL.md`, `.harness/docs/*.md`, or any agent-read file (those stay MD).
- Pass-through stdout from `/review-this-pr`, `/garbage-collection`, `/inspect-module` (the agent itself consumes that — keep it MD).
- Short summaries (< 30 lines of body). Just answer inline.
- Files that will be diffed in a PR. Source-of-truth stays MD.

## Steps

1. **Pick a template** based on what the user is asking for:
   - `decision-doc` (default) — analysis + recommendation + next actions
   - `audit-report` — findings table with severity, current vs. target state
   - `status-report` — shipped progress + remaining work + KPIs

2. **Write the MD body** in working memory. Use standard GitHub-flavored
   Markdown: `#`/`##`/`###` headings, paragraphs, `-`/`1.` lists, fenced
   ```` ```code``` ````, `> blockquote`, `| a | b |` tables, and inline
   `code`/`**bold**`/`*italic*`/`[link](url)`.

   You may also use these CSS hooks via raw HTML for richer visuals:
   - `<div class="card good|warn|bad|info|next">…</div>` — bordered callout
   - `<span class="pill good|warn|bad|info|alt">P0</span>` — inline badge
   - `<div class="grid2|grid3">…</div>` — column layout
   - `<div class="stat good|warn|info"><div class="lbl">…</div><div class="num">…</div></div>` — stat tile

3. **Pick a slug** (kebab-case, derived from title). Default: same dir as
   CWD (repo root). Example: title "Phân tích auth flow" → file
   `phan-tich-auth-flow.html`.

4. **Render** with the side-car script:

   ```bash
   node .agents/skills/deliver-html/scripts/wrap-html.mjs \
     --title "Phân tích auth flow" \
     --subtitle "Bằng chứng, lập luận, next actions" \
     --template decision-doc \
     --in /tmp/body.md \
     --out phan-tich-auth-flow.html
   ```

   The script:
   - Reads `assets/report.css` (single source of truth for the style).
   - Auto-detects locale from `.harness/config.json` `.claudeMd.humanLanguage` (override with `--lang`).
   - Converts MD → HTML (self-rolled subset: headings, lists, code blocks,
     tables, blockquotes, links, inline formatting — no npm dependency).
   - Writes `<slug>.html` at the path you pass.
   - **Auto-opens** the file in the default browser (`open`/`xdg-open`/`start`).
     Suppress with `--no-open`, or by setting `AHK_DISABLE_HTML_OPEN=1` /
     `CI=true` in the environment. Open failures (missing binary, headless
     box) never fail the deliverable.

5. **Print the deliverable contract** (the script already does this — copy it
   into your response):

   ```
   ### Deliverable
   **File:** <path>  (<size>)
   **Template:** decision-doc | audit-report | status-report
   **Lang:** vi | en
   **Open:** auto-opened   (or fallback hint if --no-open / CI=true)
   ```

## Output contract

The script writes exactly one file (`<slug>.html`) at the requested path and
prints the deliverable contract on stdout. The HTML is self-contained
(CSS inlined) so it can be emailed / sent on Slack / attached to a PR with no
dependencies.

## Anti-patterns

- **Don't write raw HTML markup in your MD body** beyond the CSS hook
  patterns above (cards, pills, grids, stats). The wrap script handles the
  document chrome — your job is content.
- **Don't inline `<style>` blocks in the body.** The wrap script injects
  shared CSS once. Inline overrides drift over time.
- **Don't use this skill for `.harness/docs/*.md` updates.** Those are agent-read;
  they stay MD per principle #9.
- **Don't claim "done" without writing the file.** The deliverable IS the
  file. If `wrap-html.mjs` errored, do not move on.
- **Don't open a deliverable shorter than ~30 lines as HTML.** A short
  answer belongs in the chat response, not a file.
- **Don't translate the CSS.** Style is locale-agnostic. Only the `lang`
  attribute and body copy localize.
