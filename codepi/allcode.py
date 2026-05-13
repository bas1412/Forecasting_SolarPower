#!/usr/bin/env python3
"""
Raspberry Pi 5 sensor + camera uploader for the Solar Dashboard.

This script:
- reads solar/environment/wind sensors
- captures an image with rpicam-jpeg (or libcamera-still as fallback)
- estimates cloud coverage from the captured image
- sends sensor data to the existing dashboard backend (port 3000)
- sends sensor data to FastAPI /ingest/sensor (port 8010)
- sends image data to the existing dashboard backend (port 3000)
- sends image data to FastAPI /ingest/image-direct (port 8010)

Designed to work with the current backend in this workspace.
"""

import argparse
import base64
import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime

import requests

try:
    import minimalmodbus
except ImportError:
    minimalmodbus = None

try:
    from smbus2 import SMBus
except ImportError:
    SMBus = None

try:
    import board
    import busio
    import adafruit_ahtx0
except Exception:
    board = None
    busio = None
    adafruit_ahtx0 = None

try:
    import adafruit_bmp280
except Exception:
    adafruit_bmp280 = None

try:
    import cv2
    import numpy as np
except ImportError:
    cv2 = None
    np = None


TARGET_IP = "192.168.1.41"
DASHBOARD_PORT = 3000
FASTAPI_PORT = 8010
FASTAPI_BASE_URL = f"http://{TARGET_IP}:{FASTAPI_PORT}"
DASHBOARD_BASE_URL = f"http://{TARGET_IP}:{DASHBOARD_PORT}"
DASHBOARD_SENSORS_API_URL = f"{DASHBOARD_BASE_URL}/api/trpc/sensors.create"
DASHBOARD_IMAGES_API_URL = f"{DASHBOARD_BASE_URL}/api/trpc/images.upload"
FASTAPI_SENSORS_API_URL = f"{FASTAPI_BASE_URL}/ingest/sensor"
FASTAPI_IMAGES_API_URL = f"{FASTAPI_BASE_URL}/ingest/image-direct"

PZEM_PORT = "/dev/ttyUSB1"
WIND_PORT = "/dev/ttyUSB0"
PZEM_SLAVE_ID = 1
WIND_SLAVE_ID = 1
PZEM_BAUDRATE = 9600
WIND_BAUDRATE = 4800
STATE_FILE = "system_state.json"
CSV_LOG_FILE = "solar_dataset.csv"
RUNTIME_STATUS_FILE = "runtime_status.json"
LAST_ERROR_FILE = "last_error.json"

SENSOR_INTERVAL_SECONDS = 5
IMAGE_INTERVAL_SECONDS = 30
ACTIVE_START_HOUR = 5
ACTIVE_START_MINUTE = 30
ACTIVE_END_HOUR = 18
ACTIVE_END_MINUTE = 30
STANDBY_SLEEP_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 20
REQUEST_RETRIES = 1
RETRY_DELAY_SECONDS = 1
CAMERA_PROCESS_TIMEOUT_SECONDS = 20
JPEG_QUALITY = 90
CAPTURE_TIMEOUT_MS = 2000
CAPTURE_FALLBACK_TIMEOUT_MS = 1200
CAPTURE_WIDTH = 1280
CAPTURE_HEIGHT = 960
CAMERA_FOCUS_ARGS = [
    "--autofocus-mode",
    "manual",
    "--lens-position",
    "0.0",
    "--sharpness",
    "1.1",
    "--contrast",
    "1.0",
]
IMAGE_ENHANCE_ENABLED = False
IMAGE_DATASET_PHASE = "bare_camera3_wide_collection"
IMAGE_CAMERA_SETUP = "Pi Camera Module 3 Wide, no add-on lens"
IMAGE_MODEL_NOTE = "Use this image stream for the new 7-day image/model dataset."
CLOUD_COVERAGE_ALGORITHM = "opencv-hsv-blue-sky-mask"
CLOUD_COVERAGE_CONFIDENCE = "experimental"
LEGACY_CLOUD_COVERAGE_ENABLED = False


def log(message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


def write_json_file(path: str, payload: dict) -> None:
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
    except Exception as error:
        log(f"JSON ERR {path} {error}")


def update_runtime_status(stage: str, **extra) -> None:
    payload = {
        "timestamp": datetime.now().isoformat(),
        "stage": stage,
    }
    payload.update(extra)
    write_json_file(RUNTIME_STATUS_FILE, payload)


def record_runtime_error(stage: str, error: str) -> None:
    write_json_file(
        LAST_ERROR_FILE,
        {
            "timestamp": datetime.now().isoformat(),
            "stage": stage,
            "error": error,
        },
    )


def post_json_with_retry(url: str, payload: dict, timeout_seconds: int, label: str):
    last_error = None
    for attempt in range(REQUEST_RETRIES + 1):
        try:
            return requests.post(url, json=payload, timeout=timeout_seconds)
        except Exception as error:
            last_error = error
            if attempt < REQUEST_RETRIES:
                log(f"{label} RETRY {attempt + 1}/{REQUEST_RETRIES}")
                time.sleep(RETRY_DELAY_SECONDS)
    raise last_error


def is_active_window(now: datetime) -> bool:
    current_minutes = now.hour * 60 + now.minute
    start_minutes = ACTIVE_START_HOUR * 60 + ACTIVE_START_MINUTE
    end_minutes = ACTIVE_END_HOUR * 60 + ACTIVE_END_MINUTE
    return start_minutes <= current_minutes < end_minutes


def find_camera_command() -> list[str] | None:
    if shutil.which("rpicam-jpeg"):
        return ["rpicam-jpeg"]
    if shutil.which("libcamera-still"):
        return ["libcamera-still"]
    return None


CAMERA_COMMAND = find_camera_command()


class RawI2CEnvironment:
    """Read AHT20 directly with smbus2 so Pi can run without Blinka/lgpio."""

    AHT20_ADDR = 0x38
    BMP280_ADDRS = (0x76, 0x77)

    def __init__(self, bus_number: int = 1) -> None:
        if SMBus is None:
            raise RuntimeError("smbus2 is not installed")
        self.bus = SMBus(bus_number)
        self.bmp_addr = self._find_bmp280()

    def _find_bmp280(self) -> int | None:
        for addr in self.BMP280_ADDRS:
            try:
                chip_id = self.bus.read_byte_data(addr, 0xD0)
                if chip_id in (0x58, 0x60):
                    return addr
            except OSError:
                continue
        return None

    def read(self) -> dict:
        try:
            status = self.bus.read_byte(self.AHT20_ADDR)
            if (status & 0x08) == 0:
                self.bus.write_i2c_block_data(self.AHT20_ADDR, 0xBE, [0x08, 0x00])
                time.sleep(0.05)
        except OSError:
            pass

        self.bus.write_i2c_block_data(self.AHT20_ADDR, 0xAC, [0x33, 0x00])
        time.sleep(0.1)
        data = self.bus.read_i2c_block_data(self.AHT20_ADDR, 0x00, 6)

        raw_humidity = (data[1] << 12) | (data[2] << 4) | (data[3] >> 4)
        raw_temperature = ((data[3] & 0x0F) << 16) | (data[4] << 8) | data[5]

        humidity = raw_humidity * 100.0 / 1048576.0
        temperature = raw_temperature * 200.0 / 1048576.0 - 50.0
        return {
            "temperatureCelsius": round(temperature, 2),
            "humidityPercent": int(round(max(0.0, min(100.0, humidity)))),
        }


class Hardware:
    def __init__(
        self,
        enable_mock: bool = False,
        pzem_port: str = PZEM_PORT,
        wind_port: str = WIND_PORT,
        pzem_slave_id: int = PZEM_SLAVE_ID,
        wind_slave_id: int = WIND_SLAVE_ID,
        pzem_baudrate: int = PZEM_BAUDRATE,
        wind_baudrate: int = WIND_BAUDRATE,
    ) -> None:
        self.enable_mock = enable_mock
        self.pzem_port = pzem_port
        self.wind_port = wind_port
        self.pzem_slave_id = pzem_slave_id
        self.wind_slave_id = wind_slave_id
        self.pzem_baudrate = pzem_baudrate
        self.wind_baudrate = wind_baudrate
        self.pzem = None
        self.wind = None
        self.aht = None
        self.bmp = None
        self.raw_env = None
        self.i2c_mode = "none"
        self.energy_kwh = self._load_energy()
        self.last_power_watts = 0.0
        self.last_sample_time = time.time()

    def setup(self) -> None:
        if self.enable_mock:
            log("Mock mode enabled. Hardware setup skipped.")
            return

        if minimalmodbus is None:
            raise RuntimeError("minimalmodbus is not installed")

        self.pzem = minimalmodbus.Instrument(self.pzem_port, self.pzem_slave_id)
        self.pzem.serial.baudrate = self.pzem_baudrate
        self.pzem.serial.timeout = 1
        self.pzem.mode = minimalmodbus.MODE_RTU

        self.wind = minimalmodbus.Instrument(self.wind_port, self.wind_slave_id)
        self.wind.serial.baudrate = self.wind_baudrate
        self.wind.serial.timeout = 1
        self.wind.mode = minimalmodbus.MODE_RTU

        if board is not None and busio is not None and adafruit_ahtx0 is not None:
            try:
                i2c = busio.I2C(board.SCL, board.SDA)
                self.aht = adafruit_ahtx0.AHTx0(i2c)
                if adafruit_bmp280 is not None:
                    try:
                        self.bmp = adafruit_bmp280.Adafruit_BMP280_I2C(i2c)
                    except Exception as error:
                        self.bmp = None
                        log(f"BMP280 WARN disabled: {error}")
                else:
                    self.bmp = None
                    log("BMP280 WARN disabled: library import failed")
                self.i2c_mode = "adafruit"
            except Exception as error:
                log(f"Adafruit I2C WARN disabled: {error}")

        if self.i2c_mode == "none":
            if SMBus is None:
                raise RuntimeError("No usable I2C library. Install smbus2 or fix adafruit-blinka/lgpio.")
            self.raw_env = RawI2CEnvironment(bus_number=1)
            self.i2c_mode = "smbus2"
            if self.raw_env.bmp_addr is None:
                log("BMP280 WARN not found via smbus2; pressure disabled")
            else:
                log(f"BMP280 found via smbus2 at 0x{self.raw_env.bmp_addr:02x}; pressure disabled in fallback")

        log(
            f"HW OK PZEM={self.pzem_port}@{self.pzem_baudrate} "
            f"WIND={self.wind_port}@{self.wind_baudrate} I2C={self.i2c_mode}"
        )

    def _load_energy(self) -> float:
        try:
            if os.path.exists(STATE_FILE):
                with open(STATE_FILE, "r", encoding="utf-8") as handle:
                    return float(json.load(handle).get("energyKwh", 0.0))
        except Exception as error:
            log(f"Failed to load saved energy state: {error}")
        return 0.0

    def _save_energy(self) -> None:
        try:
            with open(STATE_FILE, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "energyKwh": round(self.energy_kwh, 4),
                        "lastUpdate": datetime.now().isoformat(),
                    },
                    handle,
                )
        except Exception as error:
            log(f"Failed to save energy state: {error}")

    def read(self) -> dict | None:
        if self.enable_mock:
            return self._mock_read()

        results: dict[str, float | int] = {}

        try:
            # PZEM-004T v3.0 input registers
            voltage_raw = self.pzem.read_register(0, 0, functioncode=4)
            current_low = self.pzem.read_register(1, 0, functioncode=4)
            current_high = self.pzem.read_register(2, 0, functioncode=4)
            power_low = self.pzem.read_register(3, 0, functioncode=4)
            power_high = self.pzem.read_register(4, 0, functioncode=4)
            frequency_raw = self.pzem.read_register(7, 0, functioncode=4)
            power_factor_raw = self.pzem.read_register(8, 0, functioncode=4)
            voltage_ac = round(voltage_raw / 10.0, 1)
            power_watts = round(((power_high << 16) + power_low) / 10.0, 1)
            current_ac = round(((current_high << 16) + current_low) / 1000.0, 3)
            frequency_hz = round(frequency_raw / 10.0, 1)
            power_factor = round(power_factor_raw / 100.0, 2)
            results["powerWatts"] = power_watts
            results["voltageAC"] = voltage_ac
            results["currentAC"] = current_ac
            results["frequencyHz"] = frequency_hz
            results["powerFactor"] = power_factor
        except Exception as error:
            log(f"PZEM error: {error}")

        try:
            results["windSpeedMs"] = round(
                self.wind.read_register(0, 0, functioncode=3) / 10.0, 2
            )
        except Exception as error:
            log(f"Wind sensor error: {error}")

        if self.i2c_mode == "smbus2" and self.raw_env is not None:
            try:
                results.update(self.raw_env.read())
            except Exception as error:
                log(f"I2C smbus2 sensor error: {error}")
        else:
            try:
                results["temperatureCelsius"] = round(self.aht.temperature, 2)
                results["humidityPercent"] = int(round(self.aht.relative_humidity))
                if self.bmp is not None:
                    results["pressureHpa"] = round(self.bmp.pressure, 2)
            except Exception as error:
                log(f"I2C sensor error: {error}")

        if "powerWatts" in results:
            now = time.time()
            delta_hours = max(0.0, (now - self.last_sample_time) / 3600.0)
            self.energy_kwh += max(float(results["powerWatts"]), 0.0) * delta_hours / 1000.0
            self.last_sample_time = now
            self.last_power_watts = float(results["powerWatts"])
            self._save_energy()

        results["energyKwh"] = round(self.energy_kwh, 4)
        return results if results else None

    def _mock_read(self) -> dict:
        now = time.time()
        delta_hours = max(0.0, (now - self.last_sample_time) / 3600.0)
        self.last_sample_time = now
        self.last_power_watts = max(0.0, self.last_power_watts + 15.0) if self.last_power_watts < 200 else 85.0
        self.energy_kwh += self.last_power_watts * delta_hours / 1000.0

        return {
            "powerWatts": round(self.last_power_watts, 1),
            "voltageAC": 223.0,
            "currentAC": 0.38,
            "frequencyHz": 50.0,
            "powerFactor": 0.86,
            "windSpeedMs": 2.4,
            "temperatureCelsius": 34.2,
            "humidityPercent": 71,
            "pressureHpa": 1007.4,
            "energyKwh": round(self.energy_kwh, 4),
        }


def build_camera_commands(output_path: str) -> list[list[str]]:
    return [
        [
            *CAMERA_COMMAND,
            "--timeout",
            str(CAPTURE_TIMEOUT_MS),
            "--width",
            str(CAPTURE_WIDTH),
            "--height",
            str(CAPTURE_HEIGHT),
            "--quality",
            str(JPEG_QUALITY),
            "--output",
            output_path,
            "--nopreview",
            *CAMERA_FOCUS_ARGS,
        ],
        [
            *CAMERA_COMMAND,
            "--timeout",
            str(CAPTURE_FALLBACK_TIMEOUT_MS),
            "--width",
            str(CAPTURE_WIDTH),
            "--height",
            str(CAPTURE_HEIGHT),
            "--quality",
            str(JPEG_QUALITY),
            "--output",
            output_path,
            "--nopreview",
        ],
    ]


def capture_image_bytes() -> bytes | None:
    if CAMERA_COMMAND is None:
        log("IMG ERR no camera cmd")
        return None

    temp_path = None

    try:
        with tempfile.NamedTemporaryFile(prefix="solar-capture-", suffix=".jpg", delete=False) as temp_file:
            temp_path = temp_file.name
    except Exception as error:
        log(f"IMG ERR temp file {error}")
        return None

    log("IMG CAP START")
    commands = build_camera_commands(temp_path)
    last_error = None

    try:
        for index, command in enumerate(commands, start=1):
            try:
                if index > 1:
                    log("IMG RETRY fallback camera args")
                    if temp_path and os.path.exists(temp_path):
                        os.remove(temp_path)

                subprocess.run(
                    command,
                    check=True,
                    stderr=subprocess.PIPE,
                    timeout=CAMERA_PROCESS_TIMEOUT_SECONDS,
                )

                if not temp_path or not os.path.exists(temp_path):
                    last_error = "file not created"
                    continue

                with open(temp_path, "rb") as handle:
                    image_bytes = handle.read()

                if not image_bytes:
                    last_error = "empty bytes"
                    continue

                log("IMG CAP DONE")
                image_bytes = enhance_image_bytes(image_bytes)
                return image_bytes
            except subprocess.TimeoutExpired:
                last_error = f"timeout {CAMERA_PROCESS_TIMEOUT_SECONDS}s"
            except subprocess.CalledProcessError as error:
                stderr = error.stderr.decode("utf-8", errors="ignore").strip()
                last_error = stderr or str(error)
            except Exception as error:
                last_error = str(error)

        log(f"IMG ERR {last_error or 'capture failed'}")
        return None
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass


def enhance_image_bytes(image_bytes: bytes) -> bytes:
    if not IMAGE_ENHANCE_ENABLED or cv2 is None or np is None:
        return image_bytes

    try:
        array = np.frombuffer(image_bytes, dtype=np.uint8)
        frame = cv2.imdecode(array, cv2.IMREAD_COLOR)
        if frame is None:
            return image_bytes

        lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
        l_channel, a_channel, b_channel = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=1.7, tileGridSize=(8, 8))
        l_channel = clahe.apply(l_channel)
        enhanced = cv2.cvtColor(cv2.merge((l_channel, a_channel, b_channel)), cv2.COLOR_LAB2BGR)

        hsv = cv2.cvtColor(enhanced, cv2.COLOR_BGR2HSV).astype(np.float32)
        hsv[:, :, 1] = np.clip(hsv[:, :, 1] * 1.08, 0, 255)
        enhanced = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

        blurred = cv2.GaussianBlur(enhanced, (0, 0), 1.5)
        enhanced = cv2.addWeighted(enhanced, 1.5, blurred, -0.5, 0)
        enhanced = cv2.convertScaleAbs(enhanced, alpha=1.04, beta=-3)

        ok, encoded = cv2.imencode(".jpg", enhanced, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
        if not ok:
            return image_bytes

        log("IMG ENH OK")
        return encoded.tobytes()
    except Exception as error:
        log(f"IMG ENH ERR {error}")
        return image_bytes


def estimate_cloud_coverage(image_bytes: bytes) -> int | None:
    if not LEGACY_CLOUD_COVERAGE_ENABLED:
        return None

    if cv2 is None or np is None:
        return None

    try:
        array = np.frombuffer(image_bytes, dtype=np.uint8)
        frame = cv2.imdecode(array, cv2.IMREAD_COLOR)
        if frame is None:
            return None

        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        lower_blue = np.array([100, 50, 50])
        upper_blue = np.array([130, 255, 255])
        blue_mask = cv2.inRange(hsv, lower_blue, upper_blue)

        total_pixels = frame.shape[0] * frame.shape[1]
        blue_pixels = cv2.countNonZero(blue_mask)
        cloud_pixels = max(0, total_pixels - blue_pixels)
        return int((cloud_pixels / total_pixels) * 100)
    except Exception as error:
        log(f"CLOUD ERR {error}")
        return None


def encode_image_base64(image_bytes: bytes) -> str:
    return base64.b64encode(image_bytes).decode("utf-8")


def append_to_csv(sensor_data: dict, cloud_coverage_percent: int | None) -> None:
    fieldnames = [
        "timestamp",
        "powerWatts",
        "voltageAC",
        "currentAC",
        "frequencyHz",
        "powerFactor",
        "windSpeedMs",
        "temperatureCelsius",
        "humidityPercent",
        "pressureHpa",
        "energyKwh",
        "cloudCoveragePercent",
    ]
    file_exists = os.path.exists(CSV_LOG_FILE)

    row = {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "powerWatts": sensor_data.get("powerWatts"),
        "voltageAC": sensor_data.get("voltageAC"),
        "currentAC": sensor_data.get("currentAC"),
        "frequencyHz": sensor_data.get("frequencyHz"),
        "powerFactor": sensor_data.get("powerFactor"),
        "windSpeedMs": sensor_data.get("windSpeedMs"),
        "temperatureCelsius": sensor_data.get("temperatureCelsius"),
        "humidityPercent": sensor_data.get("humidityPercent"),
        "pressureHpa": sensor_data.get("pressureHpa"),
        "energyKwh": sensor_data.get("energyKwh"),
        "cloudCoveragePercent": cloud_coverage_percent,
    }

    try:
        with open(CSV_LOG_FILE, "a", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            if not file_exists:
                writer.writeheader()
            writer.writerow(row)
    except Exception as error:
        log(f"CSV ERR {error}")


def send_sensor_data_dashboard(sensor_data: dict) -> bool:
    required_fields = (
        "powerWatts",
        "temperatureCelsius",
        "humidityPercent",
        "windSpeedMs",
    )
    missing = [field for field in required_fields if field not in sensor_data]
    if missing:
        log(f"TX D SKIP miss={','.join(missing)}")
        return False

    payload = {"json": sensor_data}

    try:
        response = post_json_with_retry(
            DASHBOARD_SENSORS_API_URL,
            payload,
            REQUEST_TIMEOUT_SECONDS,
            "TX D",
        )
        if response.status_code == 200:
            log(
                "TX D OK "
                f"P={sensor_data['powerWatts']}W "
                f"PF={sensor_data.get('powerFactor')} "
                f"F={sensor_data.get('frequencyHz')}Hz "
                f"T={sensor_data['temperatureCelsius']}C "
                f"H={sensor_data['humidityPercent']}%"
            )
            return True

        log(f"TX D FAIL {response.status_code} {response.text[:120]}")
        return False
    except Exception as error:
        log(f"TX D ERR {error}")
        return False


def send_sensor_data_fastapi(sensor_data: dict) -> bool:
    required_fields = (
        "powerWatts",
        "temperatureCelsius",
        "humidityPercent",
        "windSpeedMs",
    )
    missing = [field for field in required_fields if field not in sensor_data]
    if missing:
        log(f"TX F SKIP miss={','.join(missing)}")
        return False

    try:
        response = post_json_with_retry(
            FASTAPI_SENSORS_API_URL,
            sensor_data,
            REQUEST_TIMEOUT_SECONDS,
            "TX F",
        )
        if response.status_code == 200:
            log(
                "TX F OK "
                f"P={sensor_data['powerWatts']}W "
                f"PF={sensor_data.get('powerFactor')} "
                f"F={sensor_data.get('frequencyHz')}Hz "
                f"T={sensor_data['temperatureCelsius']}C "
                f"H={sensor_data['humidityPercent']}%"
            )
            return True

        log(f"TX F FAIL {response.status_code} {response.text[:120]}")
        return False
    except Exception as error:
        log(f"TX F ERR {error}")
        return False


def build_cloud_vector_data(cloud_coverage_percent: int | None) -> str:
    payload = {
        "source": "raspberry-pi-5",
        "capture": CAMERA_COMMAND[0] if CAMERA_COMMAND else "unknown",
        "analysis": CLOUD_COVERAGE_ALGORITHM,
        "cloudCoverageConfidence": CLOUD_COVERAGE_CONFIDENCE,
        "cloudCoveragePercent": cloud_coverage_percent,
        "legacyCloudCoverageEnabled": LEGACY_CLOUD_COVERAGE_ENABLED,
        "cameraSetup": IMAGE_CAMERA_SETUP,
        "datasetPhase": IMAGE_DATASET_PHASE,
        "modelNote": IMAGE_MODEL_NOTE,
        "imageEnhancementEnabled": IMAGE_ENHANCE_ENABLED,
        "captureWidth": CAPTURE_WIDTH,
        "captureHeight": CAPTURE_HEIGHT,
        "jpegQuality": JPEG_QUALITY,
        "focusMode": "manual",
        "lensPosition": 0.0,
        "timestampLocal": datetime.now().isoformat(),
    }
    return json.dumps(payload, separators=(",", ":"))


def send_image_data_dashboard(image_base64: str, cloud_coverage_percent: int | None) -> bool:
    cloud_vector_data = build_cloud_vector_data(cloud_coverage_percent)
    payload_json = {
        "imageData": image_base64,
        "mimeType": "image/jpeg",
        "cloudVectorData": cloud_vector_data,
    }
    if cloud_coverage_percent is not None:
        payload_json["cloudCoveragePercent"] = cloud_coverage_percent
    payload = {"json": payload_json}

    try:
        response = post_json_with_retry(
            DASHBOARD_IMAGES_API_URL,
            payload,
            REQUEST_TIMEOUT_SECONDS,
            "IMG D",
        )
        if response.status_code == 200:
            coverage_label = f"{cloud_coverage_percent}%" if cloud_coverage_percent is not None else "disabled"
            log(
                "IMG D OK "
                f"C={coverage_label} "
                f"N={len(image_base64)}"
            )
            return True

        log(f"IMG D FAIL {response.status_code} {response.text[:120]}")
        return False
    except Exception as error:
        log(f"IMG D ERR {error}")
        return False


def send_image_data_fastapi(image_base64: str, cloud_coverage_percent: int | None) -> bool:
    cloud_vector_data = build_cloud_vector_data(cloud_coverage_percent)
    payload = {
        "imageData": image_base64,
        "mimeType": "image/jpeg",
        "cloudVectorData": cloud_vector_data,
    }
    if cloud_coverage_percent is not None:
        payload["cloudCoveragePercent"] = cloud_coverage_percent

    try:
        response = post_json_with_retry(
            FASTAPI_IMAGES_API_URL,
            payload,
            REQUEST_TIMEOUT_SECONDS,
            "IMG F",
        )
        if response.status_code == 200:
            coverage_label = f"{cloud_coverage_percent}%" if cloud_coverage_percent is not None else "disabled"
            log(
                "IMG F OK "
                f"C={coverage_label} "
                f"N={len(image_base64)}"
            )
            return True

        log(f"IMG F FAIL {response.status_code} {response.text[:120]}")
        return False
    except Exception as error:
        log(f"IMG F ERR {error}")
        return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Raspberry Pi 5 uploader for the Solar Dashboard"
    )
    parser.add_argument("--target-ip", default=TARGET_IP, help="Notebook/server IP address")
    parser.add_argument("--dashboard-port", type=int, default=DASHBOARD_PORT)
    parser.add_argument("--fastapi-port", type=int, default=FASTAPI_PORT)
    parser.add_argument("--pzem-port", default=PZEM_PORT)
    parser.add_argument("--wind-port", default=WIND_PORT)
    parser.add_argument("--pzem-slave-id", type=int, default=PZEM_SLAVE_ID)
    parser.add_argument("--wind-slave-id", type=int, default=WIND_SLAVE_ID)
    parser.add_argument("--pzem-baudrate", type=int, default=PZEM_BAUDRATE)
    parser.add_argument("--wind-baudrate", type=int, default=WIND_BAUDRATE)
    parser.add_argument("--sensor-interval", type=int, default=SENSOR_INTERVAL_SECONDS)
    parser.add_argument("--image-interval", type=int, default=IMAGE_INTERVAL_SECONDS)
    parser.add_argument("--mock", action="store_true", help="Use mock sensor values")
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit")
    return parser.parse_args()


def main() -> int:
    global DASHBOARD_BASE_URL
    global FASTAPI_BASE_URL
    global DASHBOARD_SENSORS_API_URL
    global DASHBOARD_IMAGES_API_URL
    global FASTAPI_SENSORS_API_URL
    global FASTAPI_IMAGES_API_URL

    args = parse_args()
    DASHBOARD_BASE_URL = f"http://{args.target_ip}:{args.dashboard_port}"
    FASTAPI_BASE_URL = f"http://{args.target_ip}:{args.fastapi_port}"
    DASHBOARD_SENSORS_API_URL = f"{DASHBOARD_BASE_URL}/api/trpc/sensors.create"
    DASHBOARD_IMAGES_API_URL = f"{DASHBOARD_BASE_URL}/api/trpc/images.upload"
    FASTAPI_SENSORS_API_URL = f"{FASTAPI_BASE_URL}/ingest/sensor"
    FASTAPI_IMAGES_API_URL = f"{FASTAPI_BASE_URL}/ingest/image-direct"

    log("Solar Pi start")
    log(f"D SEN {DASHBOARD_SENSORS_API_URL}")
    log(f"D IMG {DASHBOARD_IMAGES_API_URL}")
    log(f"F SEN {FASTAPI_SENSORS_API_URL}")
    log(f"F IMG {FASTAPI_IMAGES_API_URL}")
    log(f"PZEM {args.pzem_port}@{args.pzem_baudrate} s{args.pzem_slave_id}")
    log(f"WIND {args.wind_port}@{args.wind_baudrate} s{args.wind_slave_id}")
    log(f"CAM  {CAMERA_COMMAND[0] if CAMERA_COMMAND else 'not found'}")
    log(
        "WIN  "
        f"{ACTIVE_START_HOUR:02d}:{ACTIVE_START_MINUTE:02d}"
        f" - {ACTIVE_END_HOUR:02d}:{ACTIVE_END_MINUTE:02d}"
    )

    hardware = Hardware(
        enable_mock=args.mock,
        pzem_port=args.pzem_port,
        wind_port=args.wind_port,
        pzem_slave_id=args.pzem_slave_id,
        wind_slave_id=args.wind_slave_id,
        pzem_baudrate=args.pzem_baudrate,
        wind_baudrate=args.wind_baudrate,
    )
    try:
        hardware.setup()
    except Exception as error:
        log(f"HW ERR {error}")
        return 1

    last_image_sent_at = 0.0
    last_standby_log_minute = -1
    last_cloud_coverage: int | None = None

    try:
        while True:
            started_at = time.time()
            try:
                update_runtime_status("cycle_start")
                now_dt = datetime.now()

                if not is_active_window(now_dt):
                    if now_dt.minute % 10 == 0 and now_dt.minute != last_standby_log_minute:
                        last_standby_log_minute = now_dt.minute
                        log(
                            f"STBY wait {ACTIVE_START_HOUR:02d}:{ACTIVE_START_MINUTE:02d}"
                        )
                    update_runtime_status("standby")
                    time.sleep(STANDBY_SLEEP_SECONDS)
                    continue

                log("RD START")
                sensor_data = hardware.read()
                log("RD DONE")
                update_runtime_status("read_done", has_data=bool(sensor_data))

                if sensor_data:
                    log("TX D START")
                    send_sensor_data_dashboard(sensor_data)
                    log("TX D DONE")

                    log("TX F START")
                    send_sensor_data_fastapi(sensor_data)
                    log("TX F DONE")

                    append_to_csv(sensor_data, last_cloud_coverage)

                    should_send_image = (
                        last_image_sent_at == 0.0
                        or (started_at - last_image_sent_at) >= args.image_interval
                    )

                    if should_send_image:
                        image_bytes = capture_image_bytes()
                        if image_bytes:
                            log("CLOUD START")
                            cloud_coverage = estimate_cloud_coverage(image_bytes)
                            image_base64 = encode_image_base64(image_bytes)
                            log("CLOUD DONE")

                            if image_base64:
                                log("IMG D START")
                                send_image_data_dashboard(image_base64, cloud_coverage)
                                log("IMG D DONE")

                                log("IMG F START")
                                send_image_data_fastapi(image_base64, cloud_coverage)
                                log("IMG F DONE")

                                last_cloud_coverage = cloud_coverage
                                last_image_sent_at = time.time()
                                update_runtime_status(
                                    "cycle_ok",
                                    cloudCoveragePercent=cloud_coverage,
                                    cloudCoverageConfidence=CLOUD_COVERAGE_CONFIDENCE,
                                    datasetPhase=IMAGE_DATASET_PHASE,
                                    powerWatts=sensor_data.get("powerWatts"),
                                )
                            else:
                                log("IMG SKIP empty b64")
                                update_runtime_status("cycle_ok", note="empty_b64")
                        else:
                            log("IMG SKIP no bytes")
                            update_runtime_status("cycle_ok", note="no_image_bytes")
                    else:
                        update_runtime_status(
                            "cycle_ok",
                            note="sensor_only",
                            powerWatts=sensor_data.get("powerWatts"),
                        )
                else:
                    log("RD SKIP no data")
                    update_runtime_status("cycle_ok", note="no_sensor_data")

                if args.once:
                    break

            except Exception as cycle_error:
                log(f"CYCLE ERR {cycle_error}")
                record_runtime_error("cycle", str(cycle_error))
                update_runtime_status("cycle_error", error=str(cycle_error))

            elapsed = time.time() - started_at
            time.sleep(max(0.0, args.sensor_interval - elapsed))

    except KeyboardInterrupt:
        log("STOP by user")
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())

