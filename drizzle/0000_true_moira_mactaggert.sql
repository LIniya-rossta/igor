CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pending_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`telegram_file_id` text NOT NULL,
	`file_unique_id` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text,
	`file_size` integer NOT NULL,
	`message_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_uploads_expires_at_idx` ON `pending_uploads` (`expires_at`);--> statement-breakpoint
CREATE TABLE `price_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`original_name` text NOT NULL,
	`file_size` integer NOT NULL,
	`uploaded_at` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`telegram_file_unique_id` text NOT NULL,
	`is_current` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_versions_object_key_unique` ON `price_versions` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `price_versions_telegram_file_unique_id_unique` ON `price_versions` (`telegram_file_unique_id`);--> statement-breakpoint
CREATE INDEX `price_versions_is_current_idx` ON `price_versions` (`is_current`);--> statement-breakpoint
CREATE INDEX `price_versions_uploaded_at_idx` ON `price_versions` (`uploaded_at`);