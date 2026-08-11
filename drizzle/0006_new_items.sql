CREATE TABLE `price_new_items` (
	`price_version_id` text NOT NULL,
	`position` integer NOT NULL,
	`product_name` text NOT NULL,
	PRIMARY KEY(`price_version_id`, `position`)
);
--> statement-breakpoint
CREATE INDEX `price_new_items_version_idx` ON `price_new_items` (`price_version_id`);
