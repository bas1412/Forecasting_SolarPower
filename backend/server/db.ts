import { eq, desc, and, gte, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, sensorReadings, InsertSensorReading, skyImages, InsertSkyImage, cloudDetections, InsertCloudDetection, alertConfigs, InsertAlertConfig, alertHistory, InsertAlertHistory } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;
let sensorReadingId = 1;
let skyImageId = 1;
let cloudDetectionId = 1;
let alertHistoryId = 1;

const memoryStore = {
  sensorReadings: [] as Array<any>,
  skyImages: [] as Array<any>,
  cloudDetections: [] as Array<any>,
  alertConfig: null as any,
  alertHistory: [] as Array<any>,
};

function hasDatabaseUrl() {
  return Boolean(process.env.DATABASE_URL);
}

function sortByDateDesc<T extends Record<string, any>>(items: T[], field: keyof T) {
  return [...items].sort((a, b) => {
    const aTime = new Date(a[field] ?? 0).getTime();
    const bTime = new Date(b[field] ?? 0).getTime();
    return bTime - aTime;
  });
}

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// Sensor readings queries
export async function createSensorReading(data: InsertSensorReading) {
  const db = await getDb();
  
  // Convert numeric values to strings for decimal fields
  const convertedData: InsertSensorReading = {
    ...data,
    powerWatts: data.powerWatts?.toString() as any,
    temperatureCelsius: data.temperatureCelsius?.toString() as any,
    windSpeedMs: data.windSpeedMs?.toString() as any,
    voltageAC: data.voltageAC?.toString() as any,
    currentAC: data.currentAC?.toString() as any,
    energyKwh: data.energyKwh?.toString() as any,
    powerFactor: data.powerFactor?.toString() as any,
    pressureHpa: data.pressureHpa?.toString() as any,
  };

  if (!db) {
    const record = {
      id: sensorReadingId++,
      ...convertedData,
      readingTime: convertedData.readingTime ?? new Date(),
      createdAt: new Date(),
    };
    memoryStore.sensorReadings.unshift(record);
    return { insertId: record.id };
  }
  
  const result = await db.insert(sensorReadings).values(convertedData);
  return result;
}

export async function getSensorReadings(limit: number = 100, offset: number = 0) {
  const db = await getDb();
  if (!db) {
    return sortByDateDesc(memoryStore.sensorReadings, "readingTime").slice(
      offset,
      offset + limit
    );
  }
  
  const readings = await db
    .select()
    .from(sensorReadings)
    .orderBy((t) => desc(t.readingTime))
    .limit(limit)
    .offset(offset);
  
  return readings;
}

export async function getSensorReadingsByTimeRange(startDate: Date, endDate?: Date) {
  const db = await getDb();
  if (!db) {
    return sortByDateDesc(memoryStore.sensorReadings, "readingTime").filter((reading) => {
      const readingTime = new Date(reading.readingTime).getTime();
      const startTime = startDate.getTime();
      const endTime = endDate ? endDate.getTime() : Number.POSITIVE_INFINITY;
      return readingTime >= startTime && readingTime < endTime;
    });
  }

  const conditions = [gte(sensorReadings.readingTime, startDate)];
  if (endDate) {
    conditions.push(lt(sensorReadings.readingTime, endDate));
  }

  const readings = await db
    .select()
    .from(sensorReadings)
    .where(and(...conditions))
    .orderBy((t) => desc(t.readingTime));

  return readings;
}

export async function getLatestSensorReading() {
  const db = await getDb();
  if (!db) {
    return sortByDateDesc(memoryStore.sensorReadings, "readingTime")[0] || null;
  }
  
  const result = await db
    .select()
    .from(sensorReadings)
    .orderBy((t) => desc(t.readingTime))
    .limit(1);
  
  return result[0] || null;
}

// Sky images queries
export async function createSkyImage(data: InsertSkyImage) {
  const db = await getDb();
  if (!db) {
    const record = {
      id: skyImageId++,
      ...data,
      captureTime: data.captureTime ?? new Date(),
      createdAt: new Date(),
    };
    memoryStore.skyImages.unshift(record);
    return { insertId: record.id };
  }
  
  const result = await db.insert(skyImages).values(data);
  return result;
}

export async function getSkyImages(limit: number = 20, offset: number = 0) {
  const db = await getDb();
  if (!db) {
    return sortByDateDesc(memoryStore.skyImages, "captureTime").slice(
      offset,
      offset + limit
    );
  }
  
  const images = await db
    .select()
    .from(skyImages)
    .orderBy((t) => desc(t.captureTime))
    .limit(limit)
    .offset(offset);
  
  return images;
}

// Cloud detection queries
export async function createCloudDetection(data: InsertCloudDetection) {
  const db = await getDb();
  if (!db) {
    const record = {
      id: cloudDetectionId++,
      ...data,
      detectionTime: data.detectionTime ?? new Date(),
      createdAt: new Date(),
    };
    memoryStore.cloudDetections.unshift(record);
    return { insertId: record.id };
  }
  
  const result = await db.insert(cloudDetections).values(data);
  return result;
}

export async function getCloudDetections(limit: number = 50, offset: number = 0) {
  const db = await getDb();
  if (!db) {
    return sortByDateDesc(memoryStore.cloudDetections, "detectionTime").slice(
      offset,
      offset + limit
    );
  }
  
  const detections = await db
    .select()
    .from(cloudDetections)
    .orderBy((t) => desc(t.detectionTime))
    .limit(limit)
    .offset(offset);
  
  return detections;
}

export async function getLatestCloudDetection() {
  const db = await getDb();
  if (!db) {
    return sortByDateDesc(memoryStore.cloudDetections, "detectionTime")[0] || null;
  }
  
  const result = await db
    .select()
    .from(cloudDetections)
    .orderBy((t) => desc(t.detectionTime))
    .limit(1);
  
  return result[0] || null;
}

// Alert configuration queries
export async function getAlertConfig() {
  const db = await getDb();
  if (!db) {
    return memoryStore.alertConfig;
  }
  
  const result = await db.select().from(alertConfigs).limit(1);
  return result[0] || null;
}

export async function updateAlertConfig(data: Partial<InsertAlertConfig>) {
  const db = await getDb();
  if (!db) {
    memoryStore.alertConfig = {
      ...(memoryStore.alertConfig ?? {
        id: 1,
        createdAt: new Date(),
      }),
      ...data,
      updatedAt: new Date(),
    };
    return { insertId: 1 };
  }
  
  // Get or create config
  const existing = await getAlertConfig();
  
  if (existing) {
    // Update existing
    const result = await db
      .update(alertConfigs)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(alertConfigs.id, existing.id));
    return result;
  } else {
    // Create new
    const result = await db.insert(alertConfigs).values(data as InsertAlertConfig);
    return result;
  }
}

// Alert history queries
export async function createAlertHistory(data: InsertAlertHistory) {
  const db = await getDb();
  if (!db) {
    const record = {
      id: alertHistoryId++,
      ...data,
      isAcknowledged: data.isAcknowledged ?? 0,
      triggeredAt: data.triggeredAt ?? new Date(),
      createdAt: new Date(),
    };
    memoryStore.alertHistory.unshift(record);
    return { insertId: record.id };
  }
  
  const result = await db.insert(alertHistory).values(data);
  return result;
}

export async function getAlertHistory(limit: number = 50, offset: number = 0) {
  const db = await getDb();
  if (!db) {
    return sortByDateDesc(memoryStore.alertHistory, "triggeredAt").slice(
      offset,
      offset + limit
    );
  }
  
  const history = await db
    .select()
    .from(alertHistory)
    .orderBy((t) => desc(t.triggeredAt))
    .limit(limit)
    .offset(offset);
  
  return history;
}

export async function acknowledgeAlert(alertId: number) {
  const db = await getDb();
  if (!db) {
    const alert = memoryStore.alertHistory.find(item => item.id === alertId);
    if (alert) {
      alert.isAcknowledged = 1;
    }
    return { affectedRows: alert ? 1 : 0 };
  }
  
  const result = await db
    .update(alertHistory)
    .set({ isAcknowledged: 1 })
    .where(eq(alertHistory.id, alertId));
  
  return result;
}
