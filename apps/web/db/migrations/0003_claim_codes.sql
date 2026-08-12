CREATE TYPE "public"."claim_status" AS ENUM('pending', 'approved', 'denied', 'consumed');--> statement-breakpoint
CREATE TABLE "claim_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_code" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"oauth_state" text,
	"handle_hint" text,
	"status" "claim_status" DEFAULT 'pending' NOT NULL,
	"builder_id" uuid,
	"handle" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	CONSTRAINT "claim_codes_user_code_key" UNIQUE("user_code"),
	CONSTRAINT "claim_codes_device_hash_key" UNIQUE("device_code_hash")
);
--> statement-breakpoint
ALTER TABLE "claim_codes" ADD CONSTRAINT "claim_codes_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_codes_oauth_state_idx" ON "claim_codes" USING btree ("oauth_state");--> statement-breakpoint
CREATE INDEX "claim_codes_expires_idx" ON "claim_codes" USING btree ("expires_at");