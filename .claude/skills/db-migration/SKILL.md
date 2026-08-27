---
name: db-migration
description: Generate, review, and apply a Drizzle migration after changing web/lib/server/db/schema.ts. Use whenever a table, column, index, constraint, or pgEnum is added, altered, or removed — including when a schema edit is only part of a larger change.
---

# Drizzle migration

A schema edit changes nothing on disk by itself. `schema.ts` is ordinary TypeScript, so the types — and `tsc` — update the moment you save, while the database stays as it was. That gap is the whole reason this procedure exists: nothing fails until a query hits a column Postgres doesn't have.

All commands run from `web/`.

## Steps

**1. Edit `web/lib/server/db/schema.ts`.**

Every column states its database name explicitly (`uuid("user_id")`). Do not add drizzle's `casing` option to fix a name — it would have to be set in both `drizzle.config.ts` and the runtime `drizzle()` call, and setting one without the other produces a schema and a query layer that disagree silently.

Enum values live in `web/lib/types.ts` and are imported here, so the TypeScript union and the Postgres labels stay one list. Add values there, not inline.

**2. Generate.**

```bash
pnpm db:generate
```

This diffs `schema.ts` against the checked-in snapshot in `web/drizzle/meta/` and writes a new `NNNN_name.sql` plus an updated snapshot. It is a no-op when they already match.

**3. Read the emitted SQL. Do not skip this.**

```bash
cat web/drizzle/<newest>.sql
```

This is the only step with no automated backstop. CI can tell that a migration exists, not that it does the right thing. Stop and confirm with the user before applying if you see:

- `DROP TABLE` or `DROP COLUMN` — data loss.
- A **rename emitted as drop-then-add**. drizzle-kit cannot see intent, so renaming a column usually appears as a new column plus a dropped one, silently discarding every existing value. It needs rewriting by hand as `ALTER TABLE … RENAME COLUMN`.
- `NOT NULL` added to an existing column with no `DEFAULT` — fails outright on a table that already has rows.
- A dropped or renamed enum value, which Postgres will not do while any row still uses it.
- Anything that breaks the expand/contract discipline `AGENTS.md` requires for every migration (CI applies migrations before rolling the service forward, and a rollback of the service doesn't undo one already applied).

Never hand-edit `web/drizzle/meta/*.json`. They are `generate`'s record of the last known schema; editing them makes the next diff wrong.

**4. Apply locally.**

```bash
pnpm db:migrate
```

Needs the local Postgres running (`podman ps` should show `splat-pg`) and the `DATABASE_*` variables from `web/.env`. See `RUNBOOK.md` if it isn't up.

**5. Verify.**

```bash
(cd .. && pnpm run web:check)
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_gaussian_splatter_test pnpm test
```

`web:check` is a repo-root script (the one exception to "all commands run from `web/`" above) — it's the piece that actually matters for a schema edit; `worker`/`infra`'s checks have nothing to do with `schema.ts`.

The database-backed tests skip silently without `TEST_DATABASE_URL`, so a run that "passes" without it has not exercised the new schema at all. `ai_gaussian_splatter_test` is a separate database on the same `splat-pg` instance, not the dev one — see [RUNBOOK.md § "Full test suite"](../../../RUNBOOK.md#full-test-suite) for the one-time `createdb`.

**6. Commit `schema.ts` and the whole `web/drizzle/` tree together**, `meta/` snapshots included. CI re-runs `db:generate` and fails if it produces anything, so a schema change committed without its migration blocks the PR. `web/drizzle/` is excluded from Biome, so the generated SQL is not reformatted.

## Applying to a deployed database

CI applies this automatically on every push to `main` (`ci.yml`'s `deploy` job runs `web/Dockerfile`'s `migrator` image as a one-off ECS task before rolling the service forward) — not covered here. The image deliberately does not migrate on boot, since up to three tasks would race with nothing serialising them. There is no manual, out-of-band way to apply one instead: RDS sits in an isolated subnet with no NAT gateway and no bastion. A bad migration is fixed like any other bug, with a corrective migration through a normal PR — see [RUNBOOK.md § "Fixing a bad migration"](../../../RUNBOOK.md#fixing-a-bad-migration).
