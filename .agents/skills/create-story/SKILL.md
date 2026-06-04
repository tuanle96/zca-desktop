---
name: create-story
description: Create a Story Packet for normal/high-risk features. Use after /feature-intake classifies work as normal or high-risk, or when the user asks to break a feature into acceptance criteria, test expectations, and agent-sized work units.
allowed-tools: Read, Write, Edit, Bash(node .kiro/skills/create-story/create-story.mjs:*)
suggested-turns: 8
---

# Create Story Packet

Turns feature intake output into a concrete `.harness/docs/stories/feature-N.md` Story Packet.

## Steps

1. Run the helper with a title and optional flags:

   ```bash
   node .agents/skills/create-story/create-story.mjs "Feature title" --classification=normal --hours=2
   ```

   If the repo has no obvious test command, pass concrete verification up front:

   ```bash
   node .agents/skills/create-story/create-story.mjs "Feature title" --verify-command="npm test -- feature-name"
   ```

   For high-risk work, declare the implementation layer scope up front:

   ```bash
   node .agents/skills/create-story/create-story.mjs "Feature title" --classification=high-risk --hours=4 --layers=service,runtime
   ```

2. Review the generated Story Packet and fill in missing acceptance criteria if needed.
3. Ensure normal/high-risk features have `storyPath`, `taskContractPath`, and
   `evidencePath` in `.harness/feature_list.json`.
4. Create or update `.harness/task-contracts/<feature-id>.json` so the story's
   acceptance criteria map to concrete `doneRequires` gates and an evidence
   bundle path.
   - Use `--verify-command` / `--regression-command` when the default test
     command is not specific enough.
   - Do not leave `TBD`, `TODO`, or `N/A` in task-contract verification fields.
5. Ensure the task contract has a concrete `permissions.allow`/`deny` policy.
   High-risk work must not use wildcard permissions.
6. Ensure high-risk task contracts declare `scope.allowedLayers`. The helper
   refuses high-risk stories without `--layers`; do not create high-risk work
   with broad, empty, or placeholder layer scope.
7. For high-risk work, create or link an ADR and assign a reviewer before implementation.

## Output contract

```markdown
### Story Packet: <feature-id>
### Path: .harness/docs/stories/<feature-id>.md
### Classification: normal|high-risk
### Task contract: .harness/task-contracts/<feature-id>.json
### Evidence bundle: .harness/evidence/<feature-id>.json
### Next step: approve story | add ADR | implement
```

## Anti-patterns

- Do not create Story Packets for tiny typo-level changes.
- Do not prescribe implementation details unless they are hard constraints.
- Do not mark a story approved until acceptance criteria and tests are concrete.
- Do not omit the task contract/evidence paths; they are the bridge between
  planning and done-proof.
- Do not bypass `scope.allowedLayers` for high-risk stories; it drives
  task-scoped edit permissions.
