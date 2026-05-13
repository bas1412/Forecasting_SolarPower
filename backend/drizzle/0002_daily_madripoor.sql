ALTER TABLE `sensor_readings` MODIFY COLUMN `power_watts` decimal(10,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `sensor_readings` MODIFY COLUMN `temperature_celsius` decimal(5,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `sensor_readings` MODIFY COLUMN `wind_speed_ms` decimal(5,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `sensor_readings` ADD `voltage_ac` decimal(6,2);--> statement-breakpoint
ALTER TABLE `sensor_readings` ADD `current_ac` decimal(6,2);--> statement-breakpoint
ALTER TABLE `sensor_readings` ADD `energy_kwh` decimal(10,2);--> statement-breakpoint
ALTER TABLE `sensor_readings` ADD `power_factor` decimal(3,2);--> statement-breakpoint
ALTER TABLE `sensor_readings` ADD `pressure_hpa` decimal(7,2);