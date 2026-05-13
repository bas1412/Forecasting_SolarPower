import { decimal, int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Sensor readings table - stores real-time data from solar panel sensors
 * Records data from:
 * - PZEM-004T: AC Power Monitoring (Voltage, Current, Power, Energy, Power Factor)
 * - AHT20: Temperature and Humidity
 * - BMP280: Atmospheric Pressure
 * - RS-FSA-N01: Wind Speed (via RS485/Modbus + TTL converter)
 */
export const sensorReadings = mysqlTable("sensor_readings", {
  id: int("id").autoincrement().primaryKey(),
  
  // PZEM-004T AC Power Monitoring
  /** AC Voltage in volts (0-300V) from PZEM-004T */
  voltageAC: decimal("voltage_ac", { precision: 6, scale: 2 }),
  /** AC Current in amperes (0-100A) from PZEM-004T */
  currentAC: decimal("current_ac", { precision: 6, scale: 2 }),
  /** AC Power in watts (0-30000W) from PZEM-004T */
  powerWatts: decimal("power_watts", { precision: 10, scale: 2 }).notNull(),
  /** AC Energy in kWh (cumulative) from PZEM-004T */
  energyKwh: decimal("energy_kwh", { precision: 10, scale: 2 }),
  /** Power factor (0.0-1.0) from PZEM-004T */
  powerFactor: decimal("power_factor", { precision: 3, scale: 2 }),
  
  // AHT20 Environmental Sensor
  /** Ambient temperature in Celsius (-20 to +60°C) from AHT20 */
  temperatureCelsius: decimal("temperature_celsius", { precision: 5, scale: 2 }).notNull(),
  /** Relative humidity percentage (0-100%) from AHT20 */
  humidityPercent: int("humidity_percent").notNull(),
  
  // BMP280 Atmospheric Sensor
  /** Atmospheric pressure in hPa (300-1100 hPa) from BMP280 */
  pressureHpa: decimal("pressure_hpa", { precision: 7, scale: 2 }),
  
  // RS-FSA-N01 Wind Speed (RS485/Modbus via TTL converter)
  /** Wind speed in m/s (0-60 m/s) from RS-FSA-N01 */
  windSpeedMs: decimal("wind_speed_ms", { precision: 5, scale: 2 }).notNull(),
  
  /** Timestamp when reading was taken */
  readingTime: timestamp("reading_time").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type SensorReading = typeof sensorReadings.$inferSelect;
export type InsertSensorReading = typeof sensorReadings.$inferInsert;

/**
 * Cloud detection results table - stores cloud detection analysis
 * Links to sky images and stores cloud coverage percentage and vector data
 */
export const cloudDetections = mysqlTable("cloud_detections", {
  id: int("id").autoincrement().primaryKey(),
  /** Cloud coverage percentage (0-100) */
  cloudCoveragePercent: int("cloud_coverage_percent").notNull(),
  /** Cloud vector data (JSON format for cloud movement/type info) */
  cloudVectorData: text("cloud_vector_data"), // JSON string
  /** Reference to the sky image used for detection */
  imageId: int("image_id"),
  /** Detection timestamp */
  detectionTime: timestamp("detection_time").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type CloudDetection = typeof cloudDetections.$inferSelect;
export type InsertCloudDetection = typeof cloudDetections.$inferInsert;

/**
 * Sky images table - stores metadata and S3 URLs for sky photos
 * Captured from Raspberry Pi Camera Module 3
 */
export const skyImages = mysqlTable("sky_images", {
  id: int("id").autoincrement().primaryKey(),
  /** S3 file key for the image */
  fileKey: varchar("file_key", { length: 255 }).notNull(),
  /** Public S3 URL to access the image */
  imageUrl: text("image_url").notNull(),
  /** Image MIME type (e.g., image/jpeg) */
  mimeType: varchar("mime_type", { length: 50 }).default("image/jpeg"),
  /** Image file size in bytes */
  fileSizeBytes: int("file_size_bytes"),
  /** Capture timestamp */
  captureTime: timestamp("capture_time").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type SkyImage = typeof skyImages.$inferSelect;
export type InsertSkyImage = typeof skyImages.$inferInsert;

/**
 * Alert configuration table - stores user-defined alert thresholds
 * Allows users to set thresholds for power, cloud coverage, temperature, etc.
 */
export const alertConfigs = mysqlTable("alert_configs", {
  id: int("id").autoincrement().primaryKey(),
  
  // Power alerts
  /** Minimum power threshold (W) - alert if power drops below this */
  minPowerWatts: decimal("min_power_watts", { precision: 10, scale: 2 }).default("50"),
  /** Maximum power threshold (W) - alert if power exceeds this */
  maxPowerWatts: decimal("max_power_watts", { precision: 10, scale: 2 }).default("500"),
  
  // Cloud coverage alerts
  /** Maximum cloud coverage threshold (%) - alert if exceeds this */
  maxCloudCoveragePercent: int("max_cloud_coverage_percent").default(80),
  
  // Temperature alerts
  /** Minimum temperature threshold (°C) - alert if below this */
  minTemperatureCelsius: decimal("min_temperature_celsius", { precision: 5, scale: 2 }).default("15"),
  /** Maximum temperature threshold (°C) - alert if exceeds this */
  maxTemperatureCelsius: decimal("max_temperature_celsius", { precision: 5, scale: 2 }).default("45"),
  
  // Humidity alerts
  /** Maximum humidity threshold (%) - alert if exceeds this */
  maxHumidityPercent: int("max_humidity_percent").default(90),
  
  // Alert settings
  /** Enable/disable power alerts */
  enablePowerAlerts: int("enable_power_alerts").default(1),
  /** Enable/disable cloud coverage alerts */
  enableCloudAlerts: int("enable_cloud_alerts").default(1),
  /** Enable/disable temperature alerts */
  enableTemperatureAlerts: int("enable_temperature_alerts").default(1),
  /** Enable/disable humidity alerts */
  enableHumidityAlerts: int("enable_humidity_alerts").default(1),
  
  /** Refresh interval in seconds (5-300) */
  refreshIntervalSeconds: int("refresh_interval_seconds").default(5),
  
  // Hysteresis settings - prevent alert spam when value oscillates near threshold
  /** Duration (seconds) that value must exceed threshold before triggering alert */
  hysteresisDurationSeconds: int("hysteresis_duration_seconds").default(30),
  /** Cooldown period (seconds) before same alert can trigger again */
  alertCooldownSeconds: int("alert_cooldown_seconds").default(300),
  
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type AlertConfig = typeof alertConfigs.$inferSelect;
export type InsertAlertConfig = typeof alertConfigs.$inferInsert;

/**
 * Alert history table - stores triggered alerts for historical tracking
 */
export const alertHistory = mysqlTable("alert_history", {
  id: int("id").autoincrement().primaryKey(),
  
  /** Alert type: power, cloud, temperature, humidity */
  alertType: mysqlEnum("alert_type", ["power", "cloud", "temperature", "humidity"]).notNull(),
  /** Alert severity: info, warning, critical */
  severity: mysqlEnum("severity", ["info", "warning", "critical"]).default("warning"),
  /** Alert message */
  message: text("message").notNull(),
  /** Current value that triggered the alert */
  currentValue: decimal("current_value", { precision: 10, scale: 2 }),
  /** Threshold value */
  thresholdValue: decimal("threshold_value", { precision: 10, scale: 2 }),
  /** Whether alert was acknowledged */
  isAcknowledged: int("is_acknowledged").default(0),
  /** Timestamp when alert was triggered */
  triggeredAt: timestamp("triggered_at").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AlertHistory = typeof alertHistory.$inferSelect;
export type InsertAlertHistory = typeof alertHistory.$inferInsert;
