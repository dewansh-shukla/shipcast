CREATE TYPE "public"."death_cause" AS ENUM('ci_failed', 'merge_conflict', 'review_blocked', 'no_signal');--> statement-breakpoint
CREATE TYPE "public"."harness" AS ENUM('claude-code', 'codex', 'aider', 'opencode', 'grok', 'droid', 'amp', 'agy', 'crush', 'cursor', 'qwen', 'copilot', 'goose', 'auggie', 'continue', 'devin', 'cline', 'kimi', 'kiro', 'kilocode', 'vibe', 'pi', 'autohand', 'unknown');--> statement-breakpoint
CREATE TABLE "agent_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"harness" "harness" NOT NULL,
	"tasks" integer NOT NULL,
	"merges" integer NOT NULL,
	"recoveries" integer NOT NULL,
	"interventions" integer NOT NULL,
	"died" integer NOT NULL,
	"turns" integer NOT NULL,
	"median_minutes" double precision NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	CONSTRAINT "agent_stats_snapshot_harness_key" UNIQUE("snapshot_id","harness")
);
--> statement-breakpoint
CREATE TABLE "builders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"github_id" text,
	"avatar_url" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "builders_github_id_key" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"github_id" text,
	"avatar_url" text,
	"public_merges" integer DEFAULT 0 NOT NULL,
	"public_repos" integer DEFAULT 0 NOT NULL,
	"window_from" date NOT NULL,
	"window_to" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seeds_handle_window_key" UNIQUE("handle","window_from","window_to")
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"builder_id" uuid NOT NULL,
	"payload_version" integer NOT NULL,
	"ao_version" text NOT NULL,
	"collector_version" text NOT NULL,
	"window_from" date NOT NULL,
	"window_to" date NOT NULL,
	"tasks" integer NOT NULL,
	"merges" integer NOT NULL,
	"ci_recoveries" integer NOT NULL,
	"interventions" integer NOT NULL,
	"peak_parallelism" integer NOT NULL,
	"harnesses" integer NOT NULL,
	"turns" integer NOT NULL,
	"repos" integer NOT NULL,
	"top_repo_share" double precision NOT NULL,
	"outcomes" jsonb NOT NULL,
	"size_mix" jsonb NOT NULL,
	"graveyard" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshots_builder_window_key" UNIQUE("builder_id","window_from","window_to")
);
--> statement-breakpoint
ALTER TABLE "agent_stats" ADD CONSTRAINT "agent_stats_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "builders_handle_lower_idx" ON "builders" USING btree (lower("handle"));--> statement-breakpoint
CREATE INDEX "snapshots_window_idx" ON "snapshots" USING btree ("window_from","window_to");