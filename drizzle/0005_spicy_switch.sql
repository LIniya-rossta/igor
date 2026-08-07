ALTER TABLE `browser_upload_sessions` ADD `source_pending_id` text;--> statement-breakpoint
ALTER TABLE `browser_upload_sessions` ADD `source_file_unique_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `browser_upload_sessions_source_pending_idx` ON `browser_upload_sessions` (`source_pending_id`);
