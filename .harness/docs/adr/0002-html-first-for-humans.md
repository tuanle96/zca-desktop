# ADR 0002 — HTML for human deliverables, Markdown for agent files

- **Status:** accepted
- **Date:** 2026-06-01
- **Deciders:** project owner

## Context

The kit produces two distinct kinds of long-form output:

1. **Files an agent reads-and-edits.** `CLAUDE.md`, `SKILL.md`,
   `.claude/agents/*.md`, `.harness/docs/architecture.md`, ADR notes, structural
   reports written to stdout. These are line-oriented, diffable, and
   typically loaded into the LLM context window.
2. **Documents a HUMAN reads-and-decides.** Audit reports, analyses, plans,
   "next actions" reviews, status snapshots, decision docs. These are
   self-contained artefacts that travel via email / Slack / PR attachments
   and exist to surface a recommendation the human signs off on.

Anthropic's long-running-agent guide and the `agent-harness-kit` golden
principles both confirm Markdown is the right format for category 1: the
LLM tokenizes it cheaply, structural editing tools (`Edit`, `Write`) treat
it as native, and grep / sed / awk handle it without ceremony. Category 1
should remain Markdown.

Category 2 is where pain accumulates. A 500–800-line Markdown audit forces
the reader to:

- Scroll past sections that lack visual contrast.
- Render the file (terminal pager, GitHub preview, VS Code preview) before
  it is readable at all.
- Skim and miss conclusions because every heading and bullet looks alike —
  no severity badges, no border-left callouts, no grid layout.

The observed failure mode in this kit's own past sessions: the human reads
the Markdown report, asks the agent a follow-up that was answered in line
347, and burns another turn. That clarification turn costs more in tokens
(input replay + new output) than the +30-50% markup overhead of HTML.

## Decision

Adopt the rule documented as `.harness/docs/golden-principles.md` principle #11:

- **Human-facing deliverables ship as a single self-contained HTML file**
  at repo root, produced by the `/deliver-html` skill against the shared
  CSS at `.claude/skills/deliver-html/assets/report.css`.
- **Agent-facing files stay Markdown.** No exception.

Implementation details:

1. `/deliver-html` triggers on user intent: "analyze", "audit", "review",
   "phân tích", "báo cáo", "plan", "proposal", "decision doc",
   "next actions", and any similar prompt that calls for a long-form
   deliverable.
2. The agent writes the body in Markdown (cheap tokens, easy reasoning).
   The side-car `.harness/scripts/wrap-html.mjs` converts MD → HTML with three
   templates (`decision-doc` | `audit-report` | `status-report`) and
   inlines the shared CSS. No npm dependency: the converter is a
   self-rolled subset (headings, paragraphs, lists, fenced code, tables,
   blockquotes, inline formatting, links).
3. The Stop hook (`.harness/scripts/precompletion-checklist.sh`) emits a
   non-blocking nudge when the user prompt matched a deliverable keyword
   but the session produced only `.md` files at repo root.
4. Locale: the `<html lang="…">` attribute is read from
   `.harness/config.json` `.claudeMd.humanLanguage`. CSS is locale-agnostic.

## Consequences

Positive

- One canonical look for every audit, plan, and decision doc. Less drift
  across reports.
- Human reads once, decides once. Measured benefit: each saved
  clarification turn ≈ 2-5k output tokens + cached input replay; offsets
  HTML markup overhead easily.
- Self-contained HTML — emailable, Slack-attachable, PR-comment-attachable
  without a build step.
- Existing 5 HTML reports at repo root (`NEXT_ACTIONS.html`,
  `PHAN_TICH.html`, `E2E_REPORT.html`, `E2E_CI_REPORT.html`,
  `HOOK_AUDIT.html`) validate the pattern in practice — `/deliver-html`
  formalises it.

Negative

- HTML output is ~30-50% larger in token count than the equivalent MD body.
  Mitigation: the LLM writes MD; only the deterministic side-car emits
  HTML, so the LLM token budget is not affected.
- HTML diffs are noisy in GitHub. Mitigation: deliverables are artefacts,
  not source. Source-of-truth lives in the conversation / commit message;
  the HTML file is a build output. CI can ignore `*.html` at repo root.
- Two formats to teach. Mitigation: the rule is "agent reads → MD,
  human reads → HTML"; reviewers learn it on first encounter.

## Alternatives considered

- **Always Markdown.** Rejected: the failure mode this ADR closes is
  exactly the "scrolling, miss-the-conclusion" loop that Markdown
  invites for long deliverables. README / CHANGELOG remain MD because
  npm/GitHub renders them and the install snippet must be copy-paste-able.
- **Generate PDF instead.** Rejected: solo-dev kit, no print pipeline,
  PDFs are write-only on common review tools. HTML is editable in 90
  seconds when a reviewer wants to amend.
- **Render Markdown server-side (Docusaurus / mdBook / GitHub Pages).**
  Rejected: requires CI + deploy step for every report. HTML at repo root
  opens with one click — zero friction.
- **Inline a renderer in the IDE.** Rejected: not portable when sending the
  artefact to someone who is not running the kit.

## Out of scope

- Existing HTML reports at repo root keep their inline CSS for now.
  Self-contained shipping artefacts trump DRY at solo scale. A future
  cleanup may reference the shared CSS file by relative path — tracked in
  `.harness/docs/tech-debt-tracker.md` if/when it becomes load-bearing.
- Localizing the CSS itself. Style is locale-agnostic by design; only the
  `lang` attribute and body copy differ between locales.
