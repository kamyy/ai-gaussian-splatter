---
name: db-migration
description: Generate, review, and apply a Drizzle migration after changing web/lib/server/db/schema.ts. Use whenever a table, column, index, constraint, or pgEnum is added, altered, or removed — including when a schema edit is only part of a larger change.
---

# Drizzle migration

A schema edit changes nothing on disk by itself. `web/lib/server/db/schema.ts` is ordinary TypeScript, so the types — and `tsc` — update the moment you save, while the database stays as it was. That gap is the whole reason this procedure exists: nothing fails until a query hits a column Postgres doesn't have.

All commands run from `web/`.

## Steps

**1. Edit `web/lib/server/db/schema.ts`.**

Every column states its database name explicitly (`uuid("user_id")`). Do not add drizzle's `casing` option to fix a name. It would have to be set in both `web/drizzle.config.ts` and the runtime `drizzle()` call, and setting one without the other produces a schema and a query layer that disagree silently.

Enum values live in `web/lib/types.ts` and are imported here, so the TypeScript union and the Postgres labels stay one list. Add values there, not inline.

**2. Generate.**

```bash
pnpm db:generate
```

This diffs `web/lib/server/db/schema.ts` against the checked-in snapshot in `web/drizzle/meta/` and writes a new `NNNN_name.sql` plus an updated snapshot. It is a no-op when they already match.

**A table or column rename can't be generated from a non-interactive shell.** drizzle-kit asks whether the new name was created or renamed from the old one. Without a TTY it prints `Error: Interactive prompts require a TTY terminal`, writes nothing, and still exits 0, so read the output rather than trusting the exit code. On that error, stop and ask the user to run `pnpm db:generate` from `web/` in their own terminal and answer "renamed".

**3. Read the emitted SQL. Do not skip this.**

```bash
cat drizzle/<newest>.sql
```

This is the only step with no automated backstop. CI can tell that a migration exists, not that it does the right thing. Stop and confirm with the user before applying if you see:

- `DROP TABLE` or `DROP COLUMN` — data loss.
- A **rename emitted as drop-then-add**, which means the step 2 prompt was answered "created". It silently discards every existing value. Regenerate and answer "renamed" instead.
- `NOT NULL` added to an existing column with no `DEFAULT` — fails outright on a table that already has rows.
- A removed or renamed enum value. drizzle-kit never emits `ALTER TYPE … RENAME VALUE`. For either change it converts the column to `text`, drops and recreates the type, then converts back, which fails if any row still holds a label the new type lacks. For a pure rename, replace that SQL by hand with `ALTER TYPE … RENAME VALUE`.
- Anything that breaks the expand/contract discipline in [Schema & migrations (Drizzle)](../../../AGENTS.md#91-schema--migrations-drizzle). The `deploy` job applies migrations before rolling the service forward, and a rollback of the service doesn't undo one already applied.

Never hand-edit `web/drizzle/meta/*.json`. They are `generate`'s record of the last known schema; editing them makes the next diff wrong.

**4. Apply locally.**

```bash
pnpm db:migrate
```

Needs the local Postgres running (`scripts/dev/db-up.sh`) and the `DATABASE_*` variables from `web/.env`. See [Web (frontend + REST API)](../../../RUNBOOK.md#12-web-frontend--rest-api) if it isn't up.

**5. Verify.**

```bash
(cd .. && pnpm run web:check)
pnpm test
```

`web:check` is a repo-root script, the one exception to "all commands run from `web/`" above. It's the check that matters for a schema edit. The `worker` and `infra` checks have nothing to do with `web/lib/server/db/schema.ts`.

`TEST_DATABASE_URL` comes from `web/.env`. `pnpm test` fails if `splat-pg` is down (`scripts/dev/db-up.sh`) or that line is missing, so a pass means the new schema was tested. `ai_gaussian_splatter_test` is a separate database on the same instance, not the dev one. Vitest applies `web/drizzle/` to it before those tests. See [RUNBOOK.md § "Full test suite"](../../../RUNBOOK.md#110-full-test-suite).

**6. Commit `web/lib/server/db/schema.ts` and the whole `web/drizzle/` tree together**, `meta/` snapshots included. CI re-runs `db:generate` and fails if it writes anything or prints an error, so a schema change committed without its migration blocks the PR. `web/drizzle/` is excluded from Biome, so the generated SQL is not reformatted.

## Applying to a deployed database

The only supported production apply is the `deploy` job (`.github/workflows/deploy.yml`), which runs `web/Dockerfile`'s `migrator` image as a one-off ECS task before rolling the service forward. A production schema change applies when `DEPLOY_ENABLED` is `true` and the commit reaches `main` ([Going live](../../../RUNBOOK.md#26-going-live)). The image deliberately does not migrate on boot, since up to three tasks would race with nothing serialising them. Nothing outside the VPC can connect to RDS directly: it sits in an isolated subnet with no NAT gateway and no bastion. Launching the migrator task by hand with `aws ecs run-task` is possible but not a supported path, so don't. A bad migration is fixed like any other bug, with a corrective migration through a normal PR. See [RUNBOOK.md § "Fixing a bad migration"](../../../RUNBOOK.md#31-fixing-a-bad-migration).
