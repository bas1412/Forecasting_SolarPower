const RESEARCH_API_URL = process.env.FASTAPI_URL || "http://127.0.0.1:8010";
const RESEARCH_TIMEOUT_MS = 15000;
const STABLE_FORECAST_TIMEOUT_MS = 20000;

type FetchOptions = {
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
  hoursBack?: number;
};

type ResearchSensorRecord = {
  id?: number;
  timestamp?: string;
  readingTime?: string;
  powerWatts: number | string;
  temperatureCelsius: number | string;
  humidityPercent: number;
  windSpeedMs: number | string;
  voltageAC?: number | string | null;
  currentAC?: number | string | null;
  frequencyHz?: number | string | null;
  energyKwh?: number | string | null;
  powerFactor?: number | string | null;
  pressureHpa?: number | string | null;
};

type ResearchImageRecord = {
  id?: number;
  imageUrl: string;
  fileKey?: string;
  mimeType?: string | null;
  fileSizeBytes?: number | null;
  cloudCoveragePercent?: number | null;
  cloudVectorData?: string | null;
  timestamp?: string;
  captureTime?: string;
  createdAt?: string;
};

type HourlySummaryRow = {
  hour: string;
  power: number;
  voltage: number;
  current: number;
  powerFactor: number;
  temperature: number;
  humidity: number;
  windSpeed: number;
};

export type ResearchForecastItem = {
  time: string;
  horizonMinutes: number;
  power: number;
  confidence: number;
  trend: "up" | "down" | "flat";
  model: string;
  rawPower?: number;
  rangeAdjusted?: boolean;
  windowMinutes?: number;
};

export type ResearchForecastResponse = {
  success: boolean;
  items: ResearchForecastItem[];
  modelType?: string;
  trainedThrough?: string;
  generatedAt?: string;
  sourceRows?: number;
  currentPower?: number;
  latestReadingTime?: string | null;
  latestImageTime?: string | null;
  nearestImageDeltaSeconds?: number | null;
  imageFileKey?: string | null;
  imageFeatures?: Record<string, number>;
  quality?: {
    electricalLowConfidence?: boolean;
    powerFactorReliable?: boolean;
    currentReliable?: boolean;
    imageUsable?: boolean;
    rangeGuardApplied?: boolean;
    recentPowerMin?: number | null;
    recentPowerMax?: number | null;
    note?: string;
  };
  predictionLog?: {
    saved: number;
    skipped: number;
    index?: string;
    reason?: string;
  };
  predictionEvaluation?: {
    checked: number;
    matched: number;
    waiting: number;
    missingActual: number;
    toleranceSeconds: number;
  };
  note?: string;
  error?: string;
};

function buildUrl(path: string, options?: FetchOptions) {
  const url = new URL(`${RESEARCH_API_URL}${path}`);

  if (options?.limit !== undefined) {
    url.searchParams.set("limit", String(options.limit));
  }
  if (options?.offset !== undefined) {
    url.searchParams.set("offset", String(options.offset));
  }
  if (options?.startDate) {
    url.searchParams.set("startDate", options.startDate.toISOString());
  }
  if (options?.endDate) {
    url.searchParams.set("endDate", options.endDate.toISOString());
  }
  if (options?.hoursBack !== undefined) {
    url.searchParams.set("hoursBack", String(options.hoursBack));
  }

  return url.toString();
}

async function fetchResearchJson<T>(
  path: string,
  options?: FetchOptions,
  timeoutMs: number = RESEARCH_TIMEOUT_MS
): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildUrl(path, options), {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText);
      console.warn(`[ResearchData] ${path} failed: ${response.status} ${body}`);
      return null;
    }

    return (await response.json()) as T;
  } catch (error) {
    console.warn(`[ResearchData] ${path} unavailable:`, error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSensorRecord(record: ResearchSensorRecord, index: number) {
  return {
    id: record.id ?? index + 1,
    readingTime: record.readingTime ?? record.timestamp ?? new Date().toISOString(),
    powerWatts: String(record.powerWatts ?? 0),
    temperatureCelsius: String(record.temperatureCelsius ?? 0),
    humidityPercent: Number(record.humidityPercent ?? 0),
    windSpeedMs: String(record.windSpeedMs ?? 0),
    voltageAC: record.voltageAC == null ? null : String(record.voltageAC),
    currentAC: record.currentAC == null ? null : String(record.currentAC),
    frequencyHz: record.frequencyHz == null ? null : String(record.frequencyHz),
    energyKwh: record.energyKwh == null ? null : String(record.energyKwh),
    powerFactor: record.powerFactor == null ? null : String(record.powerFactor),
    pressureHpa: record.pressureHpa == null ? null : String(record.pressureHpa),
  };
}

function normalizeImageRecord(record: ResearchImageRecord, index: number) {
  return {
    id: record.id ?? index + 1,
    imageUrl: record.imageUrl,
    fileKey: record.fileKey ?? null,
    mimeType: record.mimeType ?? "image/jpeg",
    fileSizeBytes: record.fileSizeBytes ?? null,
    captureTime: record.captureTime ?? record.timestamp ?? record.createdAt ?? new Date().toISOString(),
    createdAt: record.createdAt ?? record.timestamp ?? record.captureTime ?? new Date().toISOString(),
    cloudCoveragePercent: record.cloudCoveragePercent ?? null,
    cloudVectorData: record.cloudVectorData ?? null,
  };
}

export async function getResearchSensorReadings(
  limit = 100,
  offset = 0,
  startDate?: Date,
  endDate?: Date
) {
  const payload = await fetchResearchJson<{ items: ResearchSensorRecord[] }>(
    "/data/sensors",
    { limit, offset, startDate, endDate }
  );

  if (!payload?.items) return null;
  return payload.items.map(normalizeSensorRecord);
}

export async function getResearchLatestSensorReading() {
  const payload = await fetchResearchJson<{ item: ResearchSensorRecord | null }>("/data/sensors/latest");

  if (!payload?.item) return null;
  return normalizeSensorRecord(payload.item, 0);
}

export async function getResearchHourlySummary(startDate?: Date, endDate?: Date) {
  const payload = await fetchResearchJson<{ items: HourlySummaryRow[] }>(
    "/data/sensors/hourly-summary",
    { startDate, endDate }
  );

  return payload?.items ?? null;
}

export async function getResearchImages(limit = 20, offset = 0) {
  const payload = await fetchResearchJson<{ items: ResearchImageRecord[] }>(
    "/data/images",
    { limit, offset }
  );

  if (!payload?.items) return null;
  return payload.items.map(normalizeImageRecord);
}

export async function getResearchLatestCloudDetection() {
  const payload = await fetchResearchJson<{
    item: {
      cloudCoveragePercent: number;
      cloudVectorData?: string | null;
      detectionTime: string;
      imageUrl?: string | null;
    } | null;
  }>("/data/clouds/latest");

  if (!payload?.item) return null;
  return {
    cloudCoveragePercent: payload.item.cloudCoveragePercent,
    cloudVectorData: payload.item.cloudVectorData ?? null,
    detectionTime: payload.item.detectionTime,
    imageUrl: payload.item.imageUrl ?? null,
  };
}

export async function getResearchRandomForestForecast(hoursBack = 2) {
  return fetchResearchJson<ResearchForecastResponse>(
    "/forecast/random-forest/latest",
    { hoursBack }
  );
}

export async function getResearchStableWindowForecast(hoursBack = 2) {
  return fetchResearchJson<ResearchForecastResponse>(
    "/forecast/stable-window/latest",
    { hoursBack },
    STABLE_FORECAST_TIMEOUT_MS
  );
}
