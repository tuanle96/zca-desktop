# Story Packet Template

Use for normal and high-risk features after `/feature-intake`. The story
should point at a task contract and its evidence bundle so implementation,
permissions, review, and done-proof stay connected.

Required sections:
- Description: what and why
- Acceptance Criteria: concrete, testable outcomes
- Acceptance Verification: every task contract acceptance item must have a
  concrete `verification` object (`command`, `artifact`, or `manual`) and no
  placeholder values
- Test Expectations: unit/integration/manual proof
- Evidence Mapping: every acceptance criterion should map to a passing evidence
  check via `acceptanceId` before the feature can be marked done
- Agent Work Units: agent-sized vertical slices
- Dependencies: blockers, ADRs, reviewers, review decision artifact paths
- Task Permissions: allow/deny list in `.harness/task-contracts/<id>.json`,
  mandatory and non-wildcard for high-risk work
- Task Scope: `scope.allowedLayers` should list the source layers the agent is
  allowed to mutate for this story
- Review Contract: high-risk stories must set `requiresAdr: true`,
  `doneRequires` including `review`, and required reviewer decision artifacts
- Definition of Done: proof before status changes
