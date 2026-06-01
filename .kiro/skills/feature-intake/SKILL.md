---
name: feature-intake
description: Use this skill whenever the user asks to "add a feature", "implement X", "build Y", or before invoking /add-feature. Classifies the request into tiny/normal/high-risk based on estimated complexity and blast radius, then routes to the appropriate workflow — straight to code (tiny), story packet (normal), or ADR + story packet + mandatory review (high-risk). Prevents "wrong direction" sessions by forcing a pause before implementation. Pattern from harness-experimental and OpenAI's "implementation prompts do not go straight to code" discipline.
allowed-tools: Read, Write, Edit, Bash(node .kiro/skills/feature-intake/scripts/classify.mjs:*)
suggested-turns: 6
---

## When to use

- User asks to implement a feature, add functionality, or build something new
- Before running `/add-feature` on a new item
- When you're about to start coding and haven't assessed risk yet
- User mentions "add", "implement", "build", "create" followed by a feature description

## Steps

1. **Run the classifier.** Pass the feature description to the deterministic classifier:

   ```bash
   node .kiro/skills/feature-intake/scripts/classify.mjs "feature description here"
   ```

   Returns JSON: `{ classification: "tiny"|"normal"|"high-risk", reasoning: "...", estimatedHours: N, signals: [...] }`

2. **Review classification with user.** Present the classification and reasoning. Ask if they agree or want to override.

3. **Route based on classification:**

   **Tiny (< 30 min):**
   - Add to `.harness/feature_list.json` with `classification: "tiny"`
   - Create `.harness/task-contracts/<feature-id>.json` with at least one
     acceptance item whose `verification` is concrete (`command`, `artifact`,
     or `manual`) and `doneRequires: ["structural", "evidence-bundle"]`
   - Do not write `TBD`, `TODO`, `N/A`, `replace me`, or `fill me` in any
     task-contract verification field
   - Proceed directly to implementation
   - No ceremony required

   **Normal (< 4h):**
   - Create story packet in `.harness/docs/stories/` using the template; prefer
     `/create-story --verify-command="<repo test command>"` when a concrete
     test command is known
   - Add to `.harness/feature_list.json` with `classification: "normal"` and link to story
   - Create `.harness/task-contracts/<feature-id>.json` with acceptance items,
     concrete `verification` objects, required gates, and an evidence path
   - Story must include: description, acceptance criteria, test expectations,
     task contract path, and evidence bundle path
   - Proceed to implementation after story is approved

   **High-risk (> 4h or breaking change):**
   - Create ADR in `.harness/docs/adr/` (use `/add-adr` skill)
   - Create story packet in `.harness/docs/stories/`
   - Add to `.harness/feature_list.json` with `classification: "high-risk"`
   - Create `.harness/task-contracts/<feature-id>.json` with
     `requiresAdr: true`, `doneRequires` containing `review` and
     `evidence-bundle`, `requiredReviewers`, concrete acceptance
     `verification`, `scope.allowedLayers`, non-wildcard `permissions.allow`,
     and an evidence path
   - Assign appropriate reviewer (security-reviewer for auth/permissions, architecture-reviewer for structural changes, etc.)
   - Wait for ADR + story approval before implementation

4. **Update .harness/feature_list.json and task contract.** Add the feature
   with proper classification metadata and point it at the contract/evidence
   paths:

   ```json
   {
     "id": "feature-N",
     "title": "...",
     "classification": "tiny|normal|high-risk",
     "estimatedHours": N,
     "storyPath": ".harness/docs/stories/feature-N.md",
     "adrPath": ".harness/docs/adr/NNNN-title.md",
     "taskContractPath": ".harness/task-contracts/feature-N.json",
     "evidencePath": ".harness/evidence/feature-N.json",
     "assignedReviewer": "security-reviewer",
     "status": "intake-complete"
   }
   ```

   The task contract must satisfy
   `.harness/schemas/task-contract.schema.json`. The implementation cannot
   mark `passes: true` until `.harness/evidence/feature-N.json` satisfies
   `.harness/schemas/evidence-bundle.schema.json`.
   If the repo has no runnable test command yet, use a concrete `manual`
   verification string that names the artifact the evidence bundle must later
   include; do not use placeholder text.

5. **Proceed to next phase.** For tiny: implement. For normal/high-risk: wait for approval.

## Output contract

```
### Feature Intake: <title>
### Classification: <tiny|normal|high-risk>
### Estimated hours: <N>
### Reasoning: <why this classification>
### Next steps:
- [ ] <action 1>
- [ ] <action 2>
```

## Anti-patterns

- Don't skip classification and go straight to code — that's the failure mode this skill prevents
- Don't over-classify tiny tasks as normal — ceremony has a cost
- Don't under-classify breaking changes as normal — missing ADR creates tech debt
- Don't implement high-risk features without reviewer assignment — that's the safety net

## Classification signals

**Tiny indicators:**
- Single file edit
- < 50 lines of code
- No new dependencies
- No breaking changes
- No security implications
- Clear, well-understood pattern

**High-risk indicators:**
- Breaking API changes
- Authentication/authorization changes
- Database schema changes
- New external dependencies
- Cross-cutting concerns (logging, error handling)
- Performance-critical paths
- > 4 hours estimated
- Affects multiple layers/domains
- Security-sensitive (auth, permissions, secrets, PII)

**Normal:** Everything else

## ADR Triggers (Explicit)

An ADR (Architecture Decision Record) is **required** when the feature involves:

### Structural Changes
- **New layer or domain** - Adding a new architectural layer (e.g., new service layer, new domain module)
- **New provider or dependency** - Introducing external dependencies, SDKs, or third-party services
- **Cross-layer communication change** - Modifying how layers interact (e.g., UI calling service directly instead of through controller)

### API & Interface Changes
- **Breaking API change** - Modifying public API contracts, removing endpoints, changing response formats
- **New public API** - Exposing new endpoints or interfaces to external consumers
- **Protocol change** - Switching communication protocols (REST → GraphQL, HTTP → WebSocket)

### Security & Auth
- **Security/auth boundary change** - Modifying authentication, authorization, or access control logic
- **New permission model** - Adding role-based access control, permission systems
- **Secrets management change** - Changing how secrets, keys, or credentials are stored/accessed

### Data & Storage
- **Data model migration** - Schema changes, adding/removing tables, changing data types
- **New data store** - Adding database, cache, message queue, or storage system
- **Data retention policy** - Changing how long data is kept, backup strategies

### Performance & Scale
- **Performance-critical path change** - Modifying hot paths, query optimization, caching strategies
- **Scaling strategy change** - Horizontal/vertical scaling decisions, load balancing changes
- **Resource limits change** - Memory, CPU, connection pool size modifications

### Operational
- **Deployment strategy change** - Blue-green, canary, rolling deployment modifications
- **Monitoring/observability change** - New metrics, logging strategies, alerting rules
- **Disaster recovery change** - Backup, restore, failover strategy modifications

### When in doubt
If the change:
- Affects multiple teams or services
- Has long-term architectural implications
- Requires coordination with other systems
- Could set a precedent for future work

→ **Create an ADR**

ADRs are lightweight (15-30 min to write) but prevent costly mistakes. Better to over-document than under-document architectural decisions.

