#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path

try:
    from elasticsearch import Elasticsearch
except ImportError as exc:
    raise SystemExit("elasticsearch package is required") from exc


APP_ROOT = Path(__file__).resolve().parent
DATA_ROOT = APP_ROOT / "data"

ELASTICSEARCH_URL = os.getenv("ELASTICSEARCH_URL", "http://127.0.0.1:9200")
SENSOR_INDEX = os.getenv("ELASTICSEARCH_SENSOR_INDEX", "solar-sensor-readings")
IMAGE_INDEX = os.getenv("ELASTICSEARCH_IMAGE_INDEX", "solar-sky-images")


def load_jsonl(path: Path):
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def main():
    client = Elasticsearch(ELASTICSEARCH_URL)
    sensor_records = load_jsonl(DATA_ROOT / "sensor_readings.jsonl")
    image_records = load_jsonl(DATA_ROOT / "image_records.jsonl")

    for record in sensor_records:
        client.index(index=SENSOR_INDEX, document=record)
    for record in image_records:
        client.index(index=IMAGE_INDEX, document=record)

    print(f"Indexed {len(sensor_records)} sensor records into {SENSOR_INDEX}")
    print(f"Indexed {len(image_records)} image records into {IMAGE_INDEX}")


if __name__ == "__main__":
    main()
