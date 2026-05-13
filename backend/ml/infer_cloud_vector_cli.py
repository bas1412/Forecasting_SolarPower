from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi_service.cloud_vector_ml import infer_cloud_vector  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run cloud-vector ML inference from base64 image input.")
    parser.add_argument("--image-name", default="node-analysis.jpg")
    parser.add_argument("--cloud-threshold", type=float, default=None)
    parser.add_argument("--image-file", default=None, help="Read image bytes directly from a file path.")
    parser.add_argument(
        "--stdin-base64",
        action="store_true",
        help="Read base64 image data from stdin.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.image_file:
            image_path = Path(args.image_file)
            image_bytes = image_path.read_bytes()
            image_name = args.image_name if args.image_name != "node-analysis.jpg" else image_path.name
        else:
            base64_data = sys.stdin.read() if args.stdin_base64 else ""
            base64_data = base64_data.strip()
            if base64_data.startswith("data:image/") and "," in base64_data:
                base64_data = base64_data.split(",", 1)[1]
            if not base64_data:
                raise ValueError("No base64 image input provided.")
            image_bytes = base64.b64decode(base64_data)
            image_name = args.image_name

        result = infer_cloud_vector(
            image_bytes,
            image_name=image_name,
            cloud_threshold=args.cloud_threshold,
        )
        sys.stdout.write(json.dumps(result, ensure_ascii=True))
        return 0
    except Exception as error:  # pragma: no cover - CLI fallback path
        sys.stderr.write(str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
