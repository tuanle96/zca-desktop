---
name: doc-drift-scan
description: Use this skill weekly, before releases, or when the user mentions "stale docs", "doc drift", "docs are wrong", or "the README is out of date". Cross-checks every code path, file path, and command referenced in `.harness/docs/` and `CLAUDE.md` against the current repo state and produces a list of stale references — the doc-gardening agent pattern.
allowed-tools: Read, Glob, Grep, Bash(test -e:*), Bash(command -v:*), Bash(node .kiro/skills/doc-drift-scan/scripts/scan-paths.mjs:*)
suggested-turns: 8
---

## Steps

1. **Extract references + validate (deterministic).** Run the side-car
   script — walks `.harness/docs/**/*.md` + `CLAUDE.md`, extracts every backtick-path
   containing a slash, checks `existsSync` per ref:

   ```bash
   node .kiro/skills/doc-drift-scan/scripts/scan-paths.mjs
   ```

   Read the JSON: `{ stats: { docs_scanned, refs_found, refs_missing },
   drift: [{ doc, ref }] }`. Replaces three LLM grep turns.
2. **Validate commands (LLM judgment, narrow).** Optional second pass for
   backtick-commands the side-car doesn't classify (no slash → not a path).
   Use `command -v <cmd>` and allow a small allowlist (`jq`, `gh`, `rg`).
3. **Group findings.**
   - `missing-paths`: file moved or deleted.
   - `wrong-layer-claim`: doc says module is in layer X, structural test
     says layer Y.
   - `outdated-commands`: command no longer exists or signature changed.
4. **Open ONE PR.** Label `doc-drift`. Patch all findings in one commit. Do
   not merge.

## Output contract

```
### Doc-drift scan: <date>
### References checked: <N>
### Drifted: <count>
### PR opened: #<n>
### Top 3 drifts:
1. ...
2. ...
3. ...
```

## Anti-patterns

- Don't fix code to match docs. Fix docs to match code.
- Don't propose deleting a doc that drifted — drift means the doc was once
  useful. Update or supersede it.
