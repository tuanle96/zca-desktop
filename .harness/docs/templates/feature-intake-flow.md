# Feature Intake Flow

**Purpose:** Prevent "wrong direction" sessions by classifying work before implementation.

---

## Flow Diagram

```
User Request: "Add feature X"
         ↓
    /feature-intake
         ↓
    Classify: tiny | normal | high-risk
         ↓
    ┌────┴────┬─────────────┬──────────────┐
    ↓         ↓             ↓              ↓
  TINY     NORMAL      HIGH-RISK      HIGH-RISK
 (< 30m)   (< 4h)      (> 4h)      (breaking/arch)
    ↓         ↓             ↓              ↓
    │    /create-story  /add-adr      /add-adr
    │         ↓             ↓              ↓
    │         │        /create-story  /create-story
    │         ↓             ↓              ↓
    └─────→ Add to feature_list.json ←────┘
              ↓
         /add-feature
              ↓
         Implementation
              ↓
         Evidence bundle
              ↓
         passes: true
```

---

## Routing Rules

### Tiny (< 30 minutes)
**Criteria:**
- Single file edit
- < 50 lines of code
- No new dependencies
- No breaking changes
- Clear, well-understood pattern

**Flow:**
1. `/feature-intake` → classify as "tiny"
2. Add to `.harness/feature_list.json` with `classification: "tiny"`
3. Create `.harness/task-contracts/<feature-id>.json` with concrete verification
4. `/add-feature` → implement directly
5. Generate evidence bundle
6. Mark `passes: true`

**No ceremony required** - but still must go through intake.

---

### Normal (< 4 hours)
**Criteria:**
- Multi-file changes
- 50-500 lines of code
- No breaking changes
- No security implications
- Standard patterns

**Flow:**
1. `/feature-intake` → classify as "normal"
2. `/create-story` → create story packet in `.harness/docs/stories/`
3. Add to `.harness/feature_list.json` with `classification: "normal"` and story link
4. Create `.harness/task-contracts/<feature-id>.json` with acceptance criteria
5. Wait for story approval (if required)
6. `/add-feature` → implement
7. Generate evidence bundle
8. Mark `passes: true`

**Story packet required** - documents acceptance criteria and test expectations.

---

### High-risk (> 4 hours OR breaking/architectural)
**Criteria:**
- > 4 hours estimated
- Breaking API changes
- Security/auth changes
- Database schema changes
- New dependencies
- Cross-cutting concerns
- Performance-critical paths
- Affects multiple layers/domains

**Flow:**
1. `/feature-intake` → classify as "high-risk"
2. **If architectural:** `/add-adr` → create ADR in `.harness/docs/adr/`
3. `/create-story` → create story packet
4. Add to `.harness/feature_list.json` with `classification: "high-risk"`, ADR link, reviewer assignment
5. Create `.harness/task-contracts/<feature-id>.json` with:
   - `requiresAdr: true` (if architectural)
   - `requiredReviewers: ["security-reviewer"]` (or appropriate reviewer)
   - `doneRequires: ["structural", "tests", "review", "evidence-bundle"]`
   - Concrete acceptance verification
6. Wait for ADR + story approval
7. `/add-feature` → implement
8. Invoke assigned reviewer (e.g., `/review-this-pr --reviewer=security-reviewer`)
9. Generate evidence bundle with reviewer decision
10. Mark `passes: true` only after reviewer approval

**ADR + Story + Review required** - safety net for risky changes.

---

## ADR Triggers (When to create ADR)

See complete list in `/feature-intake` SKILL.md. Quick reference:

**Structural:**
- New layer or domain
- New provider or dependency
- Cross-layer communication change

**API:**
- Breaking API change
- New public API
- Protocol change

**Security:**
- Auth/permissions boundary change
- New permission model
- Secrets management change

**Data:**
- Data model migration
- New data store
- Data retention policy change

**Performance:**
- Performance-critical path change
- Scaling strategy change
- Resource limits change

**Operational:**
- Deployment strategy change
- Monitoring/observability change
- Disaster recovery change

**When in doubt:** If it affects multiple teams, has long-term implications, or sets a precedent → create ADR.

---

## Anti-patterns

❌ **Don't skip `/feature-intake`**
- Even for "quick fixes" - classification prevents wrong direction

❌ **Don't over-classify tiny as normal**
- Ceremony has a cost - use it when needed

❌ **Don't under-classify breaking changes as normal**
- Missing ADR creates tech debt

❌ **Don't implement high-risk without reviewer**
- That's the safety net

❌ **Don't bypass intake "because I know what to do"**
- The point is to force a pause and verify assumptions

---

## Success Metrics

**Good intake:**
- Classification matches actual complexity
- ADR created for architectural decisions
- Reviewer assigned for high-risk work
- Evidence bundle proves completion

**Bad intake:**
- "Quick fix" becomes 3-day refactor
- Breaking change merged without ADR
- Security issue missed because no reviewer
- "Done" claimed without evidence

---

**Remember:** "Prompt là lời khuyên, harness mới là luật."

Intake flow is not optional - it's the first gate that prevents costly mistakes.
