from __future__ import annotations

import json
import math
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from joblib import load


APP_TIMEZONE = "Asia/Bangkok"
LOCAL_TZ = ZoneInfo(APP_TIMEZONE)
PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = PROJECT_ROOT / "report-materials" / "stable-window-forecast-2026-04-02_to_2026-04-29-models"
SUMMARY_PATH = PROJECT_ROOT / "report-materials" / "stable-window-forecast-2026-04-02_to_2026-04-29-summary.json"

NUMERIC_COLUMNS = [
    "PowerWatts",
    "VoltageAC",
    "CurrentAC",
    "CurrentReliable",
    "PowerFactorClean",
    "PowerFactorReliable",
    "FrequencyHz",
    "FrequencyReliable",
    "TemperatureAtInstallC",
    "HighTemperatureAtInstallFlag",
    "HumidityAtInstallPercent",
    "Humidity100Flag",
    "WindSpeedMs",
    "VoltageReliable",
    "ElectricalLowConfidence",
]

FLAG_COLUMNS = [
    "CurrentReliable",
    "PowerFactorReliable",
    "FrequencyReliable",
    "HighTemperatureAtInstallFlag",
    "Humidity100Flag",
    "VoltageReliable",
    "ElectricalLowConfidence",
]

FEATURE_COLUMNS = [
    "PowerWatts",
    "VoltageAC",
    "CurrentAC",
    "CurrentReliable",
    "PowerFactorClean",
    "PowerFactorReliable",
    "FrequencyHz",
    "FrequencyReliable",
    "TemperatureAtInstallC",
    "HighTemperatureAtInstallFlag",
    "HumidityAtInstallPercent",
    "Humidity100Flag",
    "WindSpeedMs",
    "VoltageReliable",
    "ElectricalLowConfidence",
    "MinuteOfDaySin",
    "MinuteOfDayCos",
    "PowerLag5Min",
    "PowerLag10Min",
    "PowerLag15Min",
    "PowerLag30Min",
    "PowerLag60Min",
    "PowerRollingMean15Min",
    "PowerRollingMean30Min",
    "PowerRollingMean60Min",
]

TARGET_METADATA = {
    5: {"targetName": "Target5MinAvg", "label": "+5 min avg", "windowMinutes": 5},
    10: {"targetName": "Target10MinAvg", "label": "+10 min avg", "windowMinutes": 10},
    15: {"targetName": "Target15MinAvg", "label": "+15 min avg", "windowMinutes": 15},
}


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


def sort_sensors(sensor_docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for sensor in sensor_docs:
        dt = parse_dt(sensor.get("timestamp") or sensor.get("readingTime"))
        if dt is None:
            continue
        normalized.append({**sensor, "_dt": dt})
    return sorted(normalized, key=lambda item: item["_dt"])


def clean_electrical_flags(sensor: dict[str, Any]) -> dict[str, float]:
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

    current_reliable = not ((math.isclose(current_ac, 0.0) and power_watts > 0.2) or current_ac < 0)
    voltage_reliable = 180 <= voltage_ac <= 260
    frequency_reliable = frequency_hz is None or 45 <= frequency_hz <= 55
    electrical_low_confidence = not (pf_reliable and current_reliable and voltage_reliable and frequency_reliable)

    return {
        "PowerWatts": power_watts,
        "VoltageAC": voltage_ac,
        "CurrentAC": current_ac,
        "CurrentReliable": 1.0 if current_reliable else 0.0,
        "PowerFactorClean": pf_clean or 0.0,
        "PowerFactorReliable": 1.0 if pf_reliable else 0.0,
        "FrequencyHz": as_float(sensor.get("frequencyHz"), 50.0),
        "FrequencyReliable": 1.0 if frequency_reliable else 0.0,
        "VoltageReliable": 1.0 if voltage_reliable else 0.0,
        "ElectricalLowConfidence": 1.0 if electrical_low_confidence else 0.0,
    }


def load_summary() -> dict[str, Any]:
    if not SUMMARY_PATH.exists():
        return {}
    return json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))


SUMMARY = load_summary()


def build_feature_frame(sensor_docs: list[dict[str, Any]]) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for sensor in sensor_docs:
        dt = sensor["_dt"]
        electrical = clean_electrical_flags(sensor)
        rows.append(
            {
                "dt": dt,
                **electrical,
                "TemperatureAtInstallC": as_float(sensor.get("temperatureCelsius")),
                "HighTemperatureAtInstallFlag": 1.0 if as_float(sensor.get("temperatureCelsius")) >= 55 else 0.0,
                "HumidityAtInstallPercent": as_float(sensor.get("humidityPercent")),
                "Humidity100Flag": 1.0 if math.isclose(as_float(sensor.get("humidityPercent")), 100.0) else 0.0,
                "WindSpeedMs": as_float(sensor.get("windSpeedMs")),
            }
        )

    df = pd.DataFrame(rows).sort_values("dt").set_index("dt")
    agg = df[NUMERIC_COLUMNS].resample("5min").mean().interpolate(limit_direction="both")

    for column in FLAG_COLUMNS:
        agg[column] = (agg[column] >= 0.5).astype(int)

    minute_of_day = agg.index.hour * 60 + agg.index.minute
    radians = 2 * math.pi * minute_of_day / 1440.0
    agg["MinuteOfDaySin"] = np.sin(radians)
    agg["MinuteOfDayCos"] = np.cos(radians)

    for steps in [1, 2, 3, 6, 12]:
        agg[f"PowerLag{steps * 5}Min"] = agg["PowerWatts"].shift(steps)
    for steps in [3, 6, 12]:
        agg[f"PowerRollingMean{steps * 5}Min"] = agg["PowerWatts"].rolling(steps, min_periods=1).mean()

    return agg.dropna().reset_index()


def load_model_bundle(horizon: int) -> dict[str, Any]:
    return load(MODEL_DIR / f"stable-window-plus{horizon}min.joblib")


def trend_from(current_power: float, forecast_power: float) -> str:
    if forecast_power > current_power + 0.2:
        return "up"
    if forecast_power < current_power - 0.2:
        return "down"
    return "flat"


def forecast_stable_window_latest(sensor_docs: list[dict[str, Any]]) -> dict[str, Any]:
    sensors = sort_sensors(sensor_docs)
    if len(sensors) < 24:
        return {
            "success": False,
            "items": [],
            "error": "Not enough recent sensor readings for stable window forecast.",
            "sourceRows": len(sensors),
        }

    frame = build_feature_frame(sensors)
    if frame.empty:
        return {
            "success": False,
            "items": [],
            "error": "Could not build aggregated feature frame.",
            "sourceRows": len(sensors),
        }

    latest_row = frame.iloc[-1]
    latest_dt = latest_row["dt"]
    latest_vector = np.array([[float(latest_row[name]) for name in FEATURE_COLUMNS]], dtype=float)
    current_power = float(latest_row["PowerWatts"])

    items = []
    for horizon, meta in TARGET_METADATA.items():
        bundle = load_model_bundle(horizon)
        raw_power = max(0.0, float(bundle["model"].predict(latest_vector)[0]))
        accuracy = (
            as_float(
                SUMMARY.get("horizons", {})
                .get(str(horizon), {})
                .get("extraTrees", {})
                .get("accuracyPercent"),
                0.0,
            )
            / 100.0
        )
        window_end = latest_dt + timedelta(minutes=horizon)
        items.append(
            {
                "time": meta["label"],
                "horizonMinutes": horizon,
                "power": round(raw_power, 1),
                "confidence": round(accuracy, 2),
                "trend": trend_from(current_power, raw_power),
                "model": "Stable ExtraTrees 5-min window",
                "rawPower": round(raw_power, 4),
                "windowMinutes": meta["windowMinutes"],
                "windowEndTime": window_end.isoformat(),
            }
        )

    return {
        "success": True,
        "items": items,
        "modelType": "stable_window_forecast_extratrees",
        "trainedThrough": SUMMARY.get("trainEndDate"),
        "generatedAt": datetime.now(tz=LOCAL_TZ).isoformat(),
        "sourceRows": len(sensors),
        "aggregation": "5min",
        "targetDefinition": "future_window_average",
        "currentPower": round(current_power, 4),
        "latestReadingTime": latest_dt.isoformat(),
        "quality": {
            "electricalLowConfidence": bool(int(latest_row["ElectricalLowConfidence"])),
            "currentReliable": bool(int(latest_row["CurrentReliable"])),
            "powerFactorReliable": bool(int(latest_row["PowerFactorReliable"])),
            "note": "This forecast uses 5-minute aggregated sensor data and predicts future-window averages for stability.",
        },
    }
