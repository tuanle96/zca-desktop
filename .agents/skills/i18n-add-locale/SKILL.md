---
name: i18n-add-locale
description: Use this skill to scaffold a new human-language locale for the kit's skills/agents/CLAUDE.md. Mirrors every existing SKILL.md.hbs into a SKILL.md.<locale>.hbs stub so a translator (or LLM) can edit copy without touching machine-readable frontmatter. Default locale codes — vi, ja, fr, es, de — but accepts any 2-5 char code.
allowed-tools: Read, Write, Bash(node .harness/scripts/locale-scaffold.mjs:*)
suggested-turns: 4
---

## When to invoke

- Adding a new human language to the kit (or a fork's downstream).
- After upstream adds a new English skill — re-running this skill scaffolds
  the locale stubs for the new file, leaving translated files untouched.

## Steps

1. **Pick a locale.** Two-to-five char ISO code (vi, ja, fr-CA, etc.).
2. **Dry-run the scan.**
   ```
   node .agents/skills/i18n-add-locale/scripts/locale-scaffold.mjs \
     --locale <code> --dry-run
   ```
   Lists every SKILL.md / SKILL.md.hbs that lacks a `.<locale>.hbs` sibling.
3. **Materialize stubs.**
   ```
   node .agents/skills/i18n-add-locale/scripts/locale-scaffold.mjs \
     --locale <code>
   ```
   For each missing sibling, copies the English master and prepends a
   `<!-- LOCALE_TODO: translate body --> ` banner so the translator can grep
   for pending work.
4. **Register the locale.** Edit `src/core/render-templates.mjs` and add the
   code to `SUPPORTED_HUMAN_LANGS`. The renderer picks the variant via
   `--locale <code>` or `HARNESS_LOCALE` env.
5. **Verify rendering** by running `agent-harness-kit init --locale <code>`
   in a scratch dir and grepping the output for `LOCALE_TODO` (must be
   zero before publishing).

## Output contract

```
locale: <code>
scaffolded: <N>
already-present: <M>
register-in: src/core/render-templates.mjs (SUPPORTED_HUMAN_LANGS)
```

## Anti-patterns

- Don't translate the YAML frontmatter — the renderer + Claude Code parse
  it as machine-readable. Translate only the body markdown.
- Don't drop the master `.hbs` file. The locale stub *augments*; the
  renderer falls back to the master when the locale variant is missing.
