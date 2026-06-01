---
name: write-skill
description: Use this skill whenever the user asks to "create a skill", "add a slash command", "package a workflow", or "make X reusable across sessions". Generates a SKILL.md with valid YAML frontmatter (name regex, description ≤ 1024 chars, body ≤ 500 lines) and supporting .harness/scripts/references/assets. Tests the skill by simulating an auto-discovery prompt.
allowed-tools: Read, Edit, Write, Bash(ls:*)
suggested-turns: 8
---

## Steps

1. **Validate the name.** Must match `^[a-z0-9]+(-[a-z0-9]+)*$` and be ≤ 64
   characters.
2. **Write a "pushy" description.** Third-person, ≤ 1024 chars. Explicitly
   mention triggers ("Use this skill whenever the user mentions <X>, <Y>,
   <Z>"). Models under-trigger skills with shy descriptions.
3. **Body sections,** in this order: `## When to use`, `## Steps`,
   `## Output contract`, `## Anti-patterns`. Cap body at 500 lines.
4. **Externalize deterministic logic.** If the skill needs deterministic work
   (parsing, formatting, computation), put it in `.harness/scripts/<name>.sh` (or `.py`
   / `.mjs`) under the skill directory and reference it via a `Bash(...)`
   tool call. SKILL.md stays declarative.
5. **Test discovery.** Open a fresh Claude Code session and prompt with one
   of the description triggers. Verify the skill auto-loads.

## Output contract

```
### Skill: /<name>
### Description bytes: <count>/1024
### Body lines: <count>/500
### Allowed tools: <list>
### Discovery trigger tested: yes/no
```

## Anti-patterns

- Don't write a description that starts with "This skill…" — start with "Use
  this skill whenever the user…" so triggers are front-loaded.
- Don't pack two unrelated workflows into one skill. Split them.
- Don't grant `Bash(*:*)` in `allowed-tools`. Pin specific commands.
