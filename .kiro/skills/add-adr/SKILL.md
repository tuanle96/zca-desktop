---
name: add-adr
description: Use this skill whenever a decision is made about architecture, dependencies, frameworks, naming conventions, or layer order. Creates a numbered ADR (Architecture Decision Record) in `.harness/docs/adr/` in the canonical Nygard format. Always invoke this before changing layer order, adding a layer, swapping a major dependency, or introducing a new external service.
allowed-tools: Read, Write, Glob
suggested-turns: 6
---

## When to use ADR

Use this skill when making architectural decisions. See `/feature-intake` for the complete list of ADR triggers.

**Quick reference - ADR required for:**
- New layer, domain, or provider
- Breaking API changes
- Security/auth boundary changes
- Data model migrations
- Performance-critical path changes
- Deployment strategy changes

**Rule of thumb:** If the decision affects multiple teams, has long-term implications, or sets a precedent → create an ADR.

For the complete list of triggers with examples, see the "ADR Triggers (Explicit)" section in `/feature-intake` SKILL.md.

## Steps

1. **Find the next number.** List `.harness/docs/adr/` and pick the highest existing
   number + 1 (zero-padded to 4 digits).
2. **Generate the file.** Write `.harness/docs/adr/{NNNN}-{kebab-title}.md` with the
   sections below.
3. **Update affected configs.** If the ADR changes layer order or adds a
   layer, update `.harness/config.json` AND the structural-test config in the
   same commit as the ADR.
4. **Append to the index.** Add a one-line entry under "Recent decisions" in
   `.harness/docs/architecture.md`.

## ADR template (write exactly this shape)

```markdown
# ADR <NNNN> — <title>

- **Status:** proposed | accepted | superseded by <link>
- **Date:** YYYY-MM-DD
- **Deciders:** <names or "project owner">

## Context

<What forces are in play? What constraints? What did we learn that triggered this?>

## Decision

<What we decided. Single sentence then a list.>

## Consequences

Positive: ...
Negative: ...

## Alternatives considered

- <alternative>: <why rejected>
- <alternative>: <why rejected>
```

## Output contract

```
### ADR: <NNNN>-<slug>
### Status: <status>
### Configs updated: <list or "none">
### .harness/docs/architecture.md updated: yes/no
```

## Anti-patterns

- Don't write an ADR for a one-line refactor — those go in commit messages.
- Don't change the status of an existing ADR retroactively. Supersede it.
