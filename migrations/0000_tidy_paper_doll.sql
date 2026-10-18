CREATE TABLE `clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`walker_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`phone` text,
	`address` text,
	`notes` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `clients_walker_created` ON `clients` (`walker_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `dogs` (
	`dog_id` text PRIMARY KEY NOT NULL,
	`walker_id` text NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`breed` text,
	`date_of_birth` text,
	`notes` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`client_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dogs_walker_client` ON `dogs` (`walker_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`event_id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`subject` text NOT NULL,
	`envelope` text NOT NULL,
	`created_at` text NOT NULL,
	`published_at` text,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_unpublished` ON `outbox` (`published_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `test_flags` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `walk_cancelled_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`event_source` text NOT NULL,
	`event_time` text NOT NULL,
	`walk_id` text NOT NULL,
	`walker_id` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`cancelled_at` text NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `walk_completed_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`event_source` text NOT NULL,
	`event_time` text NOT NULL,
	`walk_id` text NOT NULL,
	`walker_id` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`started_at` text,
	`completed_at` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`dog_ids` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `walk_scheduled_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`event_source` text NOT NULL,
	`event_time` text NOT NULL,
	`walk_id` text NOT NULL,
	`walker_id` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`dog_ids` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `walks` (
	`walk_id` text PRIMARY KEY NOT NULL,
	`walker_id` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`dog_ids` text NOT NULL,
	`status` text NOT NULL,
	`notes` text,
	`started_at` text,
	`completed_at` text,
	`cancelled_at` text,
	`cancellation_reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `walks_walker_scheduled` ON `walks` (`walker_id`,`scheduled_at`);