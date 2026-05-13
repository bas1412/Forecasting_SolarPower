type SensorMirrorPayload = {
  powerWatts: number;
  temperatureCelsius: number;
  humidityPercent: number;
  windSpeedMs: number;
  voltageAC?: number;
  currentAC?: number;
  energyKwh?: number;
  powerFactor?: number;
  pressureHpa?: number;
};

type ImageMirrorPayload = {
  imageUrl: string;
  fileKey: string;
  mimeType: string;
  fileSizeBytes?: number;
  cloudCoveragePercent?: number;
  cloudVectorData?: string | null;
  imageId?: number;
  cloudDetectionId?: number;
};

const RESEARCH_API_URL = process.env.FASTAPI_URL || "http://127.0.0.1:8010";
const MIRROR_TIMEOUT_MS = 5000;
const MIRROR_ENABLED = process.env.NODE_MIRROR_TO_FASTAPI === "true";

async function postJson(path: string, payload: unknown) {
  if (!MIRROR_ENABLED) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MIRROR_TIMEOUT_MS);

  try {
    const response = await fetch(`${RESEARCH_API_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText);
      console.warn(`[ResearchMirror] ${path} failed: ${response.status} ${body}`);
    }
  } catch (error) {
    console.warn(`[ResearchMirror] ${path} unavailable:`, error);
  } finally {
    clearTimeout(timeout);
  }
}

export function mirrorSensorReading(payload: SensorMirrorPayload) {
  void postJson("/ingest/sensor", payload);
}

export function mirrorImageRecord(payload: ImageMirrorPayload) {
  void postJson("/ingest/image", payload);
}
