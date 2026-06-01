# Story: [Feature Title]

**ID:** feature-N  
**Classification:** normal  
**Estimated Hours:** N  
**Status:** draft  
**Created:** YYYY-MM-DD  
**Assigned Reviewer:** (if high-risk)
**Task Contract:** `.harness/task-contracts/feature-N.json`
**Evidence Bundle:** `.harness/evidence/feature-N.json`
**Task Permissions:** explicit in task contract before source/config mutation

---

## Description

[Clear, concise description of what needs to be built. Focus on the "what" and "why", not the "how".]

---

## Acceptance Criteria

- [ ] **AC1:** [Specific, testable criterion]
- [ ] **AC2:** [Specific, testable criterion]
- [ ] **AC3:** [Specific, testable criterion]

---

## Test Expectations

### Unit Tests
- [ ] [Test case 1]
- [ ] [Test case 2]

### Integration Tests
- [ ] [Test case 1]
- [ ] [Test case 2]

### Manual Verification
- [ ] [Verification step 1]
- [ ] [Verification step 2]

---

## Technical Notes

[Optional: Any technical constraints, dependencies, or implementation hints. Keep this section minimal — the story should not prescribe the solution.]

---

## Dependencies

- **Blocks:** (list of feature IDs this blocks)
- **Blocked by:** (list of feature IDs blocking this)
- **Related ADRs:** (if high-risk)

---

## Definition of Done

- [ ] All acceptance criteria met
- [ ] Every acceptance criterion has concrete verification in the task contract
- [ ] Evidence checks reference each acceptance criterion with `acceptanceId`
- [ ] All tests passing
- [ ] Evidence bundle written and valid against `.harness/schemas/evidence-bundle.schema.json`
- [ ] Required reviewer decisions saved under `.harness/reviews/<task-id>/` and valid against `.harness/schemas/review-decision.schema.json`
- [ ] Task contract has explicit `permissions.allow`; high-risk work has no wildcard tool access
- [ ] Documentation updated
- [ ] No new structural test violations
- [ ] Feature added to `.harness/feature_list.json` with `passes: true` only after proof

---

## Notes

[Any additional context, edge cases, or open questions.]
