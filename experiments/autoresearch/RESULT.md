# Autoresearch Result

## Goal

Validate that the `autoresearch-macos` fork can be used as the autonomous research engine for the PL_Genesis plan, then document the practical way to run it from this repo.

## What was done

1. Copied the runnable fork sources into `workspace/experiments/autoresearch`.
2. Synced the pinned Python environment with `uv sync`.
3. Ran one-time setup with `uv run prepare.py --num-shards 1`.
4. Verified the cache and tokenizer were created under `~/.cache/autoresearch`.
5. Ran a baseline `uv run train.py` check and observed the runtime profile on this machine.
6. Added a reduced local verification mode and completed one end-to-end run.

## Observed baseline behavior

The baseline starts correctly on this Apple Silicon machine, but the default wall-clock profile is too slow to be a practical feedback loop on this hardware:

- Environment verification passed.
- Tokenizer load and model construction passed.
- Training entered the main loop and produced live step logs.
- After the first startup-heavy iterations, step times were still about 15-20 seconds.
- The process was stopped after it remained active beyond the fork's own recommended 10-minute wall-clock guard, before reaching the final summary block.

This means the fork is technically compatible here, but the out-of-the-box configuration is not operationally useful on this MacBook Air for repeated autonomous experimentation.

## Completed local verification run

The reduced verification profile completed successfully with these metrics:

- `val_bpb`: `2.237334`
- `training_seconds`: `20.0`
- `total_seconds`: `21.6`
- `peak_vram_mb`: `0.0` (MPS does not report CUDA VRAM metrics)
- `num_steps`: `212`
- `num_params_M`: `1.7`
- `log file`: `workspace/experiments/autoresearch/run.quick.log`

Command used:

```bash
cd workspace/experiments/autoresearch
AUTORESEARCH_TIME_BUDGET=20 \
AUTORESEARCH_WARMUP_STEPS=0 \
AUTORESEARCH_EVAL_TOKENS=4096 \
AUTORESEARCH_TOTAL_BATCH_SIZE=2048 \
AUTORESEARCH_DEVICE_BATCH_SIZE=1 \
AUTORESEARCH_DEPTH=2 \
AUTORESEARCH_ASPECT_RATIO=32 \
AUTORESEARCH_HEAD_DIM=64 \
uv run train.py > run.quick.log 2>&1
python3 parse_run_log.py run.quick.log
```

## Integration-ready usage

### One-time setup

```bash
cd workspace/experiments/autoresearch
uv sync
uv run prepare.py --num-shards 1
```

### Practical local verification mode

```bash
cd workspace/experiments/autoresearch
AUTORESEARCH_TIME_BUDGET=60 \
AUTORESEARCH_WARMUP_STEPS=1 \
AUTORESEARCH_EVAL_TOKENS=262144 \
AUTORESEARCH_TOTAL_BATCH_SIZE=16384 \
AUTORESEARCH_DEVICE_BATCH_SIZE=4 \
uv run train.py > run.log 2>&1
uv run python parse_run_log.py run.log
```

### Full research mode

```bash
cd workspace/experiments/autoresearch
uv run train.py > run.log 2>&1
uv run python parse_run_log.py run.log
```

## Why this is usable for the hackathon plan

- It provides a concrete autonomous research worker with reproducible setup.
- Outputs are already structured around a stable metric (`val_bpb`) and machine-readable logs.
- The added parser makes it straightforward to transform each run into a payload for downstream storage or on-chain anchoring.
- The environment override layer makes the experiment testable locally without creating another fork.

## Next integration step

Wrap each completed run into a normalized record that can later be pinned or anchored on-chain:

```json
{
  "run_id": "2026-03-11T08:00:00Z-local",
  "mode": "local-verification",
  "commit": "<workspace commit>",
  "metrics": {
    "val_bpb": 0.0,
    "training_seconds": 0.0,
    "total_seconds": 0.0,
    "peak_vram_mb": 0.0,
    "num_steps": 0
  },
  "artifacts": {
    "log_path": "workspace/experiments/autoresearch/run.log"
  }
}
```
