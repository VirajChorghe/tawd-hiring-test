-- Make activity_log append-only, enforced by the database rather than by the
-- application, so no code path in TAWD can rewrite history.
--
-- A trigger fires for everyone, including the table owner and including an
-- admin using the interface. What it cannot stop is a PostgreSQL superuser at
-- the console disabling the trigger: no database setting can. That is why
-- each entry also carries a fingerprint chaining it to the previous one, so
-- tampering that bypasses this trigger is still detectable.
--
-- Written by hand: drizzle-kit generates tables, not triggers.

CREATE OR REPLACE FUNCTION activity_log_reject_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'activity_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS activity_log_no_update ON activity_log;
--> statement-breakpoint
CREATE TRIGGER activity_log_no_update
  BEFORE UPDATE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_reject_change();
--> statement-breakpoint

DROP TRIGGER IF EXISTS activity_log_no_delete ON activity_log;
--> statement-breakpoint
CREATE TRIGGER activity_log_no_delete
  BEFORE DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_reject_change();
--> statement-breakpoint

DROP TRIGGER IF EXISTS activity_log_no_truncate ON activity_log;
--> statement-breakpoint
CREATE TRIGGER activity_log_no_truncate
  BEFORE TRUNCATE ON activity_log
  FOR EACH STATEMENT EXECUTE FUNCTION activity_log_reject_change();
--> statement-breakpoint

-- Second layer, independent of the triggers. The role the application
-- connects as keeps INSERT and SELECT and loses everything else.
REVOKE UPDATE, DELETE, TRUNCATE ON activity_log FROM CURRENT_USER;
