# Solarcell Dashboard API Documentation

## Overview

The Solarcell Dashboard provides a comprehensive REST API (via tRPC) for managing solar panel sensor data, cloud detection, and sky images. All endpoints are accessible through the tRPC protocol at `/api/trpc/`.

## Base URL

```
https://your-domain.com/api/trpc
```

## Authentication

Currently, all endpoints are public. In the future, authentication can be added using the `protectedProcedure` in tRPC.

## API Endpoints

### Sensor Readings

#### Get Latest Sensor Reading
Retrieves the most recent sensor reading.

**Endpoint:** `sensors.latest`

**Method:** GET

**Response:**
```json
{
  "id": 1,
  "powerWatts": 250,
  "temperatureCelsius": 28,
  "humidityPercent": 65,
  "windSpeedMs": 5,
  "readingTime": "2026-03-20T09:30:00Z",
  "createdAt": "2026-03-20T09:30:00Z"
}
```

#### List Sensor Readings
Retrieves paginated historical sensor readings.

**Endpoint:** `sensors.list`

**Method:** GET

**Query Parameters:**
- `limit` (number, default: 100, max: 1000) - Number of records to return
- `offset` (number, default: 0) - Number of records to skip

**Response:**
```json
[
  {
    "id": 1,
    "powerWatts": 250,
    "temperatureCelsius": 28,
    "humidityPercent": 65,
    "windSpeedMs": 5,
    "readingTime": "2026-03-20T09:30:00Z",
    "createdAt": "2026-03-20T09:30:00Z"
  }
]
```

#### Create Sensor Reading
Submits a new sensor reading from the Raspberry Pi.

**Endpoint:** `sensors.create`

**Method:** POST

**Request Body:**
```json
{
  "powerWatts": 250,
  "temperatureCelsius": 28,
  "humidityPercent": 65,
  "windSpeedMs": 5
}
```

**Validation:**
- `powerWatts`: Integer, must be >= 0
- `temperatureCelsius`: Integer (can be negative)
- `humidityPercent`: Integer, must be 0-100
- `windSpeedMs`: Integer, must be >= 0

**Response:**
```json
{
  "insertId": 1
}
```

### Cloud Detection

#### Get Latest Cloud Detection
Retrieves the most recent cloud detection result.

**Endpoint:** `clouds.latest`

**Method:** GET

**Response:**
```json
{
  "id": 1,
  "cloudCoveragePercent": 45,
  "cloudVectorData": "{\"type\":\"cumulus\",\"movement\":\"north\",\"density\":\"moderate\"}",
  "imageId": 1,
  "detectionTime": "2026-03-20T09:30:00Z",
  "createdAt": "2026-03-20T09:30:00Z"
}
```

#### List Cloud Detections
Retrieves paginated historical cloud detection results.

**Endpoint:** `clouds.list`

**Method:** GET

**Query Parameters:**
- `limit` (number, default: 50, max: 1000) - Number of records to return
- `offset` (number, default: 0) - Number of records to skip

**Response:**
```json
[
  {
    "id": 1,
    "cloudCoveragePercent": 45,
    "cloudVectorData": "{\"type\":\"cumulus\",\"movement\":\"north\",\"density\":\"moderate\"}",
    "imageId": 1,
    "detectionTime": "2026-03-20T09:30:00Z",
    "createdAt": "2026-03-20T09:30:00Z"
  }
]
```

#### Create Cloud Detection
Submits a new cloud detection result.

**Endpoint:** `clouds.create`

**Method:** POST

**Request Body:**
```json
{
  "cloudCoveragePercent": 45,
  "cloudVectorData": "{\"type\":\"cumulus\",\"movement\":\"north\",\"density\":\"moderate\"}",
  "imageId": 1
}
```

**Validation:**
- `cloudCoveragePercent`: Integer, must be 0-100
- `cloudVectorData`: String (optional), JSON format recommended
- `imageId`: Integer (optional), reference to sky_images table

**Response:**
```json
{
  "insertId": 1
}
```

### Sky Images

#### List Sky Images
Retrieves paginated sky images from the gallery.

**Endpoint:** `images.list`

**Method:** GET

**Query Parameters:**
- `limit` (number, default: 20, max: 1000) - Number of records to return
- `offset` (number, default: 0) - Number of records to skip

**Response:**
```json
[
  {
    "id": 1,
    "fileKey": "sky-2026-03-20-001.jpg",
    "imageUrl": "https://cdn.example.com/sky-2026-03-20-001.jpg",
    "mimeType": "image/jpeg",
    "fileSizeBytes": 2048000,
    "captureTime": "2026-03-20T09:30:00Z",
    "createdAt": "2026-03-20T09:30:00Z"
  }
]
```

#### Create Sky Image
Submits a new sky image with S3 URL.

**Endpoint:** `images.create`

**Method:** POST

**Request Body:**
```json
{
  "fileKey": "sky-2026-03-20-001.jpg",
  "imageUrl": "https://cdn.example.com/sky-2026-03-20-001.jpg",
  "mimeType": "image/jpeg",
  "fileSizeBytes": 2048000
}
```

**Validation:**
- `fileKey`: String, required, non-empty
- `imageUrl`: String, required, must be valid URL
- `mimeType`: String (optional, default: "image/jpeg")
- `fileSizeBytes`: Integer (optional)

**Response:**
```json
{
  "insertId": 1
}
```

## Example Usage

### Using cURL

#### Send Sensor Reading
```bash
curl -X POST https://your-domain.com/api/trpc/sensors.create \
  -H "Content-Type: application/json" \
  -d '{
    "json": {
      "powerWatts": 250,
      "temperatureCelsius": 28,
      "humidityPercent": 65,
      "windSpeedMs": 5
    }
  }'
```

#### Get Latest Reading
```bash
curl https://your-domain.com/api/trpc/sensors.latest
```

#### List Sensor Readings
```bash
curl "https://your-domain.com/api/trpc/sensors.list?json={\"limit\":10,\"offset\":0}"
```

### Using Python

```python
import requests

# Send sensor reading
response = requests.post(
    "https://your-domain.com/api/trpc/sensors.create",
    json={
        "json": {
            "powerWatts": 250,
            "temperatureCelsius": 28,
            "humidityPercent": 65,
            "windSpeedMs": 5
        }
    }
)
print(response.json())

# Get latest reading
response = requests.get("https://your-domain.com/api/trpc/sensors.latest")
print(response.json())
```

### Using JavaScript/TypeScript

```typescript
import { trpc } from "@/lib/trpc";

// Send sensor reading
const result = await trpc.sensors.create.mutate({
  powerWatts: 250,
  temperatureCelsius: 28,
  humidityPercent: 65,
  windSpeedMs: 5
});

// Get latest reading
const latest = await trpc.sensors.latest.query();

// List readings
const readings = await trpc.sensors.list.query({
  limit: 10,
  offset: 0
});
```

## Data Types

### Sensor Reading
| Field | Type | Description |
|-------|------|-------------|
| id | integer | Unique identifier |
| powerWatts | integer | Power generation in watts (0-500) |
| temperatureCelsius | integer | Ambient temperature in Celsius |
| humidityPercent | integer | Relative humidity percentage (0-100) |
| windSpeedMs | integer | Wind speed in meters per second |
| readingTime | timestamp | When the reading was taken |
| createdAt | timestamp | When the record was created |

### Cloud Detection
| Field | Type | Description |
|-------|------|-------------|
| id | integer | Unique identifier |
| cloudCoveragePercent | integer | Cloud coverage percentage (0-100) |
| cloudVectorData | string | JSON data about cloud movement/type |
| imageId | integer | Reference to sky image (optional) |
| detectionTime | timestamp | When detection occurred |
| createdAt | timestamp | When the record was created |

### Sky Image
| Field | Type | Description |
|-------|------|-------------|
| id | integer | Unique identifier |
| fileKey | string | S3 file key |
| imageUrl | string | Public S3 URL to image |
| mimeType | string | Image MIME type (e.g., image/jpeg) |
| fileSizeBytes | integer | File size in bytes |
| captureTime | timestamp | When image was captured |
| createdAt | timestamp | When the record was created |

## Error Handling

All errors follow the tRPC error format. Common errors:

- **400 Bad Request**: Invalid input data or validation failed
- **404 Not Found**: Resource not found
- **500 Internal Server Error**: Server error

Example error response:
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid input"
  }
}
```

## Rate Limiting

Currently, no rate limiting is implemented. This should be added for production use.

## Future Enhancements

- Authentication and authorization
- Rate limiting
- Webhook support for real-time updates
- Data export (CSV, JSON)
- Advanced filtering and search
- Image upload endpoint (currently requires pre-uploaded S3 URLs)
