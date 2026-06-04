# Story: Cloud device restore consent

**ID:** feature-1
**Classification:** high-risk
**Estimated Hours:** 3.1
**Status:** done
**Created:** 2026-06-04
**Assigned Reviewer:** architecture-reviewer
**Task Contract:** `.harness/task-contracts/feature-1.json`
**Evidence Bundle:** `.harness/evidence/feature-1.json`
**Review Decision:** `.harness/reviews/feature-1/architecture-reviewer.json`
**Allowed Layers:** command

---

## Description

Avoid surprising macOS Keychain prompts when Tauri starts in cloud-only mode. The desktop app should remember only a non-secret marker that this device has been linked before, then wait for the user to explicitly continue before reading the keychain-backed SaaS device token. Copy must distinguish cloud device connection from local Zalo credential/session restore.

---

## Acceptance Criteria

- [x] **AC1:** Startup does not read the cloud device token from Keychain automatically; the loading copy says cloud device state is being checked.
- [x] **AC2:** The login gate shows a continue action when a non-secret linked-device marker exists, and only that action reads the keychain-backed device token.
- [x] **AC3:** Fresh magic-link verification still links the device, stores the SaaS token in Keychain through the existing command boundary, sets the non-secret marker, and connects to cloud.

---

## Test Expectations

### Unit Tests
- [x] Svelte type-check covers the changed session store and QR login gate.

### Integration Tests
- [x] Production frontend build succeeds.
- [x] Harness structural/readiness gates remain green for this slice.

### Manual Verification
- [x] Source evidence confirms `session.restore()` no longer calls `loadCloudDeviceSession`.
- [x] Source evidence confirms `continueLinkedCloudDevice()` is the linked-device path that calls the explicit restore action.

---

## Agent Work Units

- [x] Inspect current implementation and affected files.
- [x] Implement the smallest vertical slice.
- [x] Run structural checks and targeted tests.
- [x] Update feature tracking with proof.

---

## Dependencies

- **Blocks:** none
- **Blocked by:** none
- **Related ADRs:** `.harness/docs/adr/0007-cloud-device-restore-consent.md`

---

## Definition of Done

- [x] All acceptance criteria met
- [x] Every acceptance criterion has concrete verification in the task contract
- [x] Evidence checks reference each acceptance criterion with `acceptanceId`
- [x] Task contract has explicit `permissions.allow` before source/config mutation
- [x] Tests or manual proof recorded
- [x] Evidence bundle written and valid against `.harness/schemas/evidence-bundle.schema.json`
- [x] Required reviewer decisions match `.harness/schemas/review-decision.schema.json`
- [x] No new structural test violations
- [x] Feature list entry links this story
- [x] ADR accepted, reviewer completed, and no wildcard tool access is granted
