---
name: structural-test-author
description: Use this skill whenever the user wants to add a new architectural rule, prevent a recurring agent mistake, or codify a pattern from golden-principles.md. Generates a ts-morph-based TypeScript structural test plus the matching eslint-plugin-boundaries rule entry. Always prefer this over leaving rules in prose.
allowed-tools: Read, Edit, Write, Bash(npm test:*), Bash(pytest:*)
suggested-turns: 15
---

## Steps

1. **Phrase the rule.** Ask the user: "What invariant do you want enforced?
   Phrase it as: 'No code in layer X may import from layer Y' or 'Every
   <thing> must <do>'."
2. **Layer rules first.** If the rule is layer-based, edit `.harness/config.json`
   `domains[].layers` and the `eslint.config.js`
   config — DO NOT write a custom test for layer rules; the existing test
   already supports them via configuration.
3. **Structural rules.** If the rule is structural but not layer-based (e.g.
   "every controller must call validateAt"), open
   `.harness/runners/structural-test.ts`:
   - Use `Project` + `getSourceFiles()` + AST visitors — the canonical ts-morph pattern.
4. **Add a fixture test.** Create a file in `tests/structural/` that contains
   a deliberately-violating snippet, and verify the rule fails on it.
5. **Run against the whole repo.** If the rule fails on existing code, choose:
   - **(a)** fix the existing code, OR
   - **(b)** add the existing violations to `.harness/structural-baseline.json`
     so only **new** violations block. (PMD/baseline pattern.)
6. **Document.** Append the rule and its rationale (one paragraph traced to a
   specific past failure) to `.harness/docs/golden-principles.md`.
7. **Log the harness change.** Run `/propose-harness-improvement` to record
   this as a permanent harness improvement.

## Output contract

```
### Rule added: <one-line description>
### Files changed: <list>
### New violations on existing code: <count> — baselined: yes/no
### golden-principles.md entry: §<n>
```

## Anti-patterns

- Don't write a rule whose enforcement is also LLM-based — that just recurses.
- Don't write a rule that requires runtime information to evaluate (e.g.
  "this function must not take more than 100ms"). Those go in evals or
  observability, not structural tests.
