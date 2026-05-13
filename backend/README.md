# Backend (หลังบ้าน)

This folder contains the service-side code of the project.

## Main purpose
- receive and validate sensor data and image-related payloads
- provide API endpoints for frontend and Raspberry Pi
- store time-series data
- support preprocessing and forecasting workflows

## Included sections
- `fastapi_service/` FastAPI ingestion and data service
- `server/` Node/TypeScript backend utilities and routing
- `shared/` shared types and constants
- `drizzle/` schema and migration files
- `ml/` selected training and preprocessing scripts

## Notes
This folder is the **backend / หลังบ้าน** part of the system.  
It handles API, storage, and machine-learning related server logic, but does not include the Raspberry Pi runtime used at the installation site.
