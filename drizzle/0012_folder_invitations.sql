-- Create invitation status enum
CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'rejected');

-- Create folder invitations table
CREATE TABLE IF NOT EXISTS "folder_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"folder_id" uuid NOT NULL,
	"invited_user_id" uuid NOT NULL,
	"invited_by" uuid NOT NULL,
	"role" "folder_member_role" DEFAULT 'view' NOT NULL,
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);

-- Add foreign keys
ALTER TABLE "folder_invitations" ADD CONSTRAINT "folder_invitations_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "folder_invitations" ADD CONSTRAINT "folder_invitations_invited_user_id_users_id_fk" FOREIGN KEY ("invited_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "folder_invitations" ADD CONSTRAINT "folder_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

-- Create indexes
CREATE UNIQUE INDEX IF NOT EXISTS "folder_invitations_unique" ON "folder_invitations" USING btree ("folder_id","invited_user_id");
CREATE INDEX IF NOT EXISTS "folder_invitations_user_idx" ON "folder_invitations" USING btree ("invited_user_id");
CREATE INDEX IF NOT EXISTS "folder_invitations_status_idx" ON "folder_invitations" USING btree ("invited_user_id","status");
