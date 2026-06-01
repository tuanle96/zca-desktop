# Agent failures log

This is the running log of agent mistakes that triggered a harness
improvement. Each entry should answer: what happened, what we did to make
sure it never happens again, and where the prevention now lives.

The `/propose-harness-improvement` skill appends entries here automatically.

> "Anytime you find an agent makes a mistake, you take the time to engineer
> a solution such that the agent never makes that mistake again."
> — Mitchell Hashimoto, _My AI Adoption Journey_ (Feb 5, 2026)

## Format

```
### YYYY-MM-DD  <slug>
- **Symptom:** <what went wrong>
- **Classification:** (a) missing context | (b) missing rule | (c) missing tool/skill | (d) wrong layer | (e) wrong instruction in prompt
- **Fix applied:** <what we did>
- **Fix lives in:** path/or/file
```

## Entries

_(empty — this file fills up over time as `/propose-harness-improvement` is invoked.)_
