from __future__ import annotations

import argparse
import json
import pickle
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from train_cloud_vs_sky_fixedmask_patch_rf import overlay_mask, predict_three_class_mask


CLASS_LABELS = {
    0: "cloud",
    1: "sky",
    2: "building",
}

CONTOUR_COLOR = (0, 255, 255)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate prototype cloudVectorData JSON and overlay previews from the current patch-based RF model."
    )
    parser.add_argument("--model", required=True, help="Path to fixedmask patch RF model pickle.")
    parser.add_argument("--output-dir", required=True, help="Directory to store JSON and preview outputs.")
    parser.add_argument("--image", action="append", default=[], help="Specific image path. Can be passed multiple times.")
    parser.add_argument("--image-glob", action="append", default=[], help="Glob pattern for images.")
    parser.add_argument("--max-images", type=int, default=6, help="Maximum number of images to process.")
    parser.add_argument("--cloud-threshold", type=float, default=None, help="Override cloud threshold from the saved model.")
    return parser.parse_args()


def load_bundle(model_path: Path) -> dict[str, object]:
    with model_path.open("rb") as handle:
        bundle = pickle.load(handle)
    required = {"model", "image_size", "fixed_building_mask", "patch_radius", "grid_size"}
    missing = required - set(bundle.keys())
    if missing:
        raise SystemExit(f"Model bundle missing keys: {sorted(missing)}")
    bundle["fixed_building_mask"] = np.asarray(bundle["fixed_building_mask"]).astype(bool)
    return bundle


def collect_images(image_args: list[str], glob_args: list[str], max_images: int) -> list[Path]:
    candidates: list[Path] = []
    seen: set[Path] = set()

    for raw in image_args:
        path = Path(raw)
        if path.exists() and path not in seen:
            candidates.append(path)
            seen.add(path)

    for pattern in glob_args:
        for path in sorted(Path().glob(pattern)):
            if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"} and path not in seen:
                candidates.append(path)
                seen.add(path)

    if not candidates:
        raise SystemExit("No images selected.")
    return candidates[:max_images]


def simplify_contour(contour: np.ndarray, width: int, height: int) -> list[list[float]]:
    if contour.shape[0] < 3:
        return []
    perimeter = cv2.arcLength(contour, True)
    epsilon = max(1.5, perimeter * 0.012)
    approx = cv2.approxPolyDP(contour, epsilon, True)
    points: list[list[float]] = []
    for point in approx[:, 0, :]:
        x, y = int(point[0]), int(point[1])
        points.append(
            [
                round(x / max(width - 1, 1), 6),
                round(y / max(height - 1, 1), 6),
            ]
        )
    return points


def build_cloud_vector(mask: np.ndarray, image_name: str, cloud_threshold: float) -> dict[str, object]:
    height, width = mask.shape
    cloud_mask = (mask == 0).astype(np.uint8)
    sky_mask = (mask == 1).astype(np.uint8)
    building_mask = (mask == 2).astype(np.uint8)

    cloud_pixels = int(cloud_mask.sum())
    sky_pixels = int(sky_mask.sum())
    building_pixels = int(building_mask.sum())
    non_building_pixels = max(cloud_pixels + sky_pixels, 1)

    contours, _ = cv2.findContours(cloud_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contour_rows: list[dict[str, object]] = []
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
                "areaPercentOfSky": round((area / non_building_pixels) * 100.0, 4),
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
        "source": "patch-rf-prototype",
        "analysis": "fixed-building-mask-patch-rf",
        "vectorFormat": "cloud-contours-v1",
        "cloudCoverageConfidence": "experimental",
        "legacyCloudCoverageEnabled": False,
        "datasetPhase": "prototype_cloud_vector",
        "cameraSetup": "Pi Camera Module 3 Wide, no add-on lens",
        "modelNote": "Patch-based RandomForest with fixed building mask; output is experimental and should be reviewed visually.",
        "imageName": image_name,
        "imageWidth": width,
        "imageHeight": height,
        "timestampLocal": datetime.now().isoformat(),
        "cloudCoveragePercent": round((cloud_pixels / non_building_pixels) * 100.0, 4),
        "skyCoveragePercent": round((sky_pixels / non_building_pixels) * 100.0, 4),
        "buildingCoveragePercent": round((building_pixels / (height * width)) * 100.0, 4),
        "cloudPixels": cloud_pixels,
        "skyPixels": sky_pixels,
        "buildingPixels": building_pixels,
        "skyRegionPixels": non_building_pixels,
        "cloudRegionCount": len(contour_rows),
        "largestCloudRegionPercent": round((largest_area / non_building_pixels) * 100.0, 4) if largest_area else 0.0,
        "cloudThreshold": cloud_threshold,
        "classLabels": CLASS_LABELS,
        "cloudContours": contour_rows[:12],
    }


def draw_cloud_contours(image_bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    rendered = overlay_mask(image_bgr, mask, alpha=0.34)
    contours, _ = cv2.findContours((mask == 0).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(rendered, contours, -1, CONTOUR_COLOR, 2)
    return rendered


def save_mask_preview(mask: np.ndarray, output_path: Path) -> None:
    color_layer = np.zeros((mask.shape[0], mask.shape[1], 3), dtype=np.uint8)
    color_layer[mask == 0] = (0, 191, 255)
    color_layer[mask == 1] = (255, 180, 50)
    color_layer[mask == 2] = (180, 180, 180)
    cv2.imwrite(str(output_path), color_layer)


def main() -> None:
    args = parse_args()
    model_path = Path(args.model)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    bundle = load_bundle(model_path)
    model = bundle["model"]
    image_size = int(bundle["image_size"])
    fixed_building_mask = bundle["fixed_building_mask"]
    patch_radius = int(bundle["patch_radius"])
    grid_size = int(bundle["grid_size"])
    cloud_threshold = float(args.cloud_threshold if args.cloud_threshold is not None else bundle.get("cloud_threshold", 0.5))

    images = collect_images(args.image, args.image_glob, args.max_images)
    manifest_rows: list[dict[str, object]] = []

    for image_path in images:
        image = cv2.imread(str(image_path))
        if image is None:
            continue

        mask = predict_three_class_mask(
            model=model,
            image_bgr=image,
            image_size=image_size,
            fixed_building_mask=fixed_building_mask,
            patch_radius=patch_radius,
            grid_size=grid_size,
            cloud_threshold=cloud_threshold,
        )
        vector = build_cloud_vector(mask, image_path.name, cloud_threshold)

        stem = image_path.stem
        json_path = output_dir / f"{stem}_cloud_vector.json"
        overlay_path = output_dir / f"{stem}_prediction_overlay.jpg"
        mask_path = output_dir / f"{stem}_mask.png"

        json_path.write_text(json.dumps(vector, indent=2), encoding="utf-8")
        cv2.imwrite(str(overlay_path), draw_cloud_contours(image, mask))
        save_mask_preview(mask, mask_path)

        manifest_rows.append(
            {
                "image": image_path.name,
                "cloudCoveragePercent": vector["cloudCoveragePercent"],
                "skyCoveragePercent": vector["skyCoveragePercent"],
                "buildingCoveragePercent": vector["buildingCoveragePercent"],
                "cloudRegionCount": vector["cloudRegionCount"],
                "largestCloudRegionPercent": vector["largestCloudRegionPercent"],
                "jsonPath": str(json_path),
                "overlayPath": str(overlay_path),
                "maskPath": str(mask_path),
            }
        )

    summary_path = output_dir / "cloud_vector_manifest.json"
    summary_path.write_text(json.dumps(manifest_rows, indent=2), encoding="utf-8")
    print(json.dumps({"processed": len(manifest_rows), "outputDir": str(output_dir), "manifest": str(summary_path)}, indent=2))


if __name__ == "__main__":
    main()
