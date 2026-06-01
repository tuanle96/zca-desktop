---
name: skill-discovery
description: Build a lightweight skill index and load full skill instructions only on demand to reduce startup context pressure.
allowed-tools: Read, Bash(node .harness/scripts/skill-discovery.mjs:*), Bash(node .harness/scripts/skill-load.mjs:*)
suggested-turns: 4
---

# Skill Discovery / On-Demand Loading

Generates `.harness/skill-index.json` from skill frontmatter so agents can discover commands without loading every full `SKILL.md`.

## Commands

```bash
node .harness/scripts/skill-discovery.mjs
node .harness/scripts/skill-load.mjs create-story
```

## Output contract

```markdown
### Skill index
### Skills indexed: <n>
### Full skill loaded: <name or n/a>
```
