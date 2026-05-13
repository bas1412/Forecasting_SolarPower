# Forecasting_SolarPower

Minimal GitHub package for the thesis project:

**Thai title:** การพยากรณ์กำลังผลิตไฟฟ้าจากเซลล์แสงอาทิตย์ด้วยวิธีการถ่ายภาพและการอ่านค่าจากเซ็นเซอร์  
**English title:** Forecasting Solar Power Generation Using Imaging Techniques and Sensor Data

This package keeps only the files that are important for understanding the final working system and the forecasting pipeline. It is prepared for uploading to GitHub and for citing in the thesis appendix.

## Repository sections

### 1. `frontend/` = หน้าบ้าน
Used for the web user interface.

Main responsibility:
- show real-time sensor values
- show history charts
- show sky image and cloud results
- show short-term forecasting results

Important files:
- `src/pages/Dashboard.tsx`
- `src/pages/History.tsx`
- `src/App.tsx`

### 2. `backend/` = หลังบ้าน
Used for API, data ingestion, data storage, and machine-learning related backend processing.

Main responsibility:
- receive sensor data and image metadata from Raspberry Pi
- provide REST API endpoints
- store time-series data
- run forecasting-related backend logic

Important subfolders:
- `fastapi_service/` FastAPI ingestion and inference services
- `server/` Node/TypeScript backend utilities and routing
- `ml/` machine-learning training and preprocessing scripts
- `shared/` shared types and constants
- `drizzle/` database schema and migration files

### 3. `codepi/` = โค้ดที่รันบน Raspberry Pi
Used for the field device that reads sensors and captures sky images.

Main responsibility:
- read PZEM-004T and environmental sensors
- capture sky images from Camera Module 3
- timestamp and sync data
- upload data to FastAPI/backend

Important files:
- `allcode.py`
- `solar-monitor.service`
- `deploy/`

## Recommended upload scope
Upload this entire package to the GitHub repository:

`https://github.com/bas1412/Forecasting_SolarPower`

## Intentionally excluded
- `node_modules/`
- Python virtual environments
- runtime logs
- local screenshots and report drafts
- uploaded raw image archives
- temporary files and experimental leftovers

## Recommended use in the thesis
This package is appropriate for:
- citing the project repository in Appendix A
- showing code structure without attaching full local working directories
- separating the explanation into frontend, backend, and Raspberry Pi runtime clearly
