# Schema Policy

The durable harness artifacts use explicit compatibility rules so task
contracts, evidence bundles, review decisions, failure records, trace corpus
entries, policy packs, and related records remain readable across upgrades.

The machine-readable source of truth is `.harness/schema-policy.json`.

## Versioning

- `schemaVersion` on a record is the artifact format version, not the package
  version.
- Compatible changes may add optional fields or documentation-only constraints.
- Breaking changes include removing fields, renaming fields, making an optional
  field required, changing a field type, or rejecting records a released version
  accepted.
- Breaking schema changes require a major compatibility bump or a documented
  migration that preserves readability of existing records.

## Migration

- Breaking changes must include a migration plan and rollback note.
- Migrations must keep old task/evidence/review/failure records readable or
  produce migrated copies before removing legacy reader support.
- Migration code and evidence should live under `.harness/schema-migrations/`
  or another explicitly documented repo-local path.

## Deprecation

- Deprecations require at least 90 days and two minor releases of notice before
  removal.
- Removal requires a major compatibility change unless the deprecation was
  already announced and migration evidence exists.

## Changelog

Package releases that change durable schemas must include a
`Schema Compatibility` changelog section. Breaking changes must be labeled with
`Breaking schema change`, `Migration`, or `Deprecation`.

Run:

```bash
node .harness/scripts/check-stable-schemas.mjs --strict
```
