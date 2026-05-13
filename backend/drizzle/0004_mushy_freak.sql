ALTER TABLE `alert_configs` ADD `hysteresis_duration_seconds` int DEFAULT 30;--> statement-breakpoint
ALTER TABLE `alert_configs` ADD `alert_cooldown_seconds` int DEFAULT 300;