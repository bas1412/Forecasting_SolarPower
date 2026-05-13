import fs from "node:fs";
import path from "node:path";

type SensorReading = {
  readingTime?: Date | string | null;
  powerWatts?: string | number | null;
  voltageAC?: string | number | null;
  currentAC?: string | number | null;
  frequencyHz?: string | number | null;
  powerFactor?: string | number | null;
  temperatureCelsius?: string | number | null;
  humidityPercent?: string | number | null;
  windSpeedMs?: string | number | null;
  pressureHpa?: string | number | null;
};

type ModelHorizon = {
  coef: number[];
  mean: number[];
  std: number[];
};

type BaselineModel = {
  modelType: string;
  trainEndDate: string;
  featureNames: string[];
  horizons: Record<string, ModelHorizon>;
};

export type BaselineForecastItem = {
  time: string;
  horizonMinutes: number;
  power: number;
  confidence: number;
  trend: "up" | "down" | "flat";
  model: string;
  rawPower?: number;
  rangeAdjusted?: boolean;
};

export type BaselineForecastResponse = {
  items: BaselineForecastItem[];
  modelType: string;
  trainedThrough: string;
  generatedAt: string;
  sourceRows: number;
  latestReadingTime: string | null;
  quality: {
    electricalLowConfidence: boolean;
    powerFactorReliable: boolean;
    currentReliable: boolean;
    rangeGuardApplied?: boolean;
    recentPowerMin?: number;
    recentPowerMax?: number;
    note: string;
  };
  error?: string;
};

const MODEL_FILE = "baseline-forecast-2026-04-03_to_2026-04-18-ridge-model.json";
const MODEL_PATH = path.resolve(process.cwd(), MODEL_FILE);
const EPSILON = 1e-9;
const HORIZON_CONFIDENCE: Record<number, number> = {
  5: 0.8607,
  10: 0.8272,
  15: 0.7937,
};

let cachedModel: BaselineModel | null = null;

function asNumber(value: string | number | null | undefined, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseReadingTime(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function loadModel() {
  if (cachedModel) return cachedModel;
  const raw = fs.readFileSync(MODEL_PATH, "utf-8");
  cachedModel = JSON.parse(raw) as BaselineModel;
  return cachedModel;
}

function sortReadings(readings: SensorReading[]) {
  return readings
    .map((reading) => ({
      ...reading,
      parsedTime: parseReadingTime(reading.readingTime),
    }))
    .filter((reading): reading is SensorReading & { parsedTime: Date } => Boolean(reading.parsedTime))
    .sort((a, b) => a.parsedTime.getTime() - b.parsedTime.getTime());
}

function nearestPower(readings: Array<SensorReading & { parsedTime: Date }>, target: Date, fallback: number) {
  if (readings.length === 0) return fallback;

  let nearest = readings[0];
  let nearestDelta = Math.abs(nearest.parsedTime.getTime() - target.getTime());
  for (const reading of readings) {
    const delta = Math.abs(reading.parsedTime.getTime() - target.getTime());
    if (delta < nearestDelta) {
      nearest = reading;
      nearestDelta = delta;
    }
  }

  return nearestDelta <= 90_000 ? asNumber(nearest.powerWatts, fallback) : fallback;
}

function rollingPowerMean(
  readings: Array<SensorReading & { parsedTime: Date }>,
  latestTime: Date,
  windowMinutes: number,
  fallback: number
) {
  const start = latestTime.getTime() - windowMinutes * 60_000;
  const values = readings
    .filter((reading) => reading.parsedTime.getTime() >= start && reading.parsedTime.getTime() <= latestTime.getTime())
    .map((reading) => asNumber(reading.powerWatts, fallback));

  if (values.length === 0) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function recentPowerStats(
  readings: Array<SensorReading & { parsedTime: Date }>,
  latestTime: Date,
  windowMinutes: number,
  fallback: number
) {
  const start = latestTime.getTime() - windowMinutes * 60_000;
  const values = readings
    .filter((reading) => reading.parsedTime.getTime() >= start && reading.parsedTime.getTime() <= latestTime.getTime())
    .map((reading) => asNumber(reading.powerWatts, fallback))
    .filter((value) => Number.isFinite(value));

  if (values.length === 0) {
    return {
      min: fallback,
      max: fallback,
      mean: fallback,
      count: 0,
    };
  }

  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    count: values.length,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function stabilizeForecastPower(
  readings: Array<SensorReading & { parsedTime: Date }>,
  latestTime: Date,
  currentPower: number,
  rawPower: number,
  horizonMinutes: number
) {
  const stats = recentPowerStats(readings, latestTime, 15, currentPower);
  if (stats.count < 6) {
    return {
      power: rawPower,
      adjusted: false,
      stats,
    };
  }

  const lag5 = nearestPower(readings, new Date(latestTime.getTime() - 5 * 60_000), currentPower);
  const projectedFromRecentTrend = Math.max(0, currentPower + (currentPower - lag5) * (horizonMinutes / 5));
  const referencePower = Math.max(currentPower, stats.max, stats.mean, 0.1);
  const allowance = Math.max(1.5, referencePower * 0.25, horizonMinutes * 0.15);
  const upperLimit = Math.max(currentPower, stats.max, stats.mean) + allowance;
  const lowerLimit = Math.max(0, Math.min(currentPower, stats.min, stats.mean) - allowance);
  const outOfRecentRange = rawPower > upperLimit || rawPower < lowerLimit;

  if (!outOfRecentRange) {
    return {
      power: rawPower,
      adjusted: false,
      stats,
    };
  }

  return {
    power: clamp(projectedFromRecentTrend, lowerLimit, upperLimit),
    adjusted: true,
    stats,
  };
}

function cleanElectricalFlags(latest: SensorReading) {
  const powerWatts = asNumber(latest.powerWatts);
  const voltageAC = asNumber(latest.voltageAC);
  const currentAC = asNumber(latest.currentAC);
  const powerFactor = latest.powerFactor == null ? null : asNumber(latest.powerFactor);
  const frequencyHz = latest.frequencyHz == null ? null : asNumber(latest.frequencyHz);

  let powerFactorReliable = true;
  let powerFactorClean = powerFactor;
  if (powerWatts < 1 || currentAC < 0.01 || (currentAC === 0 && powerWatts > 0)) {
    powerFactorReliable = false;
    powerFactorClean = null;
  }
  if (powerFactorClean !== null && (powerFactorClean <= 0 || powerFactorClean > 1)) {
    powerFactorReliable = false;
    powerFactorClean = null;
  }
  if (powerFactor !== null && powerFactor === 1 && powerWatts < 5) {
    powerFactorReliable = false;
    powerFactorClean = null;
  }
  if (powerFactor !== null && powerFactor === 0 && powerWatts > 1) {
    powerFactorReliable = false;
    powerFactorClean = null;
  }

  const currentReliable = !((currentAC === 0 && powerWatts > 0.2) || currentAC < 0);
  const voltageReliable = voltageAC >= 180 && voltageAC <= 260;
  const frequencyReliable = frequencyHz === null || (frequencyHz >= 45 && frequencyHz <= 55);
  const electricalLowConfidence = !(powerFactorReliable && currentReliable && voltageReliable && frequencyReliable);

  return {
    powerFactorClean: powerFactorClean ?? 0,
    powerFactorReliable,
    currentReliable,
    voltageReliable,
    frequencyReliable,
    electricalLowConfidence,
  };
}

function buildFeatureVector(readings: Array<SensorReading & { parsedTime: Date }>, featureNames: string[]) {
  const latest = readings[readings.length - 1];
  const latestTime = latest.parsedTime;
  const powerWatts = asNumber(latest.powerWatts);
  const temperature = asNumber(latest.temperatureCelsius);
  const humidity = asNumber(latest.humidityPercent);
  const electrical = cleanElectricalFlags(latest);

  const minuteOfDay = latestTime.getHours() * 60 + latestTime.getMinutes() + latestTime.getSeconds() / 60;
  const radians = (2 * Math.PI * minuteOfDay) / 1440;

  const featureMap: Record<string, number> = {
    PowerWatts: powerWatts,
    VoltageAC: asNumber(latest.voltageAC),
    CurrentAC: asNumber(latest.currentAC),
    CurrentReliable: electrical.currentReliable ? 1 : 0,
    PowerFactorClean: electrical.powerFactorClean,
    PowerFactorReliable: electrical.powerFactorReliable ? 1 : 0,
    FrequencyHz: asNumber(latest.frequencyHz, 50),
    FrequencyReliable: electrical.frequencyReliable ? 1 : 0,
    TemperatureAtInstallC: temperature,
    HighTemperatureAtInstallFlag: temperature >= 55 ? 1 : 0,
    HumidityAtInstallPercent: humidity,
    Humidity100Flag: humidity === 100 ? 1 : 0,
    WindSpeedMs: asNumber(latest.windSpeedMs),
    PressureHpa: asNumber(latest.pressureHpa),
    VoltageReliable: electrical.voltageReliable ? 1 : 0,
    ElectricalLowConfidence: electrical.electricalLowConfidence ? 1 : 0,
    NearestImageDeltaSeconds: 0,
    ImageMatchReliable: 1,
    PowerLag1Min: nearestPower(readings, new Date(latestTime.getTime() - 60_000), powerWatts),
    PowerLag5Min: nearestPower(readings, new Date(latestTime.getTime() - 5 * 60_000), powerWatts),
    PowerLag15Min: nearestPower(readings, new Date(latestTime.getTime() - 15 * 60_000), powerWatts),
    PowerRollingMean5Min: rollingPowerMean(readings, latestTime, 5, powerWatts),
    PowerRollingMean15Min: rollingPowerMean(readings, latestTime, 15, powerWatts),
    MinuteOfDaySin: Math.sin(radians),
    MinuteOfDayCos: Math.cos(radians),
  };

  return {
    vector: featureNames.map((name) => featureMap[name] ?? 0),
    latest,
    currentPower: powerWatts,
    electrical,
  };
}

function predictHorizon(horizon: ModelHorizon, vector: number[]) {
  const intercept = horizon.coef[0] ?? 0;
  const prediction = vector.reduce((sum, value, index) => {
    const std = Math.abs(horizon.std[index] ?? 1) < EPSILON ? 1 : horizon.std[index] ?? 1;
    const scaled = (value - (horizon.mean[index] ?? 0)) / std;
    return sum + scaled * (horizon.coef[index + 1] ?? 0);
  }, intercept);

  return Math.max(0, prediction);
}

function trendFrom(currentPower: number, forecastPower: number): BaselineForecastItem["trend"] {
  if (forecastPower > currentPower + 0.2) return "up";
  if (forecastPower < currentPower - 0.2) return "down";
  return "flat";
}

export function getBaselinePowerForecast(readings: SensorReading[]): BaselineForecastResponse {
  try {
    const model = loadModel();
    const sorted = sortReadings(readings);
    if (sorted.length < 12) {
      return {
        items: [],
        modelType: model.modelType,
        trainedThrough: model.trainEndDate,
        generatedAt: new Date().toISOString(),
        sourceRows: sorted.length,
        latestReadingTime: sorted.at(-1)?.parsedTime.toISOString() ?? null,
        quality: {
          electricalLowConfidence: true,
          powerFactorReliable: false,
          currentReliable: false,
          note: "Not enough recent readings for baseline forecast.",
        },
        error: "Not enough recent readings for baseline forecast.",
      };
    }

    const { vector, latest, currentPower, electrical } = buildFeatureVector(sorted, model.featureNames);
    let rangeGuardApplied = false;
    let recentPowerMin: number | undefined;
    let recentPowerMax: number | undefined;

    const items = [5, 10, 15].map((horizonMinutes) => {
      const horizon = model.horizons[String(horizonMinutes)];
      const rawPower = horizon ? predictHorizon(horizon, vector) : currentPower;
      const guarded = stabilizeForecastPower(sorted, latest.parsedTime, currentPower, rawPower, horizonMinutes);
      rangeGuardApplied = rangeGuardApplied || guarded.adjusted;
      recentPowerMin = guarded.stats.count > 0 ? guarded.stats.min : recentPowerMin;
      recentPowerMax = guarded.stats.count > 0 ? guarded.stats.max : recentPowerMax;
      const confidencePenalty = (electrical.electricalLowConfidence ? 0.08 : 0) + (guarded.adjusted ? 0.28 : 0);
      const confidence = Math.max(0.5, Math.min(0.95, (HORIZON_CONFIDENCE[horizonMinutes] ?? 0.75) - confidencePenalty));

      return {
        time: `+${horizonMinutes} min`,
        horizonMinutes,
        power: Math.round(guarded.power * 10) / 10,
        confidence: Math.round(confidence * 100) / 100,
        trend: trendFrom(currentPower, guarded.power),
        model: guarded.adjusted ? "Ridge baseline (range guarded)" : "Ridge baseline",
        rawPower: Math.round(rawPower * 10) / 10,
        rangeAdjusted: guarded.adjusted,
      };
    });

    return {
      items,
      modelType: model.modelType,
      trainedThrough: model.trainEndDate,
      generatedAt: new Date().toISOString(),
      sourceRows: sorted.length,
      latestReadingTime: latest.parsedTime.toISOString(),
      quality: {
        electricalLowConfidence: electrical.electricalLowConfidence,
        powerFactorReliable: electrical.powerFactorReliable,
        currentReliable: electrical.currentReliable,
        rangeGuardApplied,
        recentPowerMin: recentPowerMin !== undefined ? Math.round(recentPowerMin * 10) / 10 : undefined,
        recentPowerMax: recentPowerMax !== undefined ? Math.round(recentPowerMax * 10) / 10 : undefined,
        note: rangeGuardApplied
          ? "Forecast was range-guarded because the raw model output jumped outside recent measured power."
          : electrical.electricalLowConfidence
            ? "Forecast is available, but electrical readings have low-confidence PF/current flags."
            : "Forecast uses the cleaned baseline model from the 2026-04-03 to 2026-04-18 dataset.",
      },
    };
  } catch (error) {
    return {
      items: [],
      modelType: "ridge_regression_numpy",
      trainedThrough: "",
      generatedAt: new Date().toISOString(),
      sourceRows: 0,
      latestReadingTime: null,
      quality: {
        electricalLowConfidence: true,
        powerFactorReliable: false,
        currentReliable: false,
        note: "Baseline forecast model could not be loaded.",
      },
      error: error instanceof Error ? error.message : "Unknown baseline forecast error",
    };
  }
}
