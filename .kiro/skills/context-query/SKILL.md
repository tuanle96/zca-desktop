---
name: context-query
description: Build a compact read-only context packet for a natural-language codebase question. Use before editing unfamiliar code, when tracing task evidence, contracts, validation, or proof paths, or when the relevant files are not obvious.
allowed-tools: Read, Bash(node .harness/scripts/context-query.mjs:*)
suggested-turns: 3
---

# Context Query

Ask the local codebase a natural-language question and get a source-linked
read plan. The command is read-only and returns concise ranked files, snippets,
and next reads; it does not claim to be a final answer.

## Usage

```bash
node .harness/scripts/context-query.mjs "How does task evidence validation work?" --scope scripts --lane normal --json
node .harness/scripts/context-query.mjs "Where is proof checked?" --scope . --limit 6
```

Install `srcwalk` for better structural hits:

```bash
npm install -g srcwalk
```

`srcwalk` is recommended, not required by default. Use `--require-srcwalk`
when the environment should fail closed if structural search is unavailable.

## Output Contract

- `rankedFiles`: highest-confidence files with scores and reasons
- `sources`: concise path:line evidence snippets
- `nextReads`: follow-up files to inspect before editing
- `warnings`: missing optional tools or empty-result notes
