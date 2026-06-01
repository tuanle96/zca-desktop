# Feature Intake: [Feature Title]

**Classification:** [tiny|normal|high-risk]  
**Estimated Hours:** [N]  
**Date:** [YYYY-MM-DD]  
**Classifier Version:** 1.0

---

## Feature Description

[Clear description of what the user wants to build]

---

## Classification Reasoning

[Why this classification was chosen - include signals detected and scoring]

### Signals Detected
- [List of signals found in the description]

### Scores
- **High-Risk Score:** [N]
- **Tiny Score:** [N]
- **Complexity Multiplier:** [N]x

---

## Next Steps

### For Tiny Features (< 30 min)
- [ ] Add to `.harness/feature_list.json` with `classification: "tiny"`
- [ ] Create `.harness/task-contracts/<feature-id>.json` with concrete acceptance `verification`
- [ ] Proceed directly to implementation
- [ ] No ceremony required

### For Normal Features (< 4h)
- [ ] Create story packet in `.harness/docs/stories/` using story-template.md
- [ ] Add to `.harness/feature_list.json` with `classification: "normal"` and link to story
- [ ] Create `.harness/task-contracts/<feature-id>.json` with acceptance `verification`, `doneRequires`, and evidence path
- [ ] Story must include: description, acceptance criteria, test expectations
- [ ] Proceed to implementation after story is approved

### For High-Risk Features (> 4h or breaking change)
- [ ] Create ADR in `.harness/docs/adr/` (use `/add-adr` skill)
- [ ] Create story packet in `.harness/docs/stories/` using story-template.md
- [ ] Add to `.harness/feature_list.json` with `classification: "high-risk"`
- [ ] Create `.harness/task-contracts/<feature-id>.json` with concrete acceptance `verification`, `scope.allowedLayers`, non-wildcard `permissions.allow`, required reviewers, and evidence path
- [ ] Create `.harness/reviews/<feature-id>/` for structured reviewer decisions
- [ ] Assign appropriate reviewer:
  - `security-reviewer` for auth/permissions/secrets/PII
  - `architecture-reviewer` for structural changes
  - `performance-reviewer` for optimization work
  - `data-reviewer` for schema/migration changes
- [ ] Wait for ADR + story approval before implementation

---

## Risk Indicators

### High-Risk Signals Present
[List any high-risk signals detected, or "None"]

### Tiny Signals Present
[List any tiny signals detected, or "None"]

---

## Decision

**Approved by:** [Name or "Auto-classified"]  
**Date:** [YYYY-MM-DD]  
**Override:** [Yes/No - if classification was manually overridden]

---

## Notes

[Any additional context, concerns, or questions about the classification]
