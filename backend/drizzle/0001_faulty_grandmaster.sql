CREATE TABLE `cloud_detections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`cloud_coverage_percent` int NOT NULL,
	`cloud_vector_data` text,
	`image_id` int,
	`detection_time` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cloud_detections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sensor_readings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`power_watts` int NOT NULL,
	`temperature_celsius` int NOT NULL,
	`humidity_percent` int NOT NULL,
	`wind_speed_ms` int NOT NULL,
	`reading_time` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sensor_readings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sky_images` (
	`id` int AUTO_INCREMENT NOT NULL,
	`file_key` varchar(255) NOT NULL,
	`image_url` text NOT NULL,
	`mime_type` varchar(50) DEFAULT 'image/jpeg',
	`file_size_bytes` int,
	`capture_time` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sky_images_id` PRIMARY KEY(`id`)
);
