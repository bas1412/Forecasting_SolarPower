CREATE TABLE `alert_configs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`min_power_watts` decimal(10,2) DEFAULT '50',
	`max_power_watts` decimal(10,2) DEFAULT '500',
	`max_cloud_coverage_percent` int DEFAULT 80,
	`min_temperature_celsius` decimal(5,2) DEFAULT '15',
	`max_temperature_celsius` decimal(5,2) DEFAULT '45',
	`max_humidity_percent` int DEFAULT 90,
	`enable_power_alerts` int DEFAULT 1,
	`enable_cloud_alerts` int DEFAULT 1,
	`enable_temperature_alerts` int DEFAULT 1,
	`enable_humidity_alerts` int DEFAULT 1,
	`refresh_interval_seconds` int DEFAULT 5,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `alert_configs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `alert_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`alert_type` enum('power','cloud','temperature','humidity') NOT NULL,
	`severity` enum('info','warning','critical') DEFAULT 'warning',
	`message` text NOT NULL,
	`current_value` decimal(10,2),
	`threshold_value` decimal(10,2),
	`is_acknowledged` int DEFAULT 0,
	`triggered_at` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `alert_history_id` PRIMARY KEY(`id`)
);
