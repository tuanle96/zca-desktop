# ADR 0001 — Adopt agent-harness-kit

- **Status:** accepted
- **Date:** 2026-06-03
- **Deciders:** project owner

## Context

This is a single-developer project that uses Claude Code for the bulk of
implementation work. Agent-driven development without a harness produces
predictable failure modes:

- duplicated helpers across modules
- backward layer dependencies
- silent test removal or skip
- doc drift from code reality
- unbounded retries and missing timeouts

Hand-engineering each preventive against these failures is achievable but
slow and easy to forget. A shared starter kit codifies the patterns that
OpenAI, Stripe, Anthropic, and Mitchell Hashimoto have publicly demonstrated
work.

## Decision

Adopt `agent-harness-kit v0.20.0` as the harness layer. Specifically:

- Use the layer order `types → config → repo → service → runtime → ui` and enforce it via the structural
  test bundled with the kit.
- Run the PostToolUse + Stop hooks shipped by the kit unmodified.
- Use the 30 starter skills and 9 reviewer subagents as the baseline; add or
  remove via subsequent ADRs.
- Run `/garbage-collection` weekly.

## Consequences

Positive

- Time-to-mistake-fix drops to ~30 seconds (PostToolUse hook).
- The `.harness/feature_list.json` + `PROGRESS.md` pair gives every session a clean
  starting context, regardless of conversation length.

Negative

- The layer order is opinionated. Some valid architectures (hexagonal,
  vertical-slice) require an ADR override.
- The kit upgrades introduce sidecar files under `.harness/upgrades/` that
  must be diffed manually for user-modified files.

## Alternatives considered

- **Roll our own.** Rejected: too slow, and the literature converges on the
  same patterns.
- **Use Claudify (1700 skills, 9 subagents).** Rejected: the over-engineered
  antipattern this kit explicitly avoids.
- **No harness.** Rejected: see Context.
