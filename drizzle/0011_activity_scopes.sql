DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'activity_scope_status'
  ) THEN
    CREATE TYPE "activity_scope_status" AS ENUM ('active', 'revoked');
  END IF;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "activity_scopes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "status" "activity_scope_status" DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_active_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "activity_scopes_owner_unique" ON "activity_scopes" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_scopes_last_active_idx" ON "activity_scopes" USING btree ("last_active_at");--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activity_scopes_owner_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "activity_scopes"
      ADD CONSTRAINT "activity_scopes_owner_user_id_users_id_fk"
      FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "activity_scope_id" uuid;--> statement-breakpoint

INSERT INTO "activity_scopes" ("owner_user_id")
SELECT "id" FROM "users"
ON CONFLICT ("owner_user_id") DO NOTHING;--> statement-breakpoint

UPDATE "activity_logs" AS logs
SET "activity_scope_id" = scopes."id"
FROM "activity_scopes" AS scopes
WHERE scopes."owner_user_id" = logs."user_id"
  AND logs."activity_scope_id" IS NULL;--> statement-breakpoint

ALTER TABLE "activity_logs" ALTER COLUMN "activity_scope_id" SET NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activity_logs_activity_scope_id_activity_scopes_id_fk'
  ) THEN
    ALTER TABLE "activity_logs"
      ADD CONSTRAINT "activity_logs_activity_scope_id_activity_scopes_id_fk"
      FOREIGN KEY ("activity_scope_id") REFERENCES "public"."activity_scopes"("id") ON DELETE cascade;
  END IF;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "activity_logs_scope_time_idx" ON "activity_logs" USING btree ("activity_scope_id", "created_at");
