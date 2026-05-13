from __future__ import annotations

import json
import pickle
from datetime import datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np


APP_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = APP_ROOT.parent
MODEL_PATH = PROJECT_ROOT / "report-materials" / "binary-cloud-noncloud-collab60-round1" / "train" / "fixedmask-patch-rf-model.pkl"

COLORS_BGR = {
    0: (0, 191, 255),
    1: (255, 180, 50),
    2: (180, 180, 180),
}

_MODEL_BUNDLE: dict[str, Any] | None = None


def resize_image(image_bgr: np.ndarray, image_size: int) -> np.ndarray:
    original_height, original_width = image_bgr.shape[:2]
    scale = image_size / max(original_width, original_height)
    return cv2.resize(
        image_bgr,
        (max(1, int(round(original_width * scale))), max(1, int(round(original_height * scale)))),
        interpolation=cv2.INTER_AREA,
    )


def make_patch_grid_features(image_bgr: np.ndarray, patch_radius: int, grid_size: int) -> np.ndarray:
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 0] /= 179.0
    hsv[..., 1:] /= 255.0
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0

    sobel_x = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    grad_mag = np.sqrt(sobel_x * sobel_x + sobel_y * sobel_y)
    grad_mag /= grad_mag.max() + 1e-6

    sky_likeness = np.clip(rgb[..., 2] - rgb[..., 0], 0.0, 1.0)
    sat = hsv[..., 1]
    channel_stack = np.stack([gray, sat, sky_likeness, grad_mag], axis=-1)

    height, width = gray.shape
    pad = patch_radius
    padded = np.pad(channel_stack, ((pad, pad), (pad, pad), (0, 0)), mode="reflect")

    offsets = np.linspace(-patch_radius, patch_radius, grid_size)
    offsets = np.rint(offsets).astype(int)

    feature_maps: list[np.ndarray] = []
    for dy in offsets:
        for dx in offsets:
            view = padded[pad + dy : pad + dy + height, pad + dx : pad + dx + width]
            feature_maps.append(view)

    yy, xx = np.mgrid[0:height, 0:width]
    xy = np.stack(
        [
            xx / max(width - 1, 1),
            yy / max(height - 1, 1),
        ],
        axis=-1,
    ).astype(np.float32)
    feature_maps.append(xy)

    features = np.concatenate(feature_maps, axis=-1)
    return features.reshape(-1, features.shape[-1])


def get_model_bundle() -> dict[str, Any]:
    global _MODEL_BUNDLE
    if _MODEL_BUNDLE is None:
        with MODEL_PATH.open("rb") as handle:
            bundle = pickle.load(handle)
        bundle["fixed_building_mask"] = np.asarray(bundle["fixed_building_mask"]).astype(bool)
        _MODEL_BUNDLE = bundle
    return _MODEL_BUNDLE


def predict_three_class_mask(image_bgr: np.ndarray, cloud_threshold: float | None = None) -> np.ndarray:
    bundle = get_model_bundle()
    model = bundle["model"]
    image_size = int(bundle["image_size"])
    fixed_building_mask = bundle["fixed_building_mask"].astype(bool)
    patch_radius = int(bundle["patch_radius"])
    grid_size = int(bundle["grid_size"])
    threshold = float(cloud_threshold if cloud_threshold is not None else bundle.get("cloud_threshold", 0.5))

    original_height, original_width = image_bgr.shape[:2]
    resized = resize_image(image_bgr, image_size)
    height, width = resized.shape[:2]

    if (height, width) != fixed_building_mask.shape:
        resized_building_mask = cv2.resize(
            fixed_building_mask.astype(np.uint8),
            (width, height),
            interpolation=cv2.INTER_NEAREST,
        ).astype(bool)
    else:
        resized_building_mask = fixed_building_mask

    pred_small = np.full((height, width), 2, dtype=np.uint8)
    sky_region = ~resized_building_mask
    features = make_patch_grid_features(resized, patch_radius, grid_size)
    flat_pred = pred_small.reshape(-1)
    flat_sky_region = sky_region.reshape(-1)

    if flat_sky_region.any():
        region_features = features[flat_sky_region]
        probabilities = model.predict_proba(region_features)
        cloud_prob = probabilities[:, 0]
        region_pred = np.where(cloud_prob >= threshold, 0, 1).astype(np.uint8)
        flat_pred[flat_sky_region] = region_pred

    return cv2.resize(pred_small, (original_width, original_height), interpolation=cv2.INTER_NEAREST)


def simplify_contour(contour: np.ndarray, width: int, height: int) -> list[list[float]]:
    if contour.shape[0] < 3:
        return []
    perimeter = cv2.arcLength(contour, True)
    epsilon = max(1.5, perimeter * 0.012)
    approx = cv2.approxPolyDP(contour, epsilon, True)
    return [
        [
            round(int(point[0]) / max(width - 1, 1), 6),
            round(int(point[1]) / max(height - 1, 1), 6),
        ]
        for point in approx[:, 0, :]
    ]


def build_cloud_vector(mask: np.ndarray, image_name: str, cloud_threshold: float) -> dict[str, Any]:
    height, width = mask.shape
    cloud_mask = (mask == 0).astype(np.uint8)
    sky_mask = (mask == 1).astype(np.uint8)
    building_mask = (mask == 2).astype(np.uint8)

    cloud_pixels = int(cloud_mask.sum())
    sky_pixels = int(sky_mask.sum())
    building_pixels = int(building_mask.sum())
    sky_region_pixels = max(cloud_pixels + sky_pixels, 1)

    contours, _ = cv2.findContours(cloud_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contour_rows: list[dict[str, Any]] = []
    largest_area = 0.0

    for index, contour in enumerate(sorted(contours, key=cv2.contourArea, reverse=True)):
        area = float(cv2.contourArea(contour))
        if area < 40:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        polygon = simplify_contour(contour, width, height)
        if len(polygon) < 3:
            continue
        largest_area = max(largest_area, area)
        contour_rows.append(
            {
                "id": index + 1,
                "areaPixels": round(area, 2),
                "areaPercentOfSky": round((area / sky_region_pixels) * 100.0, 4),
                "boundingBoxNorm": {
                    "x": round(x / max(width - 1, 1), 6),
                    "y": round(y / max(height - 1, 1), 6),
                    "w": round(w / max(width, 1), 6),
                    "h": round(h / max(height, 1), 6),
                },
                "polygon": polygon,
            }
        )

    return {
        "source": "notebook-fastapi",
        "analysis": "fixed-building-mask-patch-rf",
        "vectorFormat": "cloud-contours-v1",
        "cloudCoverageConfidence": "experimental",
        "legacyCloudCoverageEnabled": False,
        "datasetPhase": "prototype_cloud_vector",
        "cameraSetup": "Pi Camera Module 3 Wide, no add-on lens",
        "modelNote": "Notebook-side ML cloudVector prototype derived from patch-based RandomForest segmentation.",
        "imageName": image_name,
        "imageWidth": width,
        "imageHeight": height,
        "timestampLocal": datetime.now().isoformat(),
        "cloudCoveragePercent": round((cloud_pixels / sky_region_pixels) * 100.0, 4),
        "skyCoveragePercent": round((sky_pixels / sky_region_pixels) * 100.0, 4),
        "buildingCoveragePercent": round((building_pixels / (height * width)) * 100.0, 4),
        "cloudPixels": cloud_pixels,
        "skyPixels": sky_pixels,
        "buildingPixels": building_pixels,
        "skyRegionPixels": sky_region_pixels,
        "cloudRegionCount": len(contour_rows),
        "largestCloudRegionPercent": round((largest_area / sky_region_pixels) * 100.0, 4) if largest_area else 0.0,
        "cloudThreshold": cloud_threshold,
        "classLabels": {"0": "cloud", "1": "sky", "2": "building"},
        "cloudContours": contour_rows[:12],
    }


def infer_cloud_vector(image_bytes: bytes, image_name: str = "live_image.jpg", cloud_threshold: float | None = None) -> dict[str, Any]:
    array = np.frombuffer(image_bytes, dtype=np.uint8)
    image_bgr = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image_bgr is None:
        raise ValueError("Unable to decode image bytes for cloud vector inference.")

    bundle = get_model_bundle()
    threshold = float(cloud_threshold if cloud_threshold is not None else bundle.get("cloud_threshold", 0.5))
    mask = predict_three_class_mask(image_bgr, cloud_threshold=threshold)
    return build_cloud_vector(mask, image_name=image_name, cloud_threshold=threshold)


def infer_cloud_vector_json(image_bytes: bytes, image_name: str = "live_image.jpg", cloud_threshold: float | None = None) -> tuple[int, str]:
    result = infer_cloud_vector(image_bytes, image_name=image_name, cloud_threshold=cloud_threshold)
    rounded_coverage = int(round(float(result["cloudCoveragePercent"])))
    return rounded_coverage, json.dumps(result, separators=(",", ":"))
