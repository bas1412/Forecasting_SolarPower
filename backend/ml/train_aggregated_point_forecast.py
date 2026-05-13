from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from joblib import dump
from sklearn.ensemble import ExtraTreesRegressor


TIME_BUCKETS = [
    (5, 8, "05-08"),
    (8, 11, "08-11"),
    (11, 14, "11-14"),
    (14, 17, "14-17"),
    (17, 19, "17-19"),
]

NUMERIC_COLUMNS = [
    "PowerWatts",
    "VoltageAC",
    "CurrentAC",
    "CurrentReliable",
    "PowerFactorClean",
    "PowerFactorReliable",
    "FrequencyHz",
    "FrequencyReliable",
    "TemperatureAtInstallC",
    "HighTemperatureAtInstallFlag",
    "HumidityAtInstallPercent",
    "Humidity100Flag",
    "WindSpeedMs",
    "VoltageReliable",
    "ElectricalLowConfidence",
]

FLAG_COLUMNS = [
    "CurrentReliable",
    "PowerFactorReliable",
    "FrequencyReliable",
    "HighTemperatureAtInstallFlag",
    "Humidity100Flag",
    "VoltageReliable",
    "ElectricalLowConfidence",
]

FEATURE_COLUMNS = [
    "PowerWatts",
    "VoltageAC",
    "CurrentAC",
    "CurrentReliable",
    "PowerFactorClean",
    "PowerFactorReliable",
    "FrequencyHz",
    "FrequencyReliable",
    "TemperatureAtInstallC",
    "HighTemperatureAtInstallFlag",
    "HumidityAtInstallPercent",
    "Humidity100Flag",
    "WindSpeedMs",
    "VoltageReliable",
    "ElectricalLowConfidence",
    "MinuteOfDaySin",
    "MinuteOfDayCos",
    "PowerLag5Min",
    "PowerLag10Min",
    "PowerLag15Min",
    "PowerLag30Min",
    "PowerLag60Min",
    "PowerRollingMean15Min",
    "PowerRollingMean30Min",
    "PowerRollingMean60Min",
]

TARGET_SPECS = {
    5: {"name": "Target5MinPoint", "step": 1, "label": "+5 min point"},
    10: {"name": "Target10MinPoint", "step": 2, "label": "+10 min point"},
    15: {"name": "Target15MinPoint", "step": 3, "label": "+15 min point"},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train a 5-minute aggregated point forecast for +5/+10/+15 minute horizons."
    )
    parser.add_argument("--old-sensor-csv", required=True)
    parser.add_argument("--new-sensor-csv", required=True)
    parser.add_argument("--train-end-date", required=True)
    parser.add_argument("--output-prefix", required=True)
    return parser.parse_args()


def load_combined_dataframe(old_csv: Path, new_csv: Path) -> pd.DataFrame:
    old_df = pd.read_csv(old_csv)
    new_df = pd.read_csv(new_csv)
    for df in (old_df, new_df):
        df["dt"] = pd.to_datetime(df["TimestampLocal"])
        df.sort_values("dt", inplace=True)
    combined = pd.concat([old_df, new_df], ignore_index=True)
    combined = combined.drop_duplicates(subset=["TimestampLocal"], keep="last")
    combined = combined.sort_values("dt").set_index("dt")
    return combined


def build_aggregated_frame(df: pd.DataFrame) -> pd.DataFrame:
    agg = df[NUMERIC_COLUMNS].resample("5min").mean().interpolate(limit_direction="both")

    for column in FLAG_COLUMNS:
        agg[column] = (agg[column] >= 0.5).astype(int)

    minute_of_day = agg.index.hour * 60 + agg.index.minute
    radians = 2 * math.pi * minute_of_day / 1440.0
    agg["MinuteOfDaySin"] = np.sin(radians)
    agg["MinuteOfDayCos"] = np.cos(radians)

    for steps in [1, 2, 3, 6, 12]:
        agg[f"PowerLag{steps * 5}Min"] = agg["PowerWatts"].shift(steps)
    for steps in [3, 6, 12]:
        agg[f"PowerRollingMean{steps * 5}Min"] = agg["PowerWatts"].rolling(steps, min_periods=1).mean()

    for spec in TARGET_SPECS.values():
        agg[spec["name"]] = agg["PowerWatts"].shift(-spec["step"])

    return agg.dropna().reset_index()


def split_train_test(df: pd.DataFrame, train_end_date: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    train_end = pd.Timestamp(train_end_date) + pd.Timedelta(days=1)
    train = df[df["dt"] < train_end].copy()
    test = df[df["dt"] >= train_end].copy()
    return train, test


def bucket_name(timestamp: pd.Timestamp) -> str:
    hour_value = timestamp.hour + timestamp.minute / 60.0
    for start, end, name in TIME_BUCKETS:
        if start <= hour_value < end:
            return name
    return "other"


def wmape_accuracy(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    abs_error = np.abs(y_pred - y_true).sum()
    actual_sum = np.abs(y_true).sum()
    return max(0.0, 100.0 - (abs_error / max(actual_sum, 1e-9) * 100.0))


def evaluate_by_bucket(
    timestamps: pd.Series,
    y_true: np.ndarray,
    y_pred: np.ndarray,
) -> dict[str, dict[str, float]]:
    groups: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for timestamp, actual, pred in zip(timestamps, y_true, y_pred, strict=False):
        groups[bucket_name(timestamp)].append((float(actual), float(pred)))

    metrics: dict[str, dict[str, float]] = {}
    for name, values in groups.items():
        actual = np.array([item[0] for item in values], dtype=float)
        pred = np.array([item[1] for item in values], dtype=float)
        mae = float(np.mean(np.abs(pred - actual)))
        accuracy = wmape_accuracy(actual, pred)
        metrics[name] = {
            "rows": int(len(values)),
            "accuracyPercent": round(accuracy, 4),
            "maeWatts": round(mae, 4),
        }
    return metrics


def summarize_model(
    timestamps: pd.Series,
    y_true: np.ndarray,
    y_pred: np.ndarray,
) -> dict[str, Any]:
    mae = float(np.mean(np.abs(y_pred - y_true)))
    rmse = float(np.sqrt(np.mean((y_pred - y_true) ** 2)))
    accuracy = wmape_accuracy(y_true, y_pred)
    return {
        "rows": int(len(y_true)),
        "maeWatts": round(mae, 4),
        "rmseWatts": round(rmse, 4),
        "accuracyPercent": round(accuracy, 4),
        "bucketMetrics": evaluate_by_bucket(timestamps, y_true, y_pred),
    }


def summarize_hybrid(
    timestamps: pd.Series,
    y_true: np.ndarray,
    persistence_pred: np.ndarray,
    extra_pred: np.ndarray,
) -> dict[str, Any]:
    bucket_groups: dict[str, list[tuple[float, float, float]]] = defaultdict(list)
    for timestamp, actual, persistence_value, extra_value in zip(
        timestamps, y_true, persistence_pred, extra_pred, strict=False
    ):
        bucket_groups[bucket_name(timestamp)].append(
            (float(actual), float(persistence_value), float(extra_value))
        )

    bucket_choices: dict[str, str] = {}
    hybrid_actual: list[float] = []
    hybrid_pred: list[float] = []
    bucket_metrics: dict[str, dict[str, float | int | str]] = {}

    for bucket, values in bucket_groups.items():
        persistence_error = sum(abs(p - actual) for actual, p, _ in values)
        extra_error = sum(abs(e - actual) for actual, _, e in values)
        choice = "persistence" if persistence_error <= extra_error else "extraTrees"
        bucket_choices[bucket] = choice

        selected_pairs = [
            (actual, p if choice == "persistence" else e)
            for actual, p, e in values
        ]
        actual_array = np.array([pair[0] for pair in selected_pairs], dtype=float)
        pred_array = np.array([pair[1] for pair in selected_pairs], dtype=float)
        bucket_metrics[bucket] = {
            "rows": len(selected_pairs),
            "accuracyPercent": round(wmape_accuracy(actual_array, pred_array), 4),
            "maeWatts": round(float(np.mean(np.abs(pred_array - actual_array))), 4),
            "choice": choice,
        }
        hybrid_actual.extend(actual_array.tolist())
        hybrid_pred.extend(pred_array.tolist())

    hybrid_actual_arr = np.array(hybrid_actual, dtype=float)
    hybrid_pred_arr = np.array(hybrid_pred, dtype=float)
    mae = float(np.mean(np.abs(hybrid_pred_arr - hybrid_actual_arr)))
    rmse = float(np.sqrt(np.mean((hybrid_pred_arr - hybrid_actual_arr) ** 2)))
    accuracy = wmape_accuracy(hybrid_actual_arr, hybrid_pred_arr)
    return {
        "rows": int(len(hybrid_actual_arr)),
        "maeWatts": round(mae, 4),
        "rmseWatts": round(rmse, 4),
        "accuracyPercent": round(accuracy, 4),
        "bucketMetrics": bucket_metrics,
        "bucketChoice": bucket_choices,
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    headers = list(rows[0].keys())
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def write_markdown(path: Path, payload: dict[str, Any]) -> None:
    lines = [
        "# Aggregated Point Forecast Summary",
        "",
        f"- Train period: up to {payload['trainEndDate']}",
        "- Data strategy: combine long sensor history, aggregate to 5-minute intervals, and predict future point values.",
        "- Model: ExtraTreesRegressor",
        "",
        "## Overall Metrics",
        "",
        "| Horizon | Strategy | Rows | Accuracy % | MAE (W) | RMSE (W) |",
        "|---|---|---:|---:|---:|---:|",
    ]

    for horizon in [5, 10, 15]:
        horizon_block = payload["horizons"][str(horizon)]
        for strategy_name in ["persistence", "extraTrees", "hybrid"]:
            metrics = horizon_block[strategy_name]
            lines.append(
                f"| +{horizon} min | {strategy_name} | {metrics['rows']} | "
                f"{metrics['accuracyPercent']} | {metrics['maeWatts']} | {metrics['rmseWatts']} |"
            )

    lines.extend(
        [
            "",
            "## Bucket Metrics",
            "",
            "| Horizon | Strategy | Bucket | Rows | Accuracy % | MAE (W) |",
            "|---|---|---|---:|---:|---:|",
        ]
    )

    for horizon in [5, 10, 15]:
        horizon_block = payload["horizons"][str(horizon)]
        for strategy_name in ["persistence", "extraTrees", "hybrid"]:
            bucket_metrics = horizon_block[strategy_name]["bucketMetrics"]
            for bucket in ["05-08", "08-11", "11-14", "14-17", "17-19"]:
                metrics = bucket_metrics.get(bucket)
                if not metrics:
                    continue
                choice_suffix = f" ({metrics['choice']})" if strategy_name == "hybrid" and "choice" in metrics else ""
                lines.append(
                    f"| +{horizon} min | {strategy_name}{choice_suffix} | {bucket} | {metrics['rows']} | "
                    f"{metrics['accuracyPercent']} | {metrics['maeWatts']} |"
                )

    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    args = parse_args()
    old_csv = Path(args.old_sensor_csv)
    new_csv = Path(args.new_sensor_csv)
    output_prefix = Path(args.output_prefix)
    output_dir = output_prefix.parent
    output_dir.mkdir(parents=True, exist_ok=True)
    model_dir = Path(f"{output_prefix}-models")
    model_dir.mkdir(parents=True, exist_ok=True)

    combined = load_combined_dataframe(old_csv, new_csv)
    aggregated = build_aggregated_frame(combined)
    train_df, test_df = split_train_test(aggregated, args.train_end_date)

    payload: dict[str, Any] = {
        "modelType": "aggregated_point_forecast_extratrees",
        "trainEndDate": args.train_end_date,
        "aggregation": "5min",
        "targetDefinition": "future_point_value",
        "featureNames": FEATURE_COLUMNS,
        "horizons": {},
    }
    prediction_rows: list[dict[str, Any]] = []

    for horizon, spec in TARGET_SPECS.items():
        target_name = spec["name"]
        x_train = train_df[FEATURE_COLUMNS].to_numpy(dtype=float)
        y_train = train_df[target_name].to_numpy(dtype=float)
        x_test = test_df[FEATURE_COLUMNS].to_numpy(dtype=float)
        y_test = test_df[target_name].to_numpy(dtype=float)

        persistence_pred = test_df["PowerWatts"].to_numpy(dtype=float)
        extra_model = ExtraTreesRegressor(
            n_estimators=700,
            min_samples_leaf=2,
            random_state=42,
            n_jobs=-1,
        )
        extra_model.fit(x_train, y_train)
        extra_pred = np.clip(extra_model.predict(x_test), 0, None)

        persistence_metrics = summarize_model(test_df["dt"], y_test, persistence_pred)
        extra_metrics = summarize_model(test_df["dt"], y_test, extra_pred)

        hybrid_metrics = summarize_hybrid(test_df["dt"], y_test, persistence_pred, extra_pred)

        payload["horizons"][str(horizon)] = {
            "label": spec["label"],
            "targetName": target_name,
            "persistence": persistence_metrics,
            "extraTrees": extra_metrics,
            "hybrid": hybrid_metrics,
        }

        dump(
            {
                "model": extra_model,
                "featureNames": FEATURE_COLUMNS,
                "targetName": target_name,
                "horizonMinutes": horizon,
                "targetLabel": spec["label"],
            },
            model_dir / f"aggregated-point-plus{horizon}min.joblib",
        )

        for timestamp, actual, persistence_value, extra_value in zip(
            test_df["dt"],
            y_test,
            persistence_pred,
            extra_pred,
            strict=False,
        ):
            prediction_rows.append(
                {
                    "TimestampLocal": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                    "Bucket": bucket_name(timestamp),
                    "HorizonMin": horizon,
                    "ActualPowerW": round(float(actual), 5),
                    "PersistencePredictionW": round(float(persistence_value), 5),
                    "ExtraTreesPredictionW": round(float(extra_value), 5),
                    "CurrentPowerW": round(float(test_df.loc[test_df["dt"] == timestamp, "PowerWatts"].iloc[0]), 5),
                }
            )

    write_csv(Path(f"{output_prefix}-predictions.csv"), prediction_rows)
    Path(f"{output_prefix}-summary.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    write_markdown(Path(f"{output_prefix}-summary.md"), payload)

    print(f"Summary created: {output_prefix}-summary.md")
    print(f"Predictions created: {output_prefix}-predictions.csv")
    print(f"Models directory: {model_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
