from __future__ import annotations

import json
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import cv2
import numpy as np
from joblib import load


APP_TIMEZONE = os.getenv("APP_TIMEZONE", "Asia/Bangkok")
LOCAL_TZ = ZoneInfo(APP_TIMEZONE)
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_DIR = PROJECT_ROOT / "report-materials" / "aggregated-point-forecast-2026-04-02_to_2026-04-29-models"
DEFAULT_SUMMARY_PATH = PROJECT_ROOT / "report-materials" / "aggregated-point-forecast-2026-04-02_to_2026-04-29-summary.json"
MODEL_NAME = "aggregated-point"
VARIANT_NAME = ""
HORIZONS = [5, 10, 15]
MODEL_ACCURACY = {
    5: 0.868742,
    10: 0.841272,
    15: 0.825197,
}


def resolve_model_dir() -> Path:
    env_dir = os.getenv("RF_FORECAST_MODEL_DIR")
    candidates = [Path(env_dir)] if env_dir else []
    candidates.append(DEFAULT_MODEL_DIR)

    for candidate in candidates:
        if (candidate / f"{MODEL_NAME}-plus5min.joblib").exists():
            return candidate

    return candidates[0] if candidates else DEFAULT_MODEL_DIR


MODEL_DIR = resolve_model_dir()


def as_float(value: Any, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else default
    except (TypeError, ValueError):
        return default


def parse_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=LOCAL_TZ)
    return parsed.astimezone(LOCAL_TZ)


def sensor_time(sensor: dict[str, Any]) -> datetime | None:
    return parse_dt(sensor.get("timestamp") or sensor.get("readingTime"))


def image_time(image: dict[str, Any]) -> datetime | None:
    return parse_dt(image.get("timestamp") or image.get("captureTime") or image.get("createdAt"))


def sort_sensors(sensors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for sensor in sensors:
        dt = sensor_time(sensor)
        if dt is None:
            continue
        normalized.append({**sensor, "_dt": dt})
    return sorted(normalized, key=lambda item: item["_dt"])


def nearest_power(sensors: list[dict[str, Any]], target_dt: datetime, fallback: float) -> float:
    if not sensors:
        return fallback
    nearest = min(sensors, key=lambda sensor: abs((sensor["_dt"] - target_dt).total_seconds()))
    delta_seconds = abs((nearest["_dt"] - target_dt).total_seconds())
    return as_float(nearest.get("powerWatts"), fallback) if delta_seconds <= 90 else fallback


def rolling_power_mean(sensors: list[dict[str, Any]], latest_dt: datetime, window_minutes: int, fallback: float) -> float:
    start_dt = latest_dt - timedelta(minutes=window_minutes)
    values = [
        as_float(sensor.get("powerWatts"), fallback)
        for sensor in sensors
        if start_dt <= sensor["_dt"] <= latest_dt
    ]
    return sum(values) / len(values) if values else fallback


def recent_power_stats(sensors: list[dict[str, Any]], latest_dt: datetime, window_minutes: int, fallback: float) -> dict[str, float]:
    start_dt = latest_dt - timedelta(minutes=window_minutes)
    values = [
        as_float(sensor.get("powerWatts"), fallback)
        for sensor in sensors
        if start_dt <= sensor["_dt"] <= latest_dt
    ]
    values = [value for value in values if math.isfinite(value)]
    if not values:
        return {"min": fallback, "max": fallback, "mean": fallback, "count": 0.0}
    return {
        "min": min(values),
        "max": max(values),
        "mean": sum(values) / len(values),
        "count": float(len(values)),
    }


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def stabilize_forecast_power(
    sensors: list[dict[str, Any]],
    latest_dt: datetime,
    current_power: float,
    raw_power: float,
    horizon_minutes: int,
) -> dict[str, Any]:
    stats = recent_power_stats(sensors, latest_dt, 15, current_power)
    if stats["count"] < 6:
        return {"power": raw_power, "adjusted": False, "stats": stats}

    lag5 = nearest_power(sensors, latest_dt - timedelta(minutes=5), current_power)
    projected_from_recent_trend = max(0.0, current_power + (current_power - lag5) * (horizon_minutes / 5))
    reference_power = max(current_power, stats["max"], stats["mean"], 0.1)
    allowance = max(1.5, reference_power * 0.25, horizon_minutes * 0.15)
    upper_limit = max(current_power, stats["max"], stats["mean"]) + allowance
    lower_limit = max(0.0, min(current_power, stats["min"], stats["mean"]) - allowance)

    if lower_limit <= raw_power <= upper_limit:
        return {"power": raw_power, "adjusted": False, "stats": stats}

    return {
        "power": clamp(projected_from_recent_trend, lower_limit, upper_limit),
        "adjusted": True,
        "stats": stats,
    }


def clean_electrical_flags(sensor: dict[str, Any]) -> dict[str, Any]:
    power_watts = as_float(sensor.get("powerWatts"))
    voltage_ac = as_float(sensor.get("voltageAC"))
    current_ac = as_float(sensor.get("currentAC"))
    power_factor = None if sensor.get("powerFactor") is None else as_float(sensor.get("powerFactor"))
    frequency_hz = None if sensor.get("frequencyHz") is None else as_float(sensor.get("frequencyHz"))

    pf_reliable = True
    pf_clean = power_factor
    if power_watts < 1 or current_ac < 0.01 or (math.isclose(current_ac, 0.0) and power_watts > 0):
        pf_reliable = False
        pf_clean = None
    if pf_clean is not None and (pf_clean <= 0 or pf_clean > 1):
        pf_reliable = False
        pf_clean = None
    if power_factor is not None and math.isclose(power_factor, 1.0) and power_watts < 5:
        pf_reliable = False
        pf_clean = None
    if power_factor is not None and math.isclose(power_factor, 0.0) and power_watts > 1:
        pf_reliable = False
        pf_clean = None

    current_reliable = not ((math.isclose(current_ac, 0.0) and power_watts > 0.2) or current_ac < 0)
    voltage_reliable = 180 <= voltage_ac <= 260
    frequency_reliable = frequency_hz is None or 45 <= frequency_hz <= 55
    electrical_low_confidence = not (pf_reliable and current_reliable and voltage_reliable and frequency_reliable)

    return {
        "PowerFactorClean": pf_clean or 0.0,
        "PowerFactorReliable": 1 if pf_reliable else 0,
        "CurrentReliable": 1 if current_reliable else 0,
        "VoltageReliable": 1 if voltage_reliable else 0,
        "FrequencyReliable": 1 if frequency_reliable else 0,
        "ElectricalLowConfidence": 1 if electrical_low_confidence else 0,
        "powerFactorReliable": pf_reliable,
        "currentReliable": current_reliable,
        "electricalLowConfidence": electrical_low_confidence,
    }


def build_fixed_sky_mask(height: int, width: int) -> np.ndarray:
    mask = np.zeros((height, width), dtype=np.uint8)
    polygon = np.array(
        [
            (int(width * 0.02), int(height * 0.10)),
            (int(width * 0.98), int(height * 0.10)),
            (int(width * 0.99), int(height * 0.78)),
            (int(width * 0.02), int(height * 0.78)),
        ],
        dtype=np.int32,
    )
    cv2.fillPoly(mask, [polygon], 255)
    ellipse = np.zeros_like(mask)
    cv2.ellipse(
        ellipse,
        (int(width * 0.50), int(height * 0.43)),
        (int(width * 0.58), int(height * 0.50)),
        0,
        0,
        360,
        255,
        -1,
    )
    return cv2.bitwise_and(mask, ellipse)


def safe_percent(count: int | np.integer, total: int) -> float:
    return float(count) / total * 100 if total > 0 else 0.0


def resolve_image_path(upload_root: Path, image_doc: dict[str, Any] | None) -> Path | None:
    if not image_doc:
        return None
    file_key = str(image_doc.get("fileKey") or "").replace("\\", "/").lstrip("/")
    if file_key.startswith("uploads/"):
        file_key = file_key[len("uploads/") :]
    if file_key:
        return upload_root / file_key

    image_url = str(image_doc.get("imageUrl") or "").replace("\\", "/")
    marker = "/uploads/"
    if marker in image_url:
        return upload_root / image_url.split(marker, 1)[1].lstrip("/")
    return None


def extract_image_features(image_path: Path | None, analysis_width: int = 360) -> dict[str, float]:
    defaults = {
        "ImageReadable": 0.0,
        "CloudCoverageEstimatePercent": 0.0,
        "SkyBrightnessMean": 0.0,
        "SkySaturationMean": 0.0,
        "BlueSkyPercent": 0.0,
        "WhiteCloudPercent": 0.0,
        "GrayCloudPercent": 0.0,
        "OverexposedPercent": 0.0,
        "DarkPixelPercent": 0.0,
        "SunGlareFlag": 0.0,
        "BlurScoreLaplacianVar": 0.0,
        "ImageQualityScore": 0.0,
    }
    if image_path is None or not image_path.exists():
        return defaults

    original_image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if original_image is None:
        return defaults

    original_height, original_width = original_image.shape[:2]
    image = original_image
    if analysis_width > 0 and original_width > analysis_width:
        scale = analysis_width / original_width
        image = cv2.resize(
            original_image,
            (analysis_width, max(1, int(original_height * scale))),
            interpolation=cv2.INTER_AREA,
        )

    height, width = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blue_channel, _, red_channel = cv2.split(image)
    h_channel, s_channel, v_channel = cv2.split(hsv)
    fixed_mask = build_fixed_sky_mask(height, width)
    usable_mask = (fixed_mask > 0) & (v_channel > 35) & (gray > 30)
    total_fixed_pixels = int(np.count_nonzero(fixed_mask))
    sky_pixels = int(np.count_nonzero(usable_mask))
    if sky_pixels == 0:
        return {**defaults, "ImageReadable": 1.0}

    sky_h = h_channel[usable_mask]
    sky_s = s_channel[usable_mask]
    sky_v = v_channel[usable_mask]
    sky_gray = gray[usable_mask]
    blue_dominance = blue_channel.astype(np.int16) - red_channel.astype(np.int16)

    overexposed_mask = usable_mask & (v_channel >= 245) & (s_channel <= 45)
    dark_mask = (fixed_mask > 0) & (v_channel <= 45)
    blue_sky_mask = usable_mask & (blue_dominance >= 8) & (v_channel >= 70)
    white_cloud_mask = usable_mask & (blue_dominance < 8) & (s_channel <= 55) & (v_channel >= 120) & ~overexposed_mask
    gray_cloud_mask = usable_mask & (blue_dominance < 5) & (s_channel <= 80) & (v_channel >= 65) & (v_channel < 120)
    cloud_mask = white_cloud_mask | gray_cloud_mask

    overexposed_percent = safe_percent(np.count_nonzero(overexposed_mask), sky_pixels)
    dark_percent = safe_percent(np.count_nonzero(dark_mask), total_fixed_pixels)
    blur_score = float(cv2.Laplacian(sky_gray, cv2.CV_64F).var()) if sky_gray.size else 0.0
    overexposed_penalty = min(35.0, overexposed_percent * 1.25)
    dark_penalty = min(60.0, dark_percent * 0.90)
    blur_penalty = 20.0 if blur_score < 12 else 0.0
    low_pixel_penalty = 25.0 if sky_pixels < 10_000 else 0.0
    quality_score = max(0.0, min(100.0, 100.0 - overexposed_penalty - dark_penalty - blur_penalty - low_pixel_penalty))

    return {
        "ImageReadable": 1.0,
        "CloudCoverageEstimatePercent": safe_percent(np.count_nonzero(cloud_mask), sky_pixels),
        "SkyBrightnessMean": float(np.mean(sky_v)),
        "SkySaturationMean": float(np.mean(sky_s)),
        "BlueSkyPercent": safe_percent(np.count_nonzero(blue_sky_mask), sky_pixels),
        "WhiteCloudPercent": safe_percent(np.count_nonzero(white_cloud_mask), sky_pixels),
        "GrayCloudPercent": safe_percent(np.count_nonzero(gray_cloud_mask), sky_pixels),
        "OverexposedPercent": overexposed_percent,
        "DarkPixelPercent": dark_percent,
        "SunGlareFlag": 1.0 if overexposed_percent >= 3.0 else 0.0,
        "BlurScoreLaplacianVar": blur_score,
        "ImageQualityScore": quality_score,
    }


def add_sensor_features(feature_map: dict[str, float], sensors: list[dict[str, Any]]) -> dict[str, Any]:
    latest = sensors[-1]
    latest_dt = latest["_dt"]
    power_watts = as_float(latest.get("powerWatts"))
    temperature = as_float(latest.get("temperatureCelsius"))
    humidity = as_float(latest.get("humidityPercent"))
    electrical = clean_electrical_flags(latest)
    minute_of_day = latest_dt.hour * 60 + latest_dt.minute + latest_dt.second / 60
    radians = 2 * math.pi * minute_of_day / 1440

    feature_map.update(
        {
            "PowerWatts": power_watts,
            "VoltageAC": as_float(latest.get("voltageAC")),
            "CurrentAC": as_float(latest.get("currentAC")),
            "CurrentReliable": electrical["CurrentReliable"],
            "PowerFactorClean": electrical["PowerFactorClean"],
            "PowerFactorReliable": electrical["PowerFactorReliable"],
            "FrequencyHz": as_float(latest.get("frequencyHz"), 50.0),
            "FrequencyReliable": electrical["FrequencyReliable"],
            "TemperatureAtInstallC": temperature,
            "HighTemperatureAtInstallFlag": 1 if temperature >= 55 else 0,
            "HumidityAtInstallPercent": humidity,
            "Humidity100Flag": 1 if math.isclose(humidity, 100.0) else 0,
            "WindSpeedMs": as_float(latest.get("windSpeedMs")),
            "PressureHpa": as_float(latest.get("pressureHpa")),
            "VoltageReliable": electrical["VoltageReliable"],
            "ElectricalLowConfidence": electrical["ElectricalLowConfidence"],
            "NearestImageDeltaSeconds": 0.0,
            "ImageMatchReliable": 1.0,
            "PowerLag1Min": nearest_power(sensors, latest_dt - timedelta(minutes=1), power_watts),
            "PowerLag5Min": nearest_power(sensors, latest_dt - timedelta(minutes=5), power_watts),
            "PowerLag15Min": nearest_power(sensors, latest_dt - timedelta(minutes=15), power_watts),
            "PowerRollingMean5Min": rolling_power_mean(sensors, latest_dt, 5, power_watts),
            "PowerRollingMean15Min": rolling_power_mean(sensors, latest_dt, 15, power_watts),
            "MinuteOfDaySin": math.sin(radians),
            "MinuteOfDayCos": math.cos(radians),
        }
    )
    return {
        "latest": latest,
        "currentPower": power_watts,
        "electrical": electrical,
    }


def add_image_interactions(feature_map: dict[str, float]) -> None:
    cloud = feature_map.get("CloudCoverageEstimatePercent", 0.0) / 100.0
    blue = feature_map.get("BlueSkyPercent", 0.0) / 100.0
    overexposed = feature_map.get("OverexposedPercent", 0.0) / 100.0
    quality = feature_map.get("ImageQualityScore", 0.0) / 100.0
    brightness = feature_map.get("SkyBrightnessMean", 0.0) / 255.0
    sun_glare = feature_map.get("SunGlareFlag", 0.0)
    image_usable = 1.0 if feature_map.get("ImageReadable", 0.0) >= 1 and feature_map.get("ImageQualityScore", 0.0) >= 35 else 0.0

    feature_map.update(
        {
            "ImageUsableFlag": image_usable,
            "CloudClearFlag": 1.0 if image_usable and feature_map.get("CloudCoverageEstimatePercent", 0.0) < 25 else 0.0,
            "CloudPartlyFlag": 1.0 if image_usable and 25 <= feature_map.get("CloudCoverageEstimatePercent", 0.0) < 60 else 0.0,
            "CloudOvercastFlag": 1.0 if image_usable and feature_map.get("CloudCoverageEstimatePercent", 0.0) >= 60 else 0.0,
            "PowerCloudInteraction": feature_map["PowerWatts"] * cloud * image_usable,
            "PowerBlueSkyInteraction": feature_map["PowerWatts"] * blue * image_usable,
            "PowerOverexposedInteraction": feature_map["PowerWatts"] * overexposed * image_usable,
            "CloudTimeSinInteraction": cloud * feature_map.get("MinuteOfDaySin", 0.0) * image_usable,
            "CloudTimeCosInteraction": cloud * feature_map.get("MinuteOfDayCos", 0.0) * image_usable,
            "BrightnessTimeSinInteraction": brightness * feature_map.get("MinuteOfDaySin", 0.0) * image_usable,
            "BrightnessTimeCosInteraction": brightness * feature_map.get("MinuteOfDayCos", 0.0) * image_usable,
            "CloudQualityInteraction": cloud * quality * image_usable,
            "CloudGlareInteraction": cloud * sun_glare * image_usable,
        }
    )


def load_model_bundle(horizon: int) -> dict[str, Any]:
    suffix = f"-{VARIANT_NAME}" if VARIANT_NAME else ""
    model_path = MODEL_DIR / f"{MODEL_NAME}{suffix}-plus{horizon}min.joblib"
    return load(model_path)


def load_manifest() -> dict[str, Any]:
    manifest_path = Path(os.getenv("RF_FORECAST_SUMMARY_PATH", str(DEFAULT_SUMMARY_PATH)))
    if not manifest_path.exists():
        return {}
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def trend_from(current_power: float, forecast_power: float) -> str:
    if forecast_power > current_power + 0.2:
        return "up"
    if forecast_power < current_power - 0.2:
        return "down"
    return "flat"


def forecast_random_forest_latest(
    sensor_docs: list[dict[str, Any]],
    image_docs: list[dict[str, Any]],
    upload_root: Path,
) -> dict[str, Any]:
    sensors = sort_sensors(sensor_docs)
    if len(sensors) < 12:
        return {
            "success": False,
            "items": [],
            "error": "Not enough recent sensor readings for Random Forest forecast.",
            "sourceRows": len(sensors),
        }

    images_with_time = [
        {**image, "_dt": image_time(image)}
        for image in image_docs
        if image_time(image) is not None
    ]
    latest_sensor = sensors[-1]
    latest_sensor_dt = latest_sensor["_dt"]
    nearest_image = min(
        images_with_time,
        key=lambda image: abs((image["_dt"] - latest_sensor_dt).total_seconds()),
        default=None,
    )
    image_delta_seconds = (
        abs((nearest_image["_dt"] - latest_sensor_dt).total_seconds())
        if nearest_image is not None
        else None
    )
    image_path = resolve_image_path(upload_root, nearest_image)

    feature_map = extract_image_features(image_path)
    sensor_context = add_sensor_features(feature_map, sensors)
    feature_map["NearestImageDeltaSeconds"] = float(image_delta_seconds or 0.0)
    feature_map["ImageMatchReliable"] = 1.0 if image_delta_seconds is not None and image_delta_seconds <= 45 else 0.0
    add_image_interactions(feature_map)

    manifest = load_manifest()
    items = []
    range_guard_applied = False
    recent_power_min = None
    recent_power_max = None
    for horizon in HORIZONS:
        bundle = load_model_bundle(horizon)
        feature_names = bundle["featureNames"]
        vector = np.array([[as_float(feature_map.get(name), 0.0) for name in feature_names]], dtype=float)
        raw_forecast_power = max(0.0, float(bundle["model"].predict(vector)[0]))
        guarded = stabilize_forecast_power(
            sensors,
            latest_sensor_dt,
            sensor_context["currentPower"],
            raw_forecast_power,
            horizon,
        )
        forecast_power = guarded["power"]
        range_guard_applied = range_guard_applied or guarded["adjusted"]
        if guarded["stats"]["count"] > 0:
            recent_power_min = guarded["stats"]["min"]
            recent_power_max = guarded["stats"]["max"]
        confidence = max(0.5, MODEL_ACCURACY[horizon] - (0.28 if guarded["adjusted"] else 0.0))
        items.append(
            {
                "time": f"+{horizon} min",
                "horizonMinutes": horizon,
                "power": round(forecast_power, 1),
                "confidence": round(confidence, 2),
                "trend": trend_from(sensor_context["currentPower"], forecast_power),
                "model": "Random Forest + image (range guarded)" if guarded["adjusted"] else "Random Forest + image",
                "rawPower": round(raw_forecast_power, 1),
                "rangeAdjusted": guarded["adjusted"],
            }
        )

    return {
        "success": True,
        "items": items,
        "modelType": "random_forest_sensor_image_interactions",
        "modelDir": str(MODEL_DIR),
        "trainedThrough": manifest.get("trainEndDate", "2026-04-15"),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceRows": len(sensors),
        "currentPower": round(sensor_context["currentPower"], 4),
        "latestReadingTime": latest_sensor_dt.isoformat(),
        "latestImageTime": nearest_image["_dt"].isoformat() if nearest_image is not None else None,
        "nearestImageDeltaSeconds": image_delta_seconds,
        "imageFileKey": nearest_image.get("fileKey") if nearest_image is not None else None,
        "imageFeatures": {
            key: round(value, 4)
            for key, value in feature_map.items()
            if key
            in {
                "CloudCoverageEstimatePercent",
                "SkyBrightnessMean",
                "SkySaturationMean",
                "BlueSkyPercent",
                "OverexposedPercent",
                "SunGlareFlag",
                "ImageQualityScore",
            }
        },
        "quality": {
            "electricalLowConfidence": bool(sensor_context["electrical"]["electricalLowConfidence"]),
            "powerFactorReliable": bool(sensor_context["electrical"]["powerFactorReliable"]),
            "currentReliable": bool(sensor_context["electrical"]["currentReliable"]),
            "imageUsable": bool(feature_map.get("ImageUsableFlag", 0.0)),
            "rangeGuardApplied": bool(range_guard_applied),
            "recentPowerMin": round(recent_power_min, 1) if recent_power_min is not None else None,
            "recentPowerMax": round(recent_power_max, 1) if recent_power_max is not None else None,
            "note": (
                "Forecast was range-guarded because the raw model output jumped outside recent measured power."
                if range_guard_applied
                else "Random Forest forecast uses sensor readings plus OpenCV image interaction features."
            ),
        },
    }
