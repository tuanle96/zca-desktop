---
name: inspect-module
description: Use this skill whenever the user mentions "explore", "inspect", "understand", "what does X do", "where is Y", or before adding a new feature in an unfamiliar area. Produces a structured map of one module — files, exports, dependencies, layer assignment, and recent commits — without reading the entire codebase. Always invoke this skill before editing an unfamiliar module so the agent has accurate context, not guesses.
allowed-tools: Read, Glob, Grep, Bash(git log:*), Bash(git ls-tree:*), Bash(tree:*), Bash(node .kiro/skills/inspect-module/scripts/module-summary.mjs:*)
suggested-turns: 6
---

## When to use

The user asked any of: "how does X work", "what's in src/foo", "before I add
feature Y, what's in the area?", "explore <path>", "show me the shape of
<module>".

## Steps

1. **Resolve the target.** If the user gave a feature name (not a path), grep
   `.harness/feature_list.json` for it. If multiple paths match, ask the user which.
2. **One-shot summary (deterministic).** Run the side-car script — bundles
   target kind + layer + recent commits, and for module targets also exports +
   inbound + outbound deps, into one JSON blob, replacing three LLM turns of grep:

   ```bash
   node .agents/skills/inspect-module/scripts/module-summary.mjs <target>
   ```

   Read the JSON. If `targetKind` is `workspace`, render a workspace overview
   from `workspace.domains` and do not warn about `layer: null`. If `targetKind`
   is `unlayered`, the path is outside any configured layer root — flag that
   and ask whether the user wants to add it. If `targetKind` is `module`, use
   the reported `layer` normally.
3. **Forward-only check.** For `targetKind: "module"`, walk `outbound[]` and verify each crosses layers
   forward only (never backward). The structural test enforces this
   mechanically too, but flagging here short-circuits a wasted write step.
4. **Risks.** Flag any of: dynamic imports, eval, shell-out with
   interpolation, missing tests for an exported function. (LLM judgment —
   the side-car reports facts, not risks.)

## Output contract

Produce a Markdown report with these sections, in this order:

For `targetKind: "workspace"`:

```
### Module: workspace overview
### Layer: workspace overview
### Domains: <domain roots and layers>
### Recent changes: <top 3 commit messages>
### Risks: <bulleted list, "none" if clean>
```

For module or unlayered targets:

```
### Module: <path>
### Layer: <layer-name or unlayered>
### Public surface: <list>
### Inbound deps: <list of paths>
### Outbound deps: <list of paths or external packages>
### Recent changes: <top 3 commit messages>
### Risks: <bulleted list, "none" if clean>
```

End with: "I am ready to make changes to `<module>`. The architecture-reviewer
subagent will be invoked on completion."

## Anti-patterns

- Don't read every file in the module — sample exports, then drill in only
  where the user's task points.
- Don't propose changes in this skill. This is read-only context-gathering.
