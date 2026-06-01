# Tech debt tracker

A flat append-only log of known compromises. Each entry has a date, a
location, a description, and a payoff condition.

> "Technical debt is a high-interest loan best paid down in continuous
> small increments." — OpenAI Codex harness team

The `/garbage-collection` skill scans this file every Friday and proposes
the top-3 highest-leverage entries to address.

## Format

```
### YYYY-MM-DD  <slug>
- Location: path/or/area
- Why it's debt: <one paragraph>
- Cost: <effort to fix>
- Payoff condition: <what should trigger the fix>
- Status: open | in-progress | closed
```

## Entries

### 2026-01-01  example-entry
- Location: src/example/repo/legacy.ts
- Why it's debt: hand-rolled fetch wrapper instead of the shared client
- Cost: 1 hour
- Payoff condition: when we add the next external call
- Status: open
