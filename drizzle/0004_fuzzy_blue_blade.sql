CREATE TABLE `browser_upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`chat_id` text NOT NULL,
	`status` text NOT NULL,
	`object_key` text NOT NULL,
	`upload_id` text,
	`original_name` text,
	`file_size` integer,
	`part_size` integer NOT NULL,
	`operation_nonce` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`published_at` integer,
	CONSTRAINT "browser_upload_sessions_status_check" CHECK("browser_upload_sessions"."status" in ('issued', 'uploading', 'validating', 'published', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_upload_sessions_token_hash_unique` ON `browser_upload_sessions` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_upload_sessions_object_key_unique` ON `browser_upload_sessions` (`object_key`);--> statement-breakpoint
CREATE INDEX `browser_upload_sessions_expires_at_idx` ON `browser_upload_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `browser_upload_sessions_chat_status_idx` ON `browser_upload_sessions` (`chat_id`,`status`);--> statement-breakpoint
PRAGMA optimize;
