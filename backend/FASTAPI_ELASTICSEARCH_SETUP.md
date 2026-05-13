# FastAPI + Elasticsearch Integration

This workspace now includes a FastAPI service for research-scope ingestion and forecasting.

## What it does

- Existing Notebook backend keeps running as the dashboard/API used by Raspberry Pi.
- The Node backend mirrors every accepted sensor reading to FastAPI `/ingest/sensor`.
- The Node backend mirrors every accepted image record to FastAPI `/ingest/image`.
- FastAPI writes to Elasticsearch when configured.
- If Elasticsearch is not configured yet, FastAPI falls back to local JSONL files in `fastapi_service/data/`.

## Files

- `fastapi_service/main.py`
- `fastapi_service/requirements.txt`
- `server/researchMirror.ts`

## Install

```powershell
python -m venv .venv-fastapi
.venv-fastapi\Scripts\activate
pip install -r fastapi_service\requirements.txt
```

## Run FastAPI

```powershell
.venv-fastapi\Scripts\activate
$env:ELASTICSEARCH_URL="http://127.0.0.1:9200"
uvicorn fastapi_service.main:app --host 127.0.0.1 --port 8010 --reload
```

## Run Elasticsearch on Notebook

If Docker Desktop is installed:

```powershell
docker compose -f docker-compose.elasticsearch.yml up -d
```

Elasticsearch will be available at:

```text
http://127.0.0.1:9200
```

## Optional environment variables

```powershell
$env:FASTAPI_URL="http://127.0.0.1:8010"
$env:ELASTICSEARCH_URL="http://127.0.0.1:9200"
$env:ELASTICSEARCH_SENSOR_INDEX="solar-sensor-readings"
$env:ELASTICSEARCH_IMAGE_INDEX="solar-sky-images"
$env:FORECAST_MODEL_PATH="C:\Users\kitti\Downloads\Project solar\forecast_model.pkl"
```

## Run dashboard backend

```powershell
$env:FASTAPI_URL="http://127.0.0.1:8010"
pnpm dev
```

## Result

- Raspberry Pi still sends data to the same Notebook dashboard endpoint.
- Notebook dashboard keeps working as before.
- Research-scope FastAPI + Elasticsearch pipeline receives mirrored data without changing Pi code.

## Validation

Check service health:

```text
http://127.0.0.1:8010/health
```

Check recent mirrored sensor data:

```text
http://127.0.0.1:8010/data/recent/sensors
```

Check recent mirrored image data:

```text
http://127.0.0.1:8010/data/recent/images
```

## Reindex old JSONL fallback data into Elasticsearch

If FastAPI collected JSONL fallback data before Elasticsearch was enabled:

```powershell
.venv-fastapi\Scripts\python.exe fastapi_service\reindex_jsonl_to_elasticsearch.py
```
