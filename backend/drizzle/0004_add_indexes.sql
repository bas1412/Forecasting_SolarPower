-- Add indexes for sensor_readings table to optimize queries
-- These indexes are critical for performance when dealing with large datasets

-- Index on reading_time for History and Analytics queries
-- This is the most important index as queries filter by time range
CREATE INDEX idx_sensor_readings_reading_time ON sensor_readings(reading_time DESC);

-- Index on created_at for sorting and filtering by creation time
CREATE INDEX idx_sensor_readings_created_at ON sensor_readings(createdAt DESC);

-- Composite index for power-related queries (power + timestamp)
-- Used for power history charts and analytics
CREATE INDEX idx_sensor_readings_power_time ON sensor_readings(powerWatts, readingTime DESC);

-- Composite index for temperature queries
-- Used for environmental monitoring and analytics
CREATE INDEX idx_sensor_readings_temp_time ON sensor_readings(temperatureCelsius, readingTime DESC);

-- Index on cloud_detections for efficient filtering
CREATE INDEX idx_cloud_detections_detection_time ON cloud_detections(detectionTime DESC);

-- Composite index for cloud coverage queries
CREATE INDEX idx_cloud_detections_coverage_time ON cloud_detections(cloudCoveragePercent, detectionTime DESC);

-- Index on sky_images for efficient filtering
CREATE INDEX idx_sky_images_capture_time ON sky_images(captureTime DESC);

-- Index on alert_history for efficient alert tracking
CREATE INDEX idx_alert_history_triggered_at ON alert_history(triggeredAt DESC);

-- Composite index for alert history filtering by type and time
CREATE INDEX idx_alert_history_type_time ON alert_history(alertType, triggeredAt DESC);

-- Index for alert configuration queries
CREATE INDEX idx_alert_configs_created_at ON alertConfigs(createdAt DESC);
