import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import {
  createSensorReading,
  getSensorReadings,
  getSensorReadingsByTimeRange,
  getLatestSensorReading,
  createSkyImage,
  getSkyImages,
  createCloudDetection,
  getCloudDetections,
  getLatestCloudDetection,
  getAlertConfig,
  updateAlertConfig,
  createAlertHistory,
  getAlertHistory,
  acknowledgeAlert,
  getDb,
} from "./db";
import { mirrorSensorReading } from "./researchMirror";
import {
  getResearchHourlySummary,
  getResearchImages,
  getResearchLatestCloudDetection,
  getResearchLatestSensorReading,
  getResearchRandomForestForecast,
  getResearchStableWindowForecast,
  getResearchSensorReadings,
} from "./researchData";
import { getBaselinePowerForecast } from "./baselineForecast";
import { skyImages, cloudDetections } from "../drizzle/schema";
import { eq, gte, lt, and } from "drizzle-orm";

// Validation schemas
const sensorReadingSchema = z.object({
  // PZEM-004T AC Power Monitoring (optional fields)
  voltageAC: z.number().min(0).max(300).optional(), // 0-300V
  voltageV: z.number().min(0).max(300).optional(), // alias for Raspberry Pi script
  currentAC: z.number().min(0).max(100).optional(), // 0-100A
  currentA: z.number().min(0).max(100).optional(), // alias for Raspberry Pi script
  powerWatts: z.number().min(0).max(30000), // 0-30000W (required)
  energyKwh: z.number().min(0).optional(), // Cumulative energy in kWh
  powerFactor: z.number().min(0).max(1).optional(), // Power factor 0.0-1.0
  
  // AHT20 Environmental Sensor
  temperatureCelsius: z.number().min(-20).max(85), // AHT20 operating range: -20 to +85°C
  humidityPercent: z.number().int().min(0).max(100), // 0-100% (required)
  
  // BMP280 Atmospheric Sensor (optional)
  pressureHpa: z.number().min(300).max(1100).optional(), // 300-1100 hPa
  pressure: z.number().min(300).max(1100).optional(), // alias for Raspberry Pi script
  
  // RS-FSA-N01 Wind Speed (RS485/Modbus)
  windSpeedMs: z.number().min(0).max(60), // 0-60 m/s (required)

  // Optional Raspberry Pi camera payload for one-shot uploads
  cloudCoveragePercent: z.number().int().min(0).max(100).optional(),
  cloudVectorData: z.string().nullable().optional(),
  skyImage: z.string().min(1).optional(),
  imageData: z.string().min(1).optional(), // alias for Raspberry Pi script
});

const skyImageSchema = z.object({
  fileKey: z.string().min(1),
  imageUrl: z.string().url(),
  mimeType: z.string().default("image/jpeg"),
  fileSizeBytes: z.number().int().optional(),
});

const cloudDetectionSchema = z.object({
  cloudCoveragePercent: z.number().int().min(0).max(100),
  cloudVectorData: z.string().optional().nullable(),
  imageId: z.number().int().optional().nullable(),
});

const imageFilterSchema = z.object({
  limit: z.number().int().min(1).max(100).default(12),
  offset: z.number().int().min(0).default(0),
  startDate: z.date().optional(),
  endDate: z.date().optional(),
  minCloudCoverage: z.number().int().min(0).max(100).optional(),
  maxCloudCoverage: z.number().int().min(0).max(100).optional(),
});

const paginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(12),
  offset: z.number().int().min(0).default(0),
});

const sensorPaginationSchema = z.object({
  limit: z.number().int().min(1).max(5000).default(100),
  offset: z.number().int().min(0).default(0),
  startDate: z.date().optional(),
  endDate: z.date().optional(),
});

const imageUploadSchema = z.object({
  imageData: z.string().min(1),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  cloudCoveragePercent: z.number().int().min(0).max(100).optional(),
  cloudVectorData: z.string().nullable().optional(),
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // Sensor readings API
  sensors: router({
    // Create new sensor reading
    create: publicProcedure
      .input(sensorReadingSchema)
      .mutation(async ({ input }) => {
        const {
          skyImage,
          imageData,
          cloudCoveragePercent,
          cloudVectorData,
          voltageV,
          currentA,
          pressure,
          ...sensorInput
        } = input;

        const normalizedSensorInput = {
          ...sensorInput,
          voltageAC: sensorInput.voltageAC ?? voltageV,
          currentAC: sensorInput.currentAC ?? currentA,
          pressureHpa: sensorInput.pressureHpa ?? pressure,
        };

        // Convert number fields to string for decimal storage
        const converted = {
          ...normalizedSensorInput,
          powerWatts: normalizedSensorInput.powerWatts.toString(),
          temperatureCelsius: normalizedSensorInput.temperatureCelsius.toString(),
          windSpeedMs: normalizedSensorInput.windSpeedMs.toString(),
          voltageAC: normalizedSensorInput.voltageAC?.toString(),
          currentAC: normalizedSensorInput.currentAC?.toString(),
          energyKwh: normalizedSensorInput.energyKwh?.toString(),
          powerFactor: normalizedSensorInput.powerFactor?.toString(),
          pressureHpa: normalizedSensorInput.pressureHpa?.toString(),
        };
        const sensorResult = await createSensorReading(converted);

        mirrorSensorReading({
          powerWatts: normalizedSensorInput.powerWatts,
          temperatureCelsius: normalizedSensorInput.temperatureCelsius,
          humidityPercent: normalizedSensorInput.humidityPercent,
          windSpeedMs: normalizedSensorInput.windSpeedMs,
          voltageAC: normalizedSensorInput.voltageAC,
          currentAC: normalizedSensorInput.currentAC,
          energyKwh: normalizedSensorInput.energyKwh,
          powerFactor: normalizedSensorInput.powerFactor,
          pressureHpa: normalizedSensorInput.pressureHpa,
        });

        const imagePayload = skyImage || imageData;

        if (imagePayload) {
          const { uploadImageAndSaveMetadata } = await import("./imageUpload");
          await uploadImageAndSaveMetadata({
            imageData: imagePayload,
            mimeType: "image/jpeg",
            cloudCoveragePercent,
            cloudVectorData,
          });
        }

        return sensorResult;
      }),

    // Get sensor readings with pagination
    list: publicProcedure
      .input(sensorPaginationSchema)
      .query(async ({ input }) => {
        const researchItems = await getResearchSensorReadings(
          input.limit,
          input.offset,
          input.startDate,
          input.endDate
        );
        if (researchItems) return researchItems;
        if (input.startDate || input.endDate) {
          const rangeItems = await getSensorReadingsByTimeRange(
            input.startDate ?? new Date(0),
            input.endDate
          );
          return rangeItems.slice(input.offset, input.offset + input.limit);
        }
        return getSensorReadings(input.limit, input.offset);
      }),

    // Get latest sensor reading
    latest: publicProcedure
      .query(async () => {
        const researchItem = await getResearchLatestSensorReading();
        if (researchItem) return researchItem;
        return getLatestSensorReading();
      }),

    hourlySummary: publicProcedure
      .input(
        z
          .object({
            startDate: z.date().optional(),
            endDate: z.date().optional(),
          })
          .optional()
      )
      .query(async ({ input }) => {
        const now = new Date();
        const startDate =
          input?.startDate ??
          new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const endDate = input?.endDate;

        const researchSummary = await getResearchHourlySummary(input?.startDate, input?.endDate);
        if (researchSummary) return researchSummary;

        const readings = await getSensorReadingsByTimeRange(startDate, endDate);

        const grouped = new Map<string, any[]>();

        readings.forEach((reading: any) => {
          const date = new Date(reading.readingTime);
          const bucket = new Date(
            date.getFullYear(),
            date.getMonth(),
            date.getDate(),
            date.getHours(),
            0,
            0,
            0
          ).toISOString();

          if (!grouped.has(bucket)) grouped.set(bucket, []);
          grouped.get(bucket)!.push(reading);
        });

        const average = (values: number[]) =>
          values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

        return Array.from(grouped.entries())
          .map(([hourKey, bucketReadings]) => ({
            hour: hourKey,
            power: average(bucketReadings.map((r: any) => Number(r.powerWatts || 0))),
            voltage: average(bucketReadings.map((r: any) => Number(r.voltageAC || 0))),
            current: average(bucketReadings.map((r: any) => Number(r.currentAC || 0))),
            powerFactor: average(bucketReadings.map((r: any) => Number(r.powerFactor || 0))),
            temperature: average(bucketReadings.map((r: any) => Number(r.temperatureCelsius || 0))),
            humidity: average(bucketReadings.map((r: any) => Number(r.humidityPercent || 0))),
            windSpeed: average(bucketReadings.map((r: any) => Number(r.windSpeedMs || 0))),
          }))
          .sort((a, b) => new Date(b.hour).getTime() - new Date(a.hour).getTime());
      }),
  }),

  // Cloud detection API
  clouds: router({
    // Get cloud detections with pagination
    list: publicProcedure
      .input(paginationSchema)
      .query(async ({ input }) => {
        return getCloudDetections(input.limit, input.offset);
      }),

    // Get latest cloud detection
    latest: publicProcedure
      .query(async () => {
        const researchItem = await getResearchLatestCloudDetection();
        if (researchItem) return researchItem;
        return getLatestCloudDetection();
      }),

    // Create new cloud detection
    create: publicProcedure
      .input(cloudDetectionSchema)
      .mutation(async ({ input }) => {
        return createCloudDetection(input);
      }),
  }),

  // Sky images API
  images: router({
    // Get sky images with pagination
    list: publicProcedure
      .input(paginationSchema)
      .query(async ({ input }) => {
        const researchItems = await getResearchImages(input.limit, input.offset);
        if (researchItems) return researchItems;
        return getSkyImages(input.limit, input.offset);
      }),

    // Get sky images with filters (date range, cloud coverage)
    listFiltered: publicProcedure
      .input(imageFilterSchema)
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return { images: [], total: 0 };

        try {
          // Build base query
          let baseQuery = db.select().from(skyImages) as any;

          // Apply date filters
          if (input.startDate || input.endDate) {
            const conditions: any[] = [];
            if (input.startDate) {
              conditions.push(gte(skyImages.captureTime, input.startDate));
            }
            if (input.endDate) {
              const nextDay = new Date(input.endDate);
              nextDay.setDate(nextDay.getDate() + 1);
              conditions.push(lt(skyImages.captureTime, nextDay));
            }
            baseQuery = baseQuery.where(and(...conditions));
          }

          // Execute query
          const allImages = await baseQuery.limit(1000).offset(input.offset);

          // Filter by cloud coverage if specified
          let filtered = allImages;
          if (input.minCloudCoverage !== undefined || input.maxCloudCoverage !== undefined) {
            const imagesWithCloud = await Promise.all(
              allImages.map(async (img: any) => {
                const cloudData = await db
                  .select()
                  .from(cloudDetections)
                  .where(eq(cloudDetections.imageId, img.id))
                  .limit(1);
                return { img, cloudCoverage: cloudData[0]?.cloudCoveragePercent || 0 };
              })
            );

            filtered = imagesWithCloud
              .filter((item) => {
                const coverage = item.cloudCoverage;
                const minOk = input.minCloudCoverage === undefined || coverage >= input.minCloudCoverage;
                const maxOk = input.maxCloudCoverage === undefined || coverage <= input.maxCloudCoverage;
                return minOk && maxOk;
              })
              .map((item) => item.img);
          }

          // Apply pagination
          const paginatedImages = filtered.slice(0, input.limit);

          return {
            images: paginatedImages,
            total: filtered.length,
          };
        } catch (error) {
          console.error("[Images.listFiltered] Error:", error);
          return { images: [], total: 0 };
        }
      }),

    // Create new sky image
    create: publicProcedure
      .input(skyImageSchema)
      .mutation(async ({ input }) => {
        return createSkyImage(input);
      }),

    // Upload image from Raspberry Pi (base64 encoded)
    upload: publicProcedure
      .input(imageUploadSchema)
      .mutation(async ({ input }) => {
        const { uploadImageAndSaveMetadata } = await import("./imageUpload");
        return uploadImageAndSaveMetadata(input);
      }),

    // Analyze cloud detection from image bytes
    analyze: publicProcedure
      .input(z.object({
        imageBytes: z.string(), // base64 encoded image
        imageId: z.number().int().optional(),
      }))
      .mutation(async ({ input }) => {
        try {
          const { CloudDetector } = await import("./cloudDetectionWrapper");
          const detector = new CloudDetector();
          
          // Decode base64 to bytes
          const buffer = Buffer.from(input.imageBytes, "base64");
          const result = detector.detectCloudsFromBytes(buffer);
          
          // Save to database if imageId provided
          if (input.imageId && result.cloud_coverage !== undefined) {
            await createCloudDetection({
              cloudCoveragePercent: Math.round(result.cloud_coverage),
              cloudVectorData: result.cloud_vector_data ?? JSON.stringify(result),
              imageId: input.imageId,
            });
          }
          
          return result;
        } catch (error) {
          console.error("Cloud detection error:", error);
          return {
            cloud_coverage: 0,
            sky_coverage: 0,
            image_quality: 0,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      }),
  }),

  // Power Forecasting router
  forecast: router({
    getStableWindowForecast: publicProcedure
      .input(
        z
          .object({
            hoursBack: z.number().int().min(1).max(24).default(2),
          })
          .optional()
      )
      .query(async ({ input }) => {
        const result = await getResearchStableWindowForecast(input?.hoursBack ?? 2);
        if (result?.success && result.items?.length) return result;

        return {
          success: false,
          items: [],
          error: result?.error ?? "Stable window forecast unavailable",
          sourceRows: result?.sourceRows ?? 0,
          quality: result?.quality,
          note: result?.note,
        };
      }),

    getRandomForestForecast: publicProcedure
      .input(
        z
          .object({
            hoursBack: z.number().int().min(1).max(24).default(2),
          })
          .optional()
      )
      .query(async ({ input }) => {
        const result = await getResearchRandomForestForecast(input?.hoursBack ?? 2);
        if (result?.success && result.items?.length) return result;

        return {
          success: false,
          items: [],
          error: result?.error ?? "Random Forest forecast unavailable",
          sourceRows: result?.sourceRows ?? 0,
          quality: result?.quality,
        };
      }),

    getBaselineForecast: publicProcedure
      .input(
        z
          .object({
            hoursBack: z.number().int().min(1).max(24).default(2),
          })
          .optional()
      )
      .query(async ({ input }) => {
        const hoursBack = input?.hoursBack ?? 2;
        const researchLatest = await getResearchLatestSensorReading();
        const fallbackLatest = researchLatest ? null : await getLatestSensorReading();
        const latestReading = researchLatest ?? fallbackLatest;
        const latestReadingTime = latestReading?.readingTime ? new Date(latestReading.readingTime) : new Date();
        const endDate = Number.isNaN(latestReadingTime.getTime()) ? new Date() : latestReadingTime;
        const startDate = new Date(endDate.getTime() - hoursBack * 60 * 60 * 1000);

        const researchReadings = await getResearchSensorReadings(5000, 0, startDate, endDate);
        const readings =
          researchReadings ??
          (await getSensorReadingsByTimeRange(startDate, endDate));

        return getBaselinePowerForecast(readings);
      }),

    // Get power forecast for next 15 minutes
    getPowerForecast: publicProcedure
      .input(z.object({
        cloudCoveragePercent: z.number().min(0).max(100),
        temperatureCelsius: z.number(),
        hoursBack: z.number().int().min(1).max(24).default(2),
      }))
      .query(async ({ input }) => {
        try {
          const { PowerForecaster } = await import("./powerForecastingWrapper");
          const forecaster = new PowerForecaster();
          
          // Get recent sensor readings
          const recentReadings = await getSensorReadings(100, 0);
          
          // Filter to requested time range
          const now = new Date();
          const hoursAgo = new Date(now.getTime() - input.hoursBack * 60 * 60 * 1000);
          const filtered = recentReadings.filter((r: any) => {
            const readTime = new Date(r.readingTime);
            return readTime >= hoursAgo && readTime <= now;
          });
          
          if (filtered.length === 0) {
            return {
              forecast_power: 0,
              confidence: 0,
              error: "No recent sensor data available",
            };
          }
          
          // Forecast
          const result = forecaster.forecastPower(
            filtered,
            input.cloudCoveragePercent,
            input.temperatureCelsius
          );
          
          return result;
        } catch (error) {
          console.error("Power forecasting error:", error);
          return {
            forecast_power: 0,
            confidence: 0,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      }),
  }),

  // Alerts router
  alerts: router({
    // Get alert configuration
    getConfig: publicProcedure
      .query(async () => {
        const config = await getAlertConfig();
        return config || {
          minPowerWatts: 50,
          maxPowerWatts: 500,
          maxCloudCoveragePercent: 80,
          minTemperatureCelsius: 15,
          maxTemperatureCelsius: 45,
          maxHumidityPercent: 90,
          enablePowerAlerts: 1,
          enableCloudAlerts: 1,
          enableTemperatureAlerts: 1,
          enableHumidityAlerts: 1,
          refreshIntervalSeconds: 5,
        };
      }),

    // Update alert configuration
    updateConfig: publicProcedure
      .input(z.object({
        minPowerWatts: z.number().min(0).optional(),
        maxPowerWatts: z.number().min(0).optional(),
        maxCloudCoveragePercent: z.number().min(0).max(100).optional(),
        minTemperatureCelsius: z.number().optional(),
        maxTemperatureCelsius: z.number().optional(),
        maxHumidityPercent: z.number().min(0).max(100).optional(),
        enablePowerAlerts: z.number().optional(),
        enableCloudAlerts: z.number().optional(),
        enableTemperatureAlerts: z.number().optional(),
        enableHumidityAlerts: z.number().optional(),
        refreshIntervalSeconds: z.number().min(5).max(300).optional(),
      }))
      .mutation(async ({ input }) => {
        const convertedInput: any = {};
        if (input.minPowerWatts !== undefined) convertedInput.minPowerWatts = input.minPowerWatts.toString();
        if (input.maxPowerWatts !== undefined) convertedInput.maxPowerWatts = input.maxPowerWatts.toString();
        if (input.maxCloudCoveragePercent !== undefined) convertedInput.maxCloudCoveragePercent = input.maxCloudCoveragePercent;
        if (input.minTemperatureCelsius !== undefined) convertedInput.minTemperatureCelsius = input.minTemperatureCelsius.toString();
        if (input.maxTemperatureCelsius !== undefined) convertedInput.maxTemperatureCelsius = input.maxTemperatureCelsius.toString();
        if (input.maxHumidityPercent !== undefined) convertedInput.maxHumidityPercent = input.maxHumidityPercent;
        if (input.enablePowerAlerts !== undefined) convertedInput.enablePowerAlerts = input.enablePowerAlerts;
        if (input.enableCloudAlerts !== undefined) convertedInput.enableCloudAlerts = input.enableCloudAlerts;
        if (input.enableTemperatureAlerts !== undefined) convertedInput.enableTemperatureAlerts = input.enableTemperatureAlerts;
        if (input.enableHumidityAlerts !== undefined) convertedInput.enableHumidityAlerts = input.enableHumidityAlerts;
        if (input.refreshIntervalSeconds !== undefined) convertedInput.refreshIntervalSeconds = input.refreshIntervalSeconds;
        return updateAlertConfig(convertedInput);
      }),

    // Get alert history
    getHistory: publicProcedure
      .input(z.object({
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }))
      .query(async ({ input }) => {
        return getAlertHistory(input.limit, input.offset);
      }),

    // Create alert
    create: publicProcedure
      .input(z.object({
        alertType: z.enum(["power", "cloud", "temperature", "humidity"]),
        severity: z.enum(["info", "warning", "critical"]).default("warning"),
        message: z.string(),
        currentValue: z.number().optional(),
        thresholdValue: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        return createAlertHistory(input as any);
      }),

    // Acknowledge alert
    acknowledge: publicProcedure
      .input(z.object({
        alertId: z.number().int(),
      }))
      .mutation(async ({ input }) => {
        return acknowledgeAlert(input.alertId);
      }),
  }),
});

export type AppRouter = typeof appRouter;
