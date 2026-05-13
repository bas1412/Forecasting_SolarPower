from __future__ import annotations

import argparse
import csv
import json
import pickle
from pathlib import Path

import cv2
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix


THREE_CLASS_NAMES = ["cloud", "sky", "building"]
BINARY_CLASS_NAMES = ["cloud", "sky"]
COLORS_BGR = {
    0: (0, 191, 255),
    1: (255, 180, 50),
    2: (180, 180, 180),
}


def read_yolo_segmentation(label_path: Path, width: int, height: int) -> np.ndarray:
    mask = np.full((height, width), -1, dtype=np.int16)
    if not label_path.exists() or not label_path.read_text(encoding="utf-8-sig").strip():
        return mask

    for line in label_path.read_text(encoding="utf-8-sig").splitlines():
        parts = line.strip().split()
        if len(parts) < 7:
            continue
        cls = int(float(parts[0]))
        coords = [float(value) for value in parts[1:]]
        points = []
        for idx in range(0, len(coords) - 1, 2):
            x = int(round(coords[idx] * (width - 1)))
            y = int(round(coords[idx + 1] * (height - 1)))
            points.append([x, y])
        if len(points) >= 3:
            cv2.fillPoly(mask, [np.array(points, dtype=np.int32)], cls)
    return mask


def resize_image(image_bgr: np.ndarray, image_size: int) -> np.ndarray:
    original_height, original_width = image_bgr.shape[:2]
    scale = image_size / max(original_width, original_height)
    return cv2.resize(
        image_bgr,
        (max(1, int(round(original_width * scale))), max(1, int(round(original_height * scale)))),
        interpolation=cv2.INTER_AREA,
    )


def image_label_pairs(dataset_root: Path) -> list[tuple[Path, Path]]:
    pairs: list[tuple[Path, Path]] = []
    for split in ["train", "val"]:
        for image_path in sorted((dataset_root / "images" / split).glob("*")):
            if image_path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
                continue
            label_path = dataset_root / "labels" / split / f"{image_path.stem}.txt"
            if label_path.exists() and label_path.stat().st_size > 0:
                pairs.append((image_path, label_path))
    return pairs


def estimate_fixed_building_mask(
    train_pairs: list[tuple[Path, Path]],
    image_size: int,
    building_threshold: float,
    min_seen_ratio: float,
) -> tuple[np.ndarray, dict[str, float]]:
    building_counts: np.ndarray | None = None
    seen_counts: np.ndarray | None = None

    for image_path, label_path in train_pairs:
        image = cv2.imread(str(image_path))
        if image is None:
            continue
        resized = resize_image(image, image_size)
        height, width = resized.shape[:2]
        mask = read_yolo_segmentation(label_path, width, height)

        if building_counts is None:
            building_counts = np.zeros((height, width), dtype=np.float32)
            seen_counts = np.zeros((height, width), dtype=np.float32)

        valid = mask >= 0
        building_counts += (mask == 2).astype(np.float32)
        seen_counts += valid.astype(np.float32)

    if building_counts is None or seen_counts is None:
        raise SystemExit("Unable to estimate fixed building mask.")

    seen_ratio = seen_counts / max(len(train_pairs), 1)
    building_ratio = np.divide(
        building_counts,
        np.maximum(seen_counts, 1.0),
        out=np.zeros_like(building_counts),
        where=seen_counts > 0,
    )
    fixed_mask = (seen_ratio >= min_seen_ratio) & (building_ratio >= building_threshold)
    stats = {
        "building_threshold": building_threshold,
        "min_seen_ratio": min_seen_ratio,
        "fixed_building_pixel_ratio": float(fixed_mask.mean()),
    }
    return fixed_mask, stats


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


def collect_binary_samples(
    train_pairs: list[tuple[Path, Path]],
    fixed_building_mask: np.ndarray,
    image_size: int,
    max_pixels_per_class_per_image: int,
    patch_radius: int,
    grid_size: int,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, object]]]:
    x_parts: list[np.ndarray] = []
    y_parts: list[np.ndarray] = []
    rows: list[dict[str, object]] = []

    for image_path, label_path in train_pairs:
        image = cv2.imread(str(image_path))
        if image is None:
            continue
        resized = resize_image(image, image_size)
        height, width = resized.shape[:2]
        mask = read_yolo_segmentation(label_path, width, height)
        features = make_patch_grid_features(resized, patch_radius, grid_size)
        flat_mask = mask.reshape(-1)
        flat_not_building = (~fixed_building_mask).reshape(-1)

        counts: dict[str, int] = {}
        for cls in [0, 1]:
            indices = np.where((flat_mask == cls) & flat_not_building)[0]
            counts[BINARY_CLASS_NAMES[cls]] = int(indices.size)
            if indices.size == 0:
                continue
            if indices.size > max_pixels_per_class_per_image:
                indices = rng.choice(indices, size=max_pixels_per_class_per_image, replace=False)
            x_parts.append(features[indices])
            y_parts.append(np.full(indices.shape[0], cls, dtype=np.int16))

        counts["building_fixed_pixels"] = int(fixed_building_mask.sum())
        rows.append({"image": image_path.name, **counts})

    if not x_parts:
        raise SystemExit("No binary sky-region pixels found for training.")
    return np.concatenate(x_parts), np.concatenate(y_parts), rows


def predict_three_class_mask(
    model: RandomForestClassifier,
    image_bgr: np.ndarray,
    image_size: int,
    fixed_building_mask: np.ndarray,
    patch_radius: int,
    grid_size: int,
    cloud_threshold: float,
) -> np.ndarray:
    original_height, original_width = image_bgr.shape[:2]
    resized = resize_image(image_bgr, image_size)
    height, width = resized.shape[:2]
    fixed_building_mask = fixed_building_mask.astype(bool)
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
        region_pred = np.where(cloud_prob >= cloud_threshold, 0, 1).astype(np.uint8)
        flat_pred[flat_sky_region] = region_pred
    pred_full = cv2.resize(pred_small, (original_width, original_height), interpolation=cv2.INTER_NEAREST)
    return pred_full


def overlay_mask(image_bgr: np.ndarray, mask: np.ndarray, alpha: float = 0.42) -> np.ndarray:
    overlay = image_bgr.copy()
    color_layer = np.zeros_like(image_bgr)
    for cls, color in COLORS_BGR.items():
        color_layer[mask == cls] = color
    has_label = mask >= 0
    overlay[has_label] = cv2.addWeighted(image_bgr, 1 - alpha, color_layer, alpha, 0)[has_label]
    return overlay


def evaluate_on_val(
    model: RandomForestClassifier,
    val_pairs: list[tuple[Path, Path]],
    output_dir: Path,
    image_size: int,
    fixed_building_mask: np.ndarray,
    patch_radius: int,
    grid_size: int,
    cloud_threshold: float,
) -> dict[str, object]:
    y_true_three: list[np.ndarray] = []
    y_pred_three: list[np.ndarray] = []
    y_true_binary: list[np.ndarray] = []
    y_pred_binary: list[np.ndarray] = []
    output_dir.mkdir(parents=True, exist_ok=True)

    for image_path, label_path in val_pairs:
        image = cv2.imread(str(image_path))
        if image is None:
            continue
        pred_full = predict_three_class_mask(
            model,
            image,
            image_size,
            fixed_building_mask,
            patch_radius,
            grid_size,
            cloud_threshold,
        )
        true_mask = read_yolo_segmentation(label_path, image.shape[1], image.shape[0])
        valid = true_mask >= 0
        sky_region = valid & (true_mask != 2)
        if valid.any():
            y_true_three.append(true_mask[valid].reshape(-1))
            y_pred_three.append(pred_full[valid].reshape(-1))
        if sky_region.any():
            y_true_binary.append(true_mask[sky_region].reshape(-1))
            y_pred_binary.append(pred_full[sky_region].reshape(-1))
        cv2.imwrite(str(output_dir / f"{image_path.stem}_prediction_overlay.jpg"), overlay_mask(image, pred_full))
        cv2.imwrite(str(output_dir / f"{image_path.stem}_truth_overlay.jpg"), overlay_mask(image, true_mask))

    if not y_true_three:
        return {"warning": "No labeled validation pixels found."}

    y_true_all = np.concatenate(y_true_three)
    y_pred_all = np.concatenate(y_pred_three)
    three_report = classification_report(
        y_true_all,
        y_pred_all,
        labels=[0, 1, 2],
        target_names=THREE_CLASS_NAMES,
        zero_division=0,
        output_dict=True,
    )
    three_matrix = confusion_matrix(y_true_all, y_pred_all, labels=[0, 1, 2]).tolist()

    binary_report: dict[str, object] | None = None
    binary_matrix: list[list[int]] | None = None
    if y_true_binary:
        y_true_bin = np.concatenate(y_true_binary)
        y_pred_bin = np.concatenate(y_pred_binary)
        binary_report = classification_report(
            y_true_bin,
            y_pred_bin,
            labels=[0, 1],
            target_names=BINARY_CLASS_NAMES,
            zero_division=0,
            output_dict=True,
        )
        binary_matrix = confusion_matrix(y_true_bin, y_pred_bin, labels=[0, 1]).tolist()

    return {
        "three_class_report": three_report,
        "three_class_confusion_matrix": three_matrix,
        "binary_sky_region_report": binary_report,
        "binary_sky_region_confusion_matrix": binary_matrix,
    }


def save_fixed_mask_preview(output_dir: Path, fixed_building_mask: np.ndarray) -> None:
    preview = np.zeros((fixed_building_mask.shape[0], fixed_building_mask.shape[1], 3), dtype=np.uint8)
    preview[fixed_building_mask] = (180, 180, 180)
    cv2.imwrite(str(output_dir / "fixed_building_mask_preview.png"), preview)


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a fixed-building-mask patch-based cloud-vs-sky RandomForest.")
    parser.add_argument("--dataset", default="report-materials/cloud-segmentation-round4-dataset/bare_camera")
    parser.add_argument("--output", default="report-materials/cloud-vs-sky-fixedmask-patch-rf-results")
    parser.add_argument("--image-size", type=int, default=480)
    parser.add_argument("--max-pixels", type=int, default=1200)
    parser.add_argument("--trees", type=int, default=120)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--building-threshold", type=float, default=0.55)
    parser.add_argument("--min-seen-ratio", type=float, default=0.7)
    parser.add_argument("--patch-radius", type=int, default=6)
    parser.add_argument("--grid-size", type=int, default=5)
    parser.add_argument("--cloud-threshold", type=float, default=0.5)
    args = parser.parse_args()

    dataset_root = Path(args.dataset)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    labeled_pairs = image_label_pairs(dataset_root)
    if len(labeled_pairs) < 2:
        raise SystemExit("Need at least 2 labeled images so one can be used as validation.")

    val_pairs = [(img, lab) for img, lab in labeled_pairs if "\\val\\" in str(lab) or "/val/" in str(lab)]
    if not val_pairs:
        val_pairs = [labeled_pairs[-1]]
        train_pairs = labeled_pairs[:-1]
    else:
        train_pairs = [pair for pair in labeled_pairs if pair not in val_pairs]
    if not train_pairs:
        raise SystemExit("No training labels found.")

    fixed_building_mask, fixed_mask_stats = estimate_fixed_building_mask(
        train_pairs=train_pairs,
        image_size=args.image_size,
        building_threshold=args.building_threshold,
        min_seen_ratio=args.min_seen_ratio,
    )
    save_fixed_mask_preview(output_dir, fixed_building_mask)

    rng = np.random.default_rng(args.seed)
    x_train, y_train, sample_rows = collect_binary_samples(
        train_pairs=train_pairs,
        fixed_building_mask=fixed_building_mask,
        image_size=args.image_size,
        max_pixels_per_class_per_image=args.max_pixels,
        patch_radius=args.patch_radius,
        grid_size=args.grid_size,
        rng=rng,
    )

    model = RandomForestClassifier(
        n_estimators=args.trees,
        max_depth=24,
        min_samples_leaf=2,
        n_jobs=-1,
        random_state=args.seed,
        class_weight="balanced_subsample",
    )
    model.fit(x_train, y_train)

    with (output_dir / "fixedmask-patch-rf-model.pkl").open("wb") as file:
        pickle.dump(
            {
                "model": model,
                "class_names": THREE_CLASS_NAMES,
                "binary_class_names": BINARY_CLASS_NAMES,
                "image_size": args.image_size,
                "fixed_building_mask": fixed_building_mask.astype(np.uint8),
                "fixed_mask_stats": fixed_mask_stats,
                "patch_radius": args.patch_radius,
                "grid_size": args.grid_size,
            },
            file,
        )

    metrics = evaluate_on_val(
        model,
        val_pairs,
        output_dir / "previews",
        args.image_size,
        fixed_building_mask,
        args.patch_radius,
        args.grid_size,
        args.cloud_threshold,
    )
    summary = {
        "dataset": str(dataset_root),
        "train_images": [pair[0].name for pair in train_pairs],
        "val_images": [pair[0].name for pair in val_pairs],
        "x_train_shape": list(x_train.shape),
        "feature_strategy": "fixed_building_mask_patch_grid_rf",
        "fixed_mask_stats": fixed_mask_stats,
        "patch_radius": args.patch_radius,
        "grid_size": args.grid_size,
        "cloud_threshold": args.cloud_threshold,
        "metrics": metrics,
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    with (output_dir / "sample-counts.csv").open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=["image", "cloud", "sky", "building_fixed_pixels"])
        writer.writeheader()
        writer.writerows(sample_rows)

    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
