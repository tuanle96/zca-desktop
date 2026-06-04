---
name: map-domain
description: Use this skill to render the harness's domain/layer config as a mermaid diagram + check for drift between .harness/config.json#domains and the actual filesystem. Surfaces "the config says layers A→B→C but the repo has folders A, B, X" — drift that silently invalidates the structural-test contract.
allowed-tools: Read, Bash(node .kiro/skills/map-domain/scripts/domain-map.mjs:*)
suggested-turns: 3
---

## When to invoke

- After editing `.harness/config.json#domains`.
- After moving files between layer directories.
- During onboarding — gives a one-glance view of the kit's layer rule.

## Steps

1. **Run the side-car.**
   ```
   node .agents/skills/map-domain/scripts/domain-map.mjs --out .harness/docs/architecture/domain-map.md
   ```
2. **Inspect drift.** The mermaid diagram embeds a "drift" badge per layer:
   - `✓` — config layer name has a matching `<root>/<layer>/` directory.
   - `✗` — directory missing.
   - `?` — directory exists but contains only sub-layers (likely OK; review).
3. **Update the README** (optional). The generated markdown is safe to
   commit; re-running the side-car is idempotent.

## Output contract

```
domains: <N>
layers: <M>
drift_count: <K>
report: .harness/docs/architecture/domain-map.md
```

## Anti-patterns

- Don't rename a layer in the config without moving the directory at the
  same time — the structural-test will start scanning a path that no
  longer exists.
- Don't add a layer to the config without seeding it with at least a
  `README.md` so the drift check passes.
