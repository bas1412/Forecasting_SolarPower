from __future__ import annotations

import base64
import asyncio
import hashlib
import json
import os
import pickle
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .random_forest_forecast import MODEL_DIR as RF_MODEL_DIR
from .random_forest_forecast import forecast_random_forest_latest
from .stable_window_forecast import MODEL_DIR as STABLE_WINDOW_MODEL_DIR
from .stable_window_forecast import forecast_stable_window_latest
from .cloud_vector_ml import infer_cloud_vector_json

try:
    from elasticsearch import Elasticsearch
except ImportError:
    Elasticsearch = None


APP_ROOT = Path(__file__).resolve().parent
DATA_ROOT = APP_ROOT / "data"
DATA_ROOT.mkdir(parents=True, exist_ok=True)
UPLOAD_ROOT = APP_ROOT.parent / "uploaded-images"
UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
FASTAPI_IMAGE_DIR = UPLOAD_ROOT / "fastapi-direct"
FASTAPI_IMAGE_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_ELASTICSEARCH_URL = "http://127.0.0.1:9200"
SENSOR_INDEX = os.getenv("ELASTICSEARCH_SENSOR_INDEX", "solar-sensor-readings")
IMAGE_INDEX = os.getenv("ELASTICSEARCH_IMAGE_INDEX", "solar-sky-images")
PREDICTION_INDEX = os.getenv("ELASTICSEARCH_PREDICTION_INDEX", "solar-forecast-predictions")
MODEL_PATH = Path(os.getenv("FORECAST_MODEL_PATH", str(APP_ROOT.parent / "forecast_model.pkl")))
APP_TIMEZONE = os.getenv("APP_TIMEZONE", "Asia/Bangkok")
LOCAL_TZ = ZoneInfo(APP_TIMEZONE)
FORECAST_AUTO_LOG_SECONDS = int(os.getenv("FORECAST_AUTO_LOG_SECONDS", "60"))
FORECAST_MATCH_TOLERANCE_SECONDS = int(os.getenv("FORECAST_MATCH_TOLERANCE_SECONDS", "90"))

app = FastAPI(title="Solar Research API", version="1.0.0")
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_ROOT)), name="uploads")


class SensorIngest(BaseModel):
    powerWatts: float
    temperatureCelsius: float
    humidityPercent: int
    windSpeedMs: float
    voltageAC: float | None = None
    currentAC: float | None = None
    frequencyHz: float | None = None
    energyKwh: float | None = None
    powerFactor: float | None = None
    pressureHpa: float | None = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class ImageIngest(BaseModel):
    imageUrl: str
    fileKey: str
    mimeType: str
    fileSizeBytes: int | None = None
    cloudCoveragePercent: int | None = None
    cloudVectorData: str | None = None
    imageId: int | None = None
    cloudDetectionId: int | None = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class DirectImageIngest(BaseModel):
    imageData: str
    mimeType: str = "image/jpeg"
    cloudCoveragePercent: int | None = None
    cloudVectorData: str | None = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class ForecastFeatures(BaseModel):
    powerWatts: float
    voltageAC: float | None = None
    currentAC: float | None = None
    windSpeedMs: float
    temperatureCelsius: float
    humidityPercent: int
    pressureHpa: float | None = None
    energyKwh: float | None = None
    cloudCoveragePercent: float | None = None
    hour: int
    minute: int
    day_of_week: int
    power_ma_1min: float
    power_ma_5min: float
    cloud_ma_5min: float
    wind_ma_1min: float
    power_lag_1: float
    power_lag_12: float
    cloud_lag_1: float
    cloud_lag_12: float


def get_elasticsearch_url() -> str:
    return os.getenv("ELASTICSEARCH_URL", DEFAULT_ELASTICSEARCH_URL).strip()


def get_es_client():
    elasticsearch_url = get_elasticsearch_url()
    if not elasticsearch_url or Elasticsearch is None:
        return None
    return Elasticsearch(
        elasticsearch_url,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
        },
    )


def ensure_indices():
    client = get_es_client()
    if client is None:
        return False

    sensor_mapping = {
        "mappings": {
            "properties": {
                "timestamp": {"type": "date"},
                "powerWatts": {"type": "float"},
                "temperatureCelsius": {"type": "float"},
                "humidityPercent": {"type": "integer"},
                "windSpeedMs": {"type": "float"},
                "voltageAC": {"type": "float"},
                "currentAC": {"type": "float"},
                "frequencyHz": {"type": "float"},
                "energyKwh": {"type": "float"},
                "powerFactor": {"type": "float"},
                "pressureHpa": {"type": "float"},
            }
        }
    }
    image_mapping = {
        "mappings": {
            "properties": {
                "timestamp": {"type": "date"},
                "imageUrl": {"type": "keyword"},
                "fileKey": {"type": "keyword"},
                "mimeType": {"type": "keyword"},
                "fileSizeBytes": {"type": "integer"},
                "cloudCoveragePercent": {"type": "integer"},
                "cloudVectorData": {"type": "text"},
                "imageId": {"type": "integer"},
                "cloudDetectionId": {"type": "integer"},
            }
        }
    }
    prediction_mapping = {
        "mappings": {
            "properties": {
                "timestamp": {"type": "date"},
                "predictionId": {"type": "keyword"},
                "predictionTime": {"type": "date"},
                "targetTime": {"type": "date"},
                "latestReadingTime": {"type": "date"},
                "latestImageTime": {"type": "date"},
                "horizonMinutes": {"type": "integer"},
                "predictedPowerWatts": {"type": "float"},
                "actualPowerWatts": {"type": "float"},
                "actualReadingTime": {"type": "date"},
                "absoluteErrorWatts": {"type": "float"},
                "accuracyPercent": {"type": "float"},
                "confidence": {"type": "float"},
                "trend": {"type": "keyword"},
                "status": {"type": "keyword"},
                "modelName": {"type": "keyword"},
                "modelType": {"type": "keyword"},
                "modelVersion": {"type": "keyword"},
                "trainedThrough": {"type": "keyword"},
                "sourceRows": {"type": "integer"},
                "currentPowerWatts": {"type": "float"},
                "nearestImageDeltaSeconds": {"type": "float"},
                "electricalLowConfidence": {"type": "boolean"},
                "powerFactorReliable": {"type": "boolean"},
                "currentReliable": {"type": "boolean"},
                "imageUsable": {"type": "boolean"},
                "imageFileKey": {"type": "keyword"},
                "imageFeatures": {"type": "object", "enabled": True},
                "matchedAt": {"type": "date"},
            }
        }
    }

    try:
        client.options(ignore_status=[400]).indices.create(
            index=SENSOR_INDEX,
            mappings=sensor_mapping["mappings"],
        )
        client.options(ignore_status=[400]).indices.create(
            index=IMAGE_INDEX,
            mappings=image_mapping["mappings"],
        )
        client.options(ignore_status=[400]).indices.create(
            index=PREDICTION_INDEX,
            mappings=prediction_mapping["mappings"],
        )
    except Exception as error:
        print(f"[FastAPI] Elasticsearch index setup warning: {error}")
        return False
    return True


def append_jsonl(file_name: str, payload: dict[str, Any]):
    output_path = DATA_ROOT / file_name
    with output_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=True) + "\n")


def get_file_extension(mime_type: str) -> str:
    return {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    }.get(mime_type, ".jpg")


def save_direct_image(payload: DirectImageIngest) -> dict[str, Any]:
    image_data = payload.imageData
    if "," in image_data and image_data.startswith("data:"):
        image_data = image_data.split(",", 1)[1]

    image_bytes = base64.b64decode(image_data)
    extension = get_file_extension(payload.mimeType)
    timestamp_slug = payload.timestamp.strftime("%Y-%m-%dT%H-%M-%S-%fZ")
    file_name = f"{timestamp_slug}-{secrets.token_urlsafe(6)}{extension}"
    file_path = FASTAPI_IMAGE_DIR / file_name
    file_path.write_bytes(image_bytes)

    file_key = f"fastapi-direct/{file_name}"
    cloud_coverage_percent = payload.cloudCoveragePercent
    cloud_vector_data = payload.cloudVectorData

    try:
        cloud_coverage_percent, cloud_vector_data = infer_cloud_vector_json(
            image_bytes,
            image_name=file_name,
        )
    except Exception as error:
        print(f"[FastAPI] cloud vector inference fallback: {error}")

    return {
        "imageUrl": f"/uploads/{file_key}",
        "fileKey": file_key,
        "mimeType": payload.mimeType,
        "fileSizeBytes": len(image_bytes),
        "cloudCoveragePercent": cloud_coverage_percent,
        "cloudVectorData": cloud_vector_data,
        "timestamp": payload.timestamp.isoformat(),
    }


def index_or_fallback(index_name: str, payload: dict[str, Any], fallback_file: str):
    client = get_es_client()
    if client is not None:
        client.index(index=index_name, document=payload)
    else:
        append_jsonl(fallback_file, payload)


def load_recent_jsonl(file_name: str, limit: int = 10):
    output_path = DATA_ROOT / file_name
    if not output_path.exists():
        return []

    lines = output_path.read_text(encoding="utf-8").splitlines()
    records = [json.loads(line) for line in lines[-limit:] if line.strip()]
    return list(reversed(records))


def normalize_dt(value: Any) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            return value.astimezone().replace(tzinfo=None)
        return value.replace(tzinfo=timezone.utc).astimezone(LOCAL_TZ).replace(tzinfo=None)
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            return parsed.astimezone().replace(tzinfo=None)
        return parsed.replace(tzinfo=timezone.utc).astimezone(LOCAL_TZ).replace(tzinfo=None)
    return datetime.min


def format_local_iso(value: Any) -> str:
    local_dt = normalize_dt(value)
    return local_dt.replace(tzinfo=LOCAL_TZ).isoformat()


def format_query_iso(value: datetime) -> str:
    local_dt = normalize_dt(value)
    return local_dt.replace(tzinfo=LOCAL_TZ).isoformat()


def serialize_sensor_document(item: dict[str, Any]) -> dict[str, Any]:
    document = dict(item)
    if document.get("timestamp"):
        document["timestamp"] = format_local_iso(document["timestamp"])
    return document


def serialize_image_document(item: dict[str, Any]) -> dict[str, Any]:
    document = dict(item)
    if document.get("timestamp"):
        document["timestamp"] = format_local_iso(document["timestamp"])
    if document.get("captureTime"):
        document["captureTime"] = format_local_iso(document["captureTime"])
    if document.get("createdAt"):
        document["createdAt"] = format_local_iso(document["createdAt"])
    return document


def dedupe_sensor_documents(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()

    for item in items:
        timestamp = item.get("timestamp")
        rounded_ts = normalize_dt(timestamp).replace(microsecond=0).isoformat() if timestamp else "no-ts"
        signature = "|".join(
            [
                rounded_ts,
                str(item.get("powerWatts", "")),
                str(item.get("temperatureCelsius", "")),
                str(item.get("humidityPercent", "")),
                str(item.get("windSpeedMs", "")),
                str(item.get("voltageAC", "")),
                str(item.get("currentAC", "")),
                str(item.get("powerFactor", "")),
                str(item.get("pressureHpa", "")),
            ]
        )
        if signature in seen:
            continue
        seen.add(signature)
        deduped.append(item)

    return deduped


def dedupe_image_documents(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()

    for item in items:
        timestamp = item.get("timestamp")
        rounded_ts = normalize_dt(timestamp).replace(microsecond=0).isoformat() if timestamp else "no-ts"
        signature = "|".join(
            [
                rounded_ts,
                str(item.get("cloudCoveragePercent", "")),
                str(item.get("mimeType", "")),
            ]
        )
        if signature in seen:
            continue
        seen.add(signature)
        deduped.append(item)

    return deduped


def filter_by_time_range(
    items: list[dict[str, Any]],
    start_date: datetime | None = None,
    end_date: datetime | None = None,
) -> list[dict[str, Any]]:
    normalized_start = normalize_dt(start_date) if start_date else None
    normalized_end = normalize_dt(end_date) if end_date else None

    if start_date is None and end_date is None:
        return items

    filtered: list[dict[str, Any]] = []
    for item in items:
        timestamp = item.get("timestamp")
        if not timestamp:
            continue
        dt = normalize_dt(timestamp)
        if normalized_start and dt < normalized_start:
            continue
        if normalized_end and dt >= normalized_end:
            continue
        filtered.append(item)
    return filtered


def search_index_documents(
    index_name: str,
    limit: int,
    offset: int = 0,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
) -> list[dict[str, Any]]:
    client = get_es_client()
    if client is None:
        return []

    query: dict[str, Any] = {"match_all": {}}
    if start_date or end_date:
        range_query: dict[str, Any] = {}
        if start_date:
            range_query["gte"] = format_query_iso(start_date)
        if end_date:
            range_query["lt"] = format_query_iso(end_date)
        query = {"range": {"timestamp": range_query}}

    target_size = max(limit + offset + 250, 250)
    batch_size = min(target_size, 5000)

    response = client.search(
        index=index_name,
        size=batch_size,
        sort=[{"timestamp": {"order": "desc"}}],
        query=query,
        scroll="1m",
    )

    hits = [item["_source"] for item in response["hits"]["hits"]]
    scroll_id = response.get("_scroll_id")

    while len(hits) < target_size and response["hits"]["hits"]:
        response = client.scroll(scroll_id=scroll_id, scroll="1m")
        scroll_id = response.get("_scroll_id")
        hits.extend(item["_source"] for item in response["hits"]["hits"])

    if scroll_id:
        try:
            client.clear_scroll(scroll_id=scroll_id)
        except Exception:
            pass

    return hits


def get_sensor_documents(
    limit: int = 100,
    offset: int = 0,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
) -> list[dict[str, Any]]:
    client = get_es_client()
    if client is not None:
        raw_items = search_index_documents(
            SENSOR_INDEX,
            limit=limit,
            offset=offset,
            start_date=start_date,
            end_date=end_date,
        )
    else:
        raw_items = load_recent_jsonl("sensor_readings.jsonl", limit + offset + 250)

    filtered = filter_by_time_range(raw_items, start_date, end_date)
    deduped = dedupe_sensor_documents(filtered)
    return [serialize_sensor_document(item) for item in deduped[offset : offset + limit]]


def get_image_documents(
  limit: int = 20,
  offset: int = 0,
  start_date: datetime | None = None,
  end_date: datetime | None = None,
) -> list[dict[str, Any]]:
    client = get_es_client()
    if client is not None:
        raw_items = search_index_documents(
            IMAGE_INDEX,
            limit=limit,
            offset=offset,
            start_date=start_date,
            end_date=end_date,
        )
    else:
        raw_items = load_recent_jsonl("image_records.jsonl", limit + offset + 250)

    filtered = filter_by_time_range(raw_items, start_date, end_date)
    deduped = dedupe_image_documents(filtered)
    return [serialize_image_document(item) for item in deduped[offset : offset + limit]]


def parse_local_aware(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=LOCAL_TZ)
    return parsed.astimezone(LOCAL_TZ)


def local_iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=LOCAL_TZ)
    return value.astimezone(LOCAL_TZ).isoformat()


def build_random_forest_forecast(hours_back: int = 2) -> dict[str, Any]:
    latest_items = get_sensor_documents(limit=1, offset=0)
    if not latest_items:
        return {
            "success": False,
            "items": [],
            "error": "No sensor data available",
            "sourceRows": 0,
        }

    latest_timestamp = latest_items[0].get("timestamp")
    latest_dt = parse_local_aware(latest_timestamp) or datetime.now(tz=LOCAL_TZ)
    bounded_hours_back = max(1, min(hours_back, 24))
    start_date = latest_dt - timedelta(hours=bounded_hours_back)
    end_date = latest_dt + timedelta(seconds=1)
    sensor_batch = get_sensor_documents(limit=5000, offset=0)
    image_batch = get_image_documents(limit=1000, offset=0)
    sensor_items = [
        item
        for item in sensor_batch
        if (item_dt := parse_local_aware(item.get("timestamp"))) is not None and start_date <= item_dt <= end_date
    ]
    image_items = [
        item
        for item in image_batch
        if (item_dt := parse_local_aware(item.get("timestamp") or item.get("captureTime") or item.get("createdAt"))) is not None
        and start_date <= item_dt <= end_date
    ]
    return forecast_random_forest_latest(sensor_items, image_items, UPLOAD_ROOT)


def build_stable_window_forecast(hours_back: int = 24) -> dict[str, Any]:
    latest_items = get_sensor_documents(limit=1, offset=0)
    if not latest_items:
        return {
            "success": False,
            "items": [],
            "error": "No sensor data available",
            "sourceRows": 0,
        }

    latest_timestamp = latest_items[0].get("timestamp")
    latest_dt = parse_local_aware(latest_timestamp) or datetime.now(tz=LOCAL_TZ)
    bounded_hours_back = max(4, min(hours_back, 72))
    start_date = latest_dt - timedelta(hours=bounded_hours_back)
    end_date = latest_dt + timedelta(seconds=1)
    sensor_batch = get_sensor_documents(limit=12000, offset=0)
    sensor_items = [
        item
        for item in sensor_batch
        if (item_dt := parse_local_aware(item.get("timestamp"))) is not None and start_date <= item_dt <= end_date
    ]
    return forecast_stable_window_latest(sensor_items)


def forecast_prediction_id(model_type: str, latest_reading_time: str, horizon_minutes: int) -> str:
    raw = f"{model_type}|{latest_reading_time}|{horizon_minutes}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def create_prediction_record(forecast_result: dict[str, Any], item: dict[str, Any]) -> dict[str, Any] | None:
    latest_reading_dt = parse_local_aware(forecast_result.get("latestReadingTime"))
    if latest_reading_dt is None:
        return None

    horizon_minutes = int(item.get("horizonMinutes") or 0)
    target_dt = latest_reading_dt + timedelta(minutes=horizon_minutes)
    prediction_dt = parse_local_aware(forecast_result.get("generatedAt")) or datetime.now(tz=LOCAL_TZ)
    model_type = str(forecast_result.get("modelType") or "random_forest_sensor_image_interactions")
    trained_through = str(forecast_result.get("trainedThrough") or "")
    prediction_id = forecast_prediction_id(model_type, local_iso(latest_reading_dt), horizon_minutes)
    quality = forecast_result.get("quality") or {}

    return {
        "timestamp": local_iso(prediction_dt),
        "predictionId": prediction_id,
        "predictionTime": local_iso(prediction_dt),
        "targetTime": local_iso(target_dt),
        "latestReadingTime": local_iso(latest_reading_dt),
        "latestImageTime": forecast_result.get("latestImageTime"),
        "horizonMinutes": horizon_minutes,
        "predictedPowerWatts": float(item.get("power") or 0.0),
        "actualPowerWatts": None,
        "actualReadingTime": None,
        "absoluteErrorWatts": None,
        "accuracyPercent": None,
        "confidence": float(item.get("confidence") or 0.0),
        "trend": item.get("trend") or "flat",
        "status": "pending",
        "modelName": item.get("model") or "Random Forest + image",
        "modelType": model_type,
        "modelVersion": f"{model_type}:{trained_through}",
        "trainedThrough": trained_through,
        "sourceRows": int(forecast_result.get("sourceRows") or 0),
        "currentPowerWatts": float(forecast_result.get("currentPower") or 0.0),
        "nearestImageDeltaSeconds": forecast_result.get("nearestImageDeltaSeconds"),
        "electricalLowConfidence": bool(quality.get("electricalLowConfidence")),
        "powerFactorReliable": bool(quality.get("powerFactorReliable")),
        "currentReliable": bool(quality.get("currentReliable")),
        "imageUsable": bool(quality.get("imageUsable")),
        "imageFileKey": forecast_result.get("imageFileKey"),
        "imageFeatures": forecast_result.get("imageFeatures") or {},
        "matchedAt": None,
    }


def append_jsonl_once(file_name: str, key_name: str, record: dict[str, Any]) -> bool:
    output_path = DATA_ROOT / file_name
    record_key = record.get(key_name)
    if output_path.exists() and record_key:
        for line in output_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                existing = json.loads(line)
            except json.JSONDecodeError:
                continue
            if existing.get(key_name) == record_key:
                return False
    append_jsonl(file_name, record)
    return True


def update_jsonl_record(file_name: str, key_name: str, record: dict[str, Any]) -> None:
    output_path = DATA_ROOT / file_name
    if not output_path.exists():
        append_jsonl(file_name, record)
        return

    lines = output_path.read_text(encoding="utf-8").splitlines()
    updated = False
    next_lines: list[str] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            existing = json.loads(line)
        except json.JSONDecodeError:
            next_lines.append(line)
            continue
        if existing.get(key_name) == record.get(key_name):
            next_lines.append(json.dumps(record, ensure_ascii=True))
            updated = True
        else:
            next_lines.append(json.dumps(existing, ensure_ascii=True))

    if not updated:
        next_lines.append(json.dumps(record, ensure_ascii=True))
    output_path.write_text("\n".join(next_lines) + "\n", encoding="utf-8")


def log_forecast_predictions(forecast_result: dict[str, Any]) -> dict[str, Any]:
    if not forecast_result.get("success") or not forecast_result.get("items"):
        return {"saved": 0, "skipped": 0, "reason": "forecast unavailable"}

    client = get_es_client()
    saved = 0
    skipped = 0
    for item in forecast_result["items"]:
        record = create_prediction_record(forecast_result, item)
        if record is None:
            skipped += 1
            continue

        if client is not None:
            try:
                client.index(
                    index=PREDICTION_INDEX,
                    id=record["predictionId"],
                    document=record,
                    op_type="create",
                )
                saved += 1
            except Exception as error:
                if "version_conflict" in str(error).lower() or "409" in str(error):
                    skipped += 1
                else:
                    print(f"[FastAPI] Prediction log warning: {error}")
                    skipped += 1
        else:
            if append_jsonl_once("forecast_predictions.jsonl", "predictionId", record):
                saved += 1
            else:
                skipped += 1

    return {"saved": saved, "skipped": skipped, "index": PREDICTION_INDEX}


def serialize_prediction_document(item: dict[str, Any]) -> dict[str, Any]:
    document = dict(item)
    for key in ["timestamp", "predictionTime", "targetTime", "latestReadingTime", "latestImageTime", "actualReadingTime", "matchedAt"]:
        if document.get(key):
            document[key] = format_local_iso(document[key])
    return document


def get_prediction_documents(
    limit: int = 100,
    offset: int = 0,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    client = get_es_client()
    if client is not None:
        filters: list[dict[str, Any]] = []
        if start_date or end_date:
            range_query: dict[str, Any] = {}
            if start_date:
                range_query["gte"] = format_query_iso(start_date)
            if end_date:
                range_query["lt"] = format_query_iso(end_date)
            filters.append({"range": {"targetTime": range_query}})
        if status:
            filters.append({"term": {"status": status}})

        query: dict[str, Any] = {"match_all": {}}
        if filters:
            query = {"bool": {"filter": filters}}

        response = client.search(
            index=PREDICTION_INDEX,
            size=max(1, min(limit, 5000)),
            from_=offset,
            sort=[{"targetTime": {"order": "desc"}}],
            query=query,
        )
        return [serialize_prediction_document(item["_source"]) for item in response["hits"]["hits"]]

    raw_items = load_recent_jsonl("forecast_predictions.jsonl", limit + offset + 250)
    filtered: list[dict[str, Any]] = []
    normalized_start = normalize_dt(start_date) if start_date else None
    normalized_end = normalize_dt(end_date) if end_date else None
    for item in raw_items:
        target_dt = parse_local_aware(item.get("targetTime"))
        if target_dt is None:
            continue
        if normalized_start and target_dt.replace(tzinfo=None) < normalized_start:
            continue
        if normalized_end and target_dt.replace(tzinfo=None) >= normalized_end:
            continue
        if status and item.get("status") != status:
            continue
        filtered.append(item)
    filtered.sort(key=lambda row: row.get("targetTime", ""), reverse=True)
    return [serialize_prediction_document(item) for item in filtered[offset : offset + limit]]


def find_actual_power_at(target_dt: datetime, tolerance_seconds: int) -> dict[str, Any] | None:
    start_dt = target_dt - timedelta(seconds=tolerance_seconds)
    end_dt = target_dt + timedelta(seconds=tolerance_seconds)
    candidates = get_sensor_documents(limit=500, offset=0, start_date=start_dt, end_date=end_dt)
    if not candidates:
        return None

    with_times = [
        {**candidate, "_dt": parse_local_aware(candidate.get("timestamp"))}
        for candidate in candidates
        if parse_local_aware(candidate.get("timestamp")) is not None
    ]
    if not with_times:
        return None
    nearest = min(with_times, key=lambda row: abs((row["_dt"] - target_dt).total_seconds()))
    delta_seconds = abs((nearest["_dt"] - target_dt).total_seconds())
    if delta_seconds > tolerance_seconds:
        return None
    return nearest


def save_matched_prediction(record: dict[str, Any]) -> None:
    client = get_es_client()
    if client is not None:
        client.index(
            index=PREDICTION_INDEX,
            id=record["predictionId"],
            document=record,
        )
        return
    update_jsonl_record("forecast_predictions.jsonl", "predictionId", record)


def match_pending_predictions(
    max_age_hours: int = 24,
    tolerance_seconds: int = FORECAST_MATCH_TOLERANCE_SECONDS,
    limit: int = 500,
) -> dict[str, Any]:
    now_dt = datetime.now(tz=LOCAL_TZ)
    start_dt = now_dt - timedelta(hours=max(1, max_age_hours))
    pending = get_prediction_documents(
        limit=limit,
        offset=0,
        start_date=start_dt,
        end_date=now_dt,
        status="pending",
    )

    matched = 0
    waiting = 0
    missing_actual = 0
    for record in pending:
        target_dt = parse_local_aware(record.get("targetTime"))
        if target_dt is None:
            missing_actual += 1
            continue
        if target_dt > now_dt - timedelta(seconds=tolerance_seconds):
            waiting += 1
            continue

        actual = find_actual_power_at(target_dt, tolerance_seconds)
        if actual is None:
            missing_actual += 1
            continue

        actual_power = float(actual.get("powerWatts") or 0.0)
        predicted_power = float(record.get("predictedPowerWatts") or 0.0)
        absolute_error = abs(predicted_power - actual_power)
        denominator = max(abs(actual_power), abs(predicted_power), 1.0)
        accuracy_percent = max(0.0, min(100.0, (1.0 - absolute_error / denominator) * 100.0))

        record.update(
            {
                "actualPowerWatts": round(actual_power, 4),
                "actualReadingTime": local_iso(actual["_dt"]),
                "absoluteErrorWatts": round(absolute_error, 4),
                "accuracyPercent": round(accuracy_percent, 4),
                "status": "matched",
                "matchedAt": local_iso(now_dt),
            }
        )
        save_matched_prediction(record)
        matched += 1

    return {
        "checked": len(pending),
        "matched": matched,
        "waiting": waiting,
        "missingActual": missing_actual,
        "toleranceSeconds": tolerance_seconds,
    }


async def forecast_autolog_loop() -> None:
    await asyncio.sleep(10)
    while True:
        try:
            forecast_result = build_random_forest_forecast(hours_back=2)
            log_summary = log_forecast_predictions(forecast_result)
            match_summary = match_pending_predictions()
            if log_summary.get("saved") or match_summary.get("matched"):
                print(f"[FastAPI] Forecast autolog saved={log_summary.get('saved', 0)} matched={match_summary.get('matched', 0)}")
        except Exception as error:
            print(f"[FastAPI] Forecast autolog warning: {error}")
        await asyncio.sleep(max(30, FORECAST_AUTO_LOG_SECONDS))


@app.on_event("startup")
async def startup_event():
    ensure_indices()
    asyncio.create_task(forecast_autolog_loop())


@app.get("/health")
def health():
    client = get_es_client()
    elasticsearch_reachable = False
    elasticsearch_error = None
    if client is not None:
        try:
            client.info()
            elasticsearch_reachable = True
        except Exception as error:
            elasticsearch_reachable = False
            elasticsearch_error = str(error)

    return {
        "status": "ok",
        "elasticsearch_enabled": bool(get_elasticsearch_url()),
        "elasticsearch_reachable": elasticsearch_reachable,
        "elasticsearch_url": get_elasticsearch_url(),
        "elasticsearch_error": elasticsearch_error,
        "model_available": MODEL_PATH.exists() or RF_MODEL_DIR.exists(),
        "legacy_model_available": MODEL_PATH.exists(),
        "random_forest_model_available": RF_MODEL_DIR.exists(),
        "prediction_index": PREDICTION_INDEX,
    }


@app.post("/ingest/sensor")
def ingest_sensor(payload: SensorIngest):
    document = payload.model_dump(mode="json")
    index_or_fallback(SENSOR_INDEX, document, "sensor_readings.jsonl")
    return {"success": True}


@app.post("/ingest/image")
def ingest_image(payload: ImageIngest):
    document = payload.model_dump(mode="json")
    index_or_fallback(IMAGE_INDEX, document, "image_records.jsonl")
    return {"success": True}


@app.post("/ingest/image-direct")
def ingest_image_direct(payload: DirectImageIngest):
    document = save_direct_image(payload)
    index_or_fallback(IMAGE_INDEX, document, "image_records.jsonl")
    return {"success": True, **document}


@app.get("/data/recent/sensors")
def recent_sensors(limit: int = 10):
    client = get_es_client()
    if client is not None:
        response = client.search(
            index=SENSOR_INDEX,
            size=limit,
            sort=[{"timestamp": {"order": "desc"}}],
        )
        hits = [item["_source"] for item in response["hits"]["hits"]]
        return {"source": "elasticsearch", "items": hits}

    return {"source": "jsonl", "items": load_recent_jsonl("sensor_readings.jsonl", limit)}


@app.get("/data/recent/images")
def recent_images(limit: int = 10):
    client = get_es_client()
    if client is not None:
        response = client.search(
            index=IMAGE_INDEX,
            size=limit,
            sort=[{"timestamp": {"order": "desc"}}],
        )
        hits = [item["_source"] for item in response["hits"]["hits"]]
        return {"source": "elasticsearch", "items": hits}

    return {"source": "jsonl", "items": load_recent_jsonl("image_records.jsonl", limit)}


@app.get("/data/sensors")
def list_sensors(
    limit: int = 100,
    offset: int = 0,
    startDate: datetime | None = None,
    endDate: datetime | None = None,
):
    items = get_sensor_documents(limit=limit, offset=offset, start_date=startDate, end_date=endDate)
    return {"source": "elasticsearch" if get_es_client() is not None else "jsonl", "items": items}


@app.get("/data/sensors/latest")
def latest_sensor():
    items = get_sensor_documents(limit=1, offset=0)
    return {
        "source": "elasticsearch" if get_es_client() is not None else "jsonl",
        "item": items[0] if items else None,
    }


@app.get("/data/sensors/hourly-summary")
def sensor_hourly_summary(
    startDate: datetime | None = None,
    endDate: datetime | None = None,
):
    now = datetime.now()
    start_date = startDate or datetime(now.year, now.month, now.day, 0, 0, 0)
    end_date = endDate
    client = get_es_client()

    if client is not None:
        range_query: dict[str, Any] = {}
        if start_date:
            range_query["gte"] = format_query_iso(start_date)
        if end_date:
            range_query["lt"] = format_query_iso(end_date)

        query: dict[str, Any] = {"match_all": {}}
        if range_query:
            query = {"range": {"timestamp": range_query}}

        response = client.search(
            index=SENSOR_INDEX,
            size=0,
            query=query,
            aggs={
                "by_hour": {
                    "date_histogram": {
                        "field": "timestamp",
                        "calendar_interval": "1h",
                        "time_zone": APP_TIMEZONE,
                        "min_doc_count": 1,
                        "order": {"_key": "desc"},
                    },
                    "aggs": {
                        "avg_power": {"avg": {"field": "powerWatts"}},
                        "avg_voltage": {"avg": {"field": "voltageAC"}},
                        "avg_current": {"avg": {"field": "currentAC"}},
                        "avg_power_factor": {"avg": {"field": "powerFactor"}},
                        "avg_temperature": {"avg": {"field": "temperatureCelsius"}},
                        "avg_humidity": {"avg": {"field": "humidityPercent"}},
                        "avg_wind": {"avg": {"field": "windSpeedMs"}},
                    },
                }
            },
        )

        rows = []
        for bucket in response.get("aggregations", {}).get("by_hour", {}).get("buckets", []):
            rows.append(
                {
                    "hour": bucket.get("key_as_string"),
                    "power": bucket.get("avg_power", {}).get("value") or 0.0,
                    "voltage": bucket.get("avg_voltage", {}).get("value") or 0.0,
                    "current": bucket.get("avg_current", {}).get("value") or 0.0,
                    "powerFactor": bucket.get("avg_power_factor", {}).get("value") or 0.0,
                    "temperature": bucket.get("avg_temperature", {}).get("value") or 0.0,
                    "humidity": bucket.get("avg_humidity", {}).get("value") or 0.0,
                    "windSpeed": bucket.get("avg_wind", {}).get("value") or 0.0,
                }
            )

        return {"source": "elasticsearch", "items": rows}

    items = get_sensor_documents(limit=5000, offset=0, start_date=start_date, end_date=end_date)
    grouped: dict[str, list[dict[str, Any]]] = {}

    for item in items:
        timestamp = item.get("timestamp")
        if not timestamp:
            continue
        dt = normalize_dt(timestamp)
        bucket = dt.replace(minute=0, second=0, microsecond=0).isoformat()
        grouped.setdefault(bucket, []).append(item)

    def average(values: list[float]) -> float:
        return sum(values) / len(values) if values else 0.0

    rows = []
    for hour_key, bucket_items in grouped.items():
        rows.append(
            {
                "hour": hour_key,
                "power": average([float(item.get("powerWatts", 0) or 0) for item in bucket_items]),
                "voltage": average([float(item.get("voltageAC", 0) or 0) for item in bucket_items]),
                "current": average([float(item.get("currentAC", 0) or 0) for item in bucket_items]),
                "powerFactor": average([float(item.get("powerFactor", 0) or 0) for item in bucket_items]),
                "temperature": average([float(item.get("temperatureCelsius", 0) or 0) for item in bucket_items]),
                "humidity": average([float(item.get("humidityPercent", 0) or 0) for item in bucket_items]),
                "windSpeed": average([float(item.get("windSpeedMs", 0) or 0) for item in bucket_items]),
            }
        )

    rows.sort(key=lambda row: row["hour"], reverse=True)
    return {"source": "elasticsearch" if get_es_client() is not None else "jsonl", "items": rows}


@app.get("/data/images")
def list_images(
    limit: int = 20,
    offset: int = 0,
    startDate: datetime | None = None,
    endDate: datetime | None = None,
):
    items = get_image_documents(limit=limit, offset=offset, start_date=startDate, end_date=endDate)
    return {"source": "elasticsearch" if get_es_client() is not None else "jsonl", "items": items}


@app.get("/data/clouds/latest")
def latest_cloud():
    items = get_image_documents(limit=1, offset=0)
    latest = items[0] if items else None
    if latest is None:
        return {"source": "elasticsearch" if get_es_client() is not None else "jsonl", "item": None}

    return {
        "source": "elasticsearch" if get_es_client() is not None else "jsonl",
        "item": {
            "cloudCoveragePercent": latest.get("cloudCoveragePercent") or 0,
            "cloudVectorData": latest.get("cloudVectorData"),
            "detectionTime": latest.get("timestamp") or latest.get("captureTime") or latest.get("createdAt"),
            "imageUrl": latest.get("imageUrl"),
        },
    }


@app.get("/forecast/predictions")
def list_forecast_predictions(
    limit: int = 100,
    offset: int = 0,
    startDate: datetime | None = None,
    endDate: datetime | None = None,
    status: str | None = None,
):
    safe_limit = max(1, min(limit, 5000))
    safe_status = status if status in {None, "pending", "matched"} else None
    items = get_prediction_documents(
        limit=safe_limit,
        offset=max(0, offset),
        start_date=startDate,
        end_date=endDate,
        status=safe_status,
    )
    return {
        "source": "elasticsearch" if get_es_client() is not None else "jsonl",
        "items": items,
    }


@app.post("/forecast/predictions/match")
def match_forecast_predictions(
    maxAgeHours: int = 24,
    toleranceSeconds: int = FORECAST_MATCH_TOLERANCE_SECONDS,
):
    return {
        "success": True,
        **match_pending_predictions(
            max_age_hours=max(1, min(maxAgeHours, 24 * 14)),
            tolerance_seconds=max(10, min(toleranceSeconds, 600)),
            limit=5000,
        ),
    }


@app.get("/forecast/predictions/summary")
def forecast_prediction_summary(
    startDate: datetime | None = None,
    endDate: datetime | None = None,
):
    now_dt = datetime.now(tz=LOCAL_TZ)
    start_dt = startDate or datetime(now_dt.year, now_dt.month, now_dt.day, 0, 0, 0, tzinfo=LOCAL_TZ)
    end_dt = endDate or now_dt + timedelta(seconds=1)
    items = get_prediction_documents(
        limit=5000,
        offset=0,
        start_date=start_dt,
        end_date=end_dt,
        status=None,
    )
    by_horizon: dict[int, list[dict[str, Any]]] = {}
    for item in items:
        by_horizon.setdefault(int(item.get("horizonMinutes") or 0), []).append(item)

    rows = []
    for horizon, horizon_items in sorted(by_horizon.items()):
        matched = [item for item in horizon_items if item.get("status") == "matched"]
        avg_accuracy = (
            sum(float(item.get("accuracyPercent") or 0.0) for item in matched) / len(matched)
            if matched
            else None
        )
        avg_error = (
            sum(float(item.get("absoluteErrorWatts") or 0.0) for item in matched) / len(matched)
            if matched
            else None
        )
        rows.append(
            {
                "horizonMinutes": horizon,
                "totalPredictions": len(horizon_items),
                "matchedPredictions": len(matched),
                "pendingPredictions": len(horizon_items) - len(matched),
                "avgAccuracyPercent": round(avg_accuracy, 4) if avg_accuracy is not None else None,
                "avgAbsoluteErrorWatts": round(avg_error, 4) if avg_error is not None else None,
            }
        )

    return {
        "source": "elasticsearch" if get_es_client() is not None else "jsonl",
        "items": rows,
        "totalPredictions": len(items),
        "startDate": local_iso(parse_local_aware(start_dt) or now_dt),
        "endDate": local_iso(parse_local_aware(end_dt) or now_dt),
    }


@app.post("/forecast/predict")
def forecast_predict(payload: ForecastFeatures):
    if not MODEL_PATH.exists():
        return {"success": False, "error": f"Model file not found: {MODEL_PATH}"}

    with MODEL_PATH.open("rb") as handle:
        bundle = pickle.load(handle)

    model = bundle["model"]
    features = bundle["features"]
    frame = {name: getattr(payload, name) for name in features}
    prediction = float(model.predict([list(frame.values())])[0])

    return {
        "success": True,
        "predictedPowerWatts": prediction,
        "target": bundle.get("target", "target_power_next"),
    }


@app.get("/forecast/random-forest/latest")
def random_forest_latest_forecast(hoursBack: int = 2):
    try:
        result = build_random_forest_forecast(hours_back=hoursBack)
    except Exception as error:
        result = {
            "success": False,
            "items": [],
            "error": f"Random Forest forecast unavailable: {error}",
            "sourceRows": 0,
            "quality": {
                "electricalLowConfidence": True,
                "imageUsable": False,
                "note": "Random Forest model files are not available yet. Use the baseline forecast until retraining is complete.",
            },
        }
    prediction_log = log_forecast_predictions(result)
    prediction_evaluation = match_pending_predictions()
    return {
        **result,
        "predictionLog": prediction_log,
        "predictionEvaluation": prediction_evaluation,
    }


@app.get("/forecast/stable-window/latest")
def stable_window_latest_forecast(hoursBack: int = 24):
    try:
        result = build_stable_window_forecast(hours_back=hoursBack)
    except Exception as error:
        result = {
            "success": False,
            "items": [],
            "error": f"Stable window forecast unavailable: {error}",
            "sourceRows": 0,
            "modelDir": str(STABLE_WINDOW_MODEL_DIR),
        }
    return {
        **result,
        "modelDir": str(STABLE_WINDOW_MODEL_DIR),
        "note": "Stable window forecast predicts future-window averages and is not auto-logged into the point-forecast history yet.",
    }
