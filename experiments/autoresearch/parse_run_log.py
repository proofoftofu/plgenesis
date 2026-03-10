import json
import sys
from pathlib import Path


METRIC_KEYS = {
    "val_bpb": float,
    "training_seconds": float,
    "total_seconds": float,
    "peak_vram_mb": float,
    "mfu_percent": float,
    "total_tokens_M": float,
    "num_steps": int,
    "num_params_M": float,
    "depth": int,
}


def parse_run_log(path):
    metrics = {}
    for raw_line in Path(path).read_text().splitlines():
        if ":" not in raw_line:
            continue
        key, value = raw_line.split(":", 1)
        key = key.strip()
        if key not in METRIC_KEYS:
            continue
        metrics[key] = METRIC_KEYS[key](value.strip())
    return metrics


def main(argv):
    if len(argv) != 2:
        raise SystemExit("usage: python parse_run_log.py <run.log>")
    print(json.dumps(parse_run_log(argv[1]), indent=2, sort_keys=True))


if __name__ == "__main__":
    main(sys.argv)
