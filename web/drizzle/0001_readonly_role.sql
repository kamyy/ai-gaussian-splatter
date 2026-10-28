DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'splatter_readonly') THEN
    CREATE ROLE splatter_readonly WITH LOGIN;
  END IF;
END
$$;
--> statement-breakpoint
-- rds_iam is RDS's own role for logging in with an IAM token. Local dev and CI Postgres have no such role.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'rds_iam') THEN
    GRANT rds_iam TO splatter_readonly;
  END IF;
END
$$;
--> statement-breakpoint
-- A client can switch this off with SET. The SELECT-only grants below are what keep the role read-only.
ALTER ROLE splatter_readonly SET default_transaction_read_only = on;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO splatter_readonly;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO splatter_readonly;
--> statement-breakpoint
-- Covers tables created by the role that runs the migrations.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO splatter_readonly;
