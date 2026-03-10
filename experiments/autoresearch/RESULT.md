# Autoresearch Result

## Experiment purpose

The goal of this experiment is not to make Filecoin control training directly.

The intended system is:

- `autoresearch` = execution engine
- `Filecoin / FEVM` = community steering, provenance, and storage layer
- the app/orchestrator = coordinates proposals, selected direction, run execution, and published artifacts

For this hackathon plan, the autoresearch experiment must answer three questions:

1. Can autoresearch run locally in a reproducible way?
2. Which parts of autoresearch are realistic to expose as community-steerable inputs for an MVP?
3. What data and functionality does autoresearch already provide, and what is still missing before Filecoin/FEVM integration is credible?

## What was tested

The following was tested in this experiment:

1. Repo packaging into `workspace/experiments/autoresearch`
2. Dependency setup with `uv sync`
3. Minimal data setup with `uv run prepare.py --num-shards 1`
4. Local tokenizer creation and cache generation under `~/.cache/autoresearch`
5. Baseline execution of the fork's default `uv run train.py`
6. Reduced local verification execution using bounded env-var overrides
7. Machine-readable extraction of final run metrics via `parse_run_log.py`

## Available data and artifacts

After running this experiment, the following data and artifacts are available:

### Local cache data

- Training shard: `~/.cache/autoresearch/data/shard_00000.parquet`
- Validation shard: `~/.cache/autoresearch/data/shard_06542.parquet`
- Tokenizer pickle: `~/.cache/autoresearch/tokenizer/tokenizer.pkl`
- Token byte lookup: `~/.cache/autoresearch/tokenizer/token_bytes.pt`

### Experiment code and docs

- Experiment runtime: `workspace/experiments/autoresearch/train.py`
- Data prep and fixed evaluation: `workspace/experiments/autoresearch/prepare.py`
- Agent instructions from the upstream fork: `workspace/experiments/autoresearch/program.md`
- Result log parser: `workspace/experiments/autoresearch/parse_run_log.py`
- Recorded run summary table: `workspace/experiments/autoresearch/results.tsv`
- This experiment report: `workspace/experiments/autoresearch/RESULT.md`

### Produced run artifacts

- Aborted baseline log: `workspace/experiments/autoresearch/run.log`
- Completed reduced verification log: `workspace/experiments/autoresearch/run.quick.log`

## What functionality exists now

The current autoresearch experiment already provides these useful building blocks:

### 1. Reproducible run setup

- The runtime can be installed with `uv sync`.
- Data and tokenizer setup can be reproduced with `uv run prepare.py --num-shards 1`.
- A training run can be started from a single command.

### 2. Stable final evaluation output

The training script emits a final summary with:

- `val_bpb`
- `training_seconds`
- `total_seconds`
- `peak_vram_mb`
- `mfu_percent`
- `total_tokens_M`
- `num_steps`
- `num_params_M`
- `depth`

This is enough to define a stable final run record for downstream storage.

### 3. Bounded runtime control surface

This experiment added env-var based overrides so the orchestrator can steer bounded inputs without requiring arbitrary code mutation first.

Currently steerable through env vars in `train.py`:

- time budget
- warmup steps
- eval token budget
- total batch size
- device batch size
- depth
- aspect ratio
- head dimension
- window pattern
- optimizer and schedule hyperparameters already exposed in the file

This is the right initial control model for community steering.

### 4. Machine-readable final record extraction

`parse_run_log.py` converts the final textual summary into JSON. That is enough for:

- run-final records
- dashboard summaries
- Filecoin payload generation
- FEVM anchoring of final state pointers

## What was learned from execution

### Baseline fork behavior

The upstream fork starts correctly on this Apple Silicon machine, but the default profile is too slow here for practical repeated experimentation:

- environment verification passed
- tokenizer load passed
- model construction passed
- training entered the loop and emitted progress logs
- after startup-heavy steps, step times were still about `15-20s`
- the process was stopped after remaining active beyond a practical wall-clock guard and before final summary emission

Conclusion:

- compatibility is real
- default full-profile operation on this machine is not a good MVP execution loop

### Completed reduced verification run

A reduced local verification run completed successfully with:

- `val_bpb`: `2.237334`
- `training_seconds`: `20.0`
- `total_seconds`: `21.6`
- `peak_vram_mb`: `0.0`
- `num_steps`: `212`
- `num_params_M`: `1.7`

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

Conclusion:

- autoresearch can run end to end locally in a reduced mode
- final metrics can be extracted in a structured way
- the experiment is good enough to support integration design work

## MVP community-steerable surface

Based on the concept, the MVP should let the community steer bounded research inputs, not arbitrary code edits.

The parts of autoresearch that are realistic to expose first are:

- experiment objective metadata
- runtime knobs already exposed by env vars
- architecture family within current fork limits
- hyperparameter choices
- run priority
- branch or lineage choice
- explore vs exploit mode
- proposal lineage such as "continue winning branch" vs "challenge with variant"

This maps well onto the current experiment because the env-var layer already gives a bounded control surface.

The parts that should not be governance-controlled first are:

- arbitrary `train.py` patch proposals
- unrestricted agent code mutation from community votes
- low-level per-step optimizer behavior as an onchain decision surface

That would make validation, security, and provenance much harder too early.

## Plan fit

This experiment supports the plan in the following way:

### Role of autoresearch

Autoresearch is the execution engine that:

- runs experiments
- produces metric-bearing outputs
- emits logs
- yields comparable final records

### Role of Filecoin / FEVM

Filecoin / FEVM should sit above this as the coordination and provenance layer that:

- stores proposal documents
- stores selected direction snapshots
- stores run records and logs
- stores summary artifacts
- anchors active direction and final truth pointers
- records governance outcomes such as selected proposal or winning direction

### Role of the app / orchestrator

The app should:

- show the live run panel
- show proposal feed, voting, weights, and lineage
- launch runs using the selected bounded inputs
- attach artifacts and publish them to storage
- update dashboard state as runs progress and finish

## What data should autoresearch provide to achieve the plan

For the concept you described, the autoresearch side needs to provide these data shapes:

### Proposal-adjacent input data

- direction id
- parent direction id
- selected parameter set
- explore or exploit flag
- objective metadata
- branch or lineage target

### Run lifecycle data

- run created
- run started
- periodic progress update
- evaluation update if available
- run finished
- run failed

### Final run record data

- run id
- selected direction id
- parent lineage reference
- metric summary
- config used
- artifact references
- status
- timestamps

## What is missing right now

This experiment proved the final-summary path, but several capabilities are still missing on the autoresearch side.

### Missing for live dashboard behavior

- no machine-readable progress stream during training
- no periodic JSON snapshot output
- no stable run lifecycle event schema
- no explicit run id emitted by the training process
- no structured failure payload

### Missing for governance integration

- no canonical schema for proposal input selection
- no canonical schema for active direction
- no explicit support for branch lineage metadata in emitted artifacts
- no built-in "explore vs exploit" execution mode semantics

### Missing for storage integration

- no automatic packaging of final run record into a JSON document
- no periodic snapshot bundle suitable for Filecoin pinning
- no canonical artifact manifest linking logs, summaries, and config

## Recommended autoresearch adjustments

The next autoresearch-side work should focus on these two capabilities first:

### 1. Add a machine-readable run event stream or periodic JSON snapshots

This is the most important missing capability.

Target output should support at least:

- `run_start`
- `run_progress`
- `run_eval`
- `run_finish`
- `run_failure`

Even newline-delimited JSON written to a file would be enough for the MVP.

### 2. Emit a canonical final run record

At the end of each run, autoresearch should write one JSON file that includes:

- run metadata
- selected steering inputs
- final metrics
- artifact paths
- lineage references
- timestamps

That would let Filecoin store the whole run cleanly and FEVM anchor only the pointer/state that matters.

## Suggested canonical schemas

These are the minimum useful artifact shapes the next experiment should target.

### Proposal

```json
{
  "proposal_id": "prop_001",
  "parent_direction_id": "dir_000",
  "title": "Increase exploration on smaller batch profile",
  "objective": "Improve val_bpb under bounded local compute",
  "mode": "explore",
  "controls": {
    "depth": 2,
    "total_batch_size": 2048,
    "device_batch_size": 1,
    "time_budget": 20
  }
}
```

### Run update

```json
{
  "run_id": "run_001",
  "direction_id": "dir_001",
  "event": "run_progress",
  "step": 120,
  "training_seconds": 11.3,
  "loss": 6.52,
  "tokens_seen": 245760
}
```

### Final run record

```json
{
  "run_id": "run_001",
  "direction_id": "dir_001",
  "parent_direction_id": "dir_000",
  "status": "finished",
  "mode": "explore",
  "controls": {
    "depth": 2,
    "time_budget": 20
  },
  "metrics": {
    "val_bpb": 2.237334,
    "training_seconds": 20.0,
    "total_seconds": 21.6,
    "num_steps": 212
  },
  "artifacts": {
    "log_path": "workspace/experiments/autoresearch/run.quick.log"
  }
}
```

## Practical usage now

### One-time setup

```bash
cd workspace/experiments/autoresearch
uv sync
uv run prepare.py --num-shards 1
```

### Reduced local verification mode

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

### Full research mode

```bash
cd workspace/experiments/autoresearch
uv run train.py > run.log 2>&1
python3 parse_run_log.py run.log
```

## Final assessment

The autoresearch experiment is useful for the plan, but only in the role of execution engine.

It is already sufficient for:

- reproducible local execution
- bounded runtime steering
- final metric production
- final record extraction

It is not yet sufficient for:

- live community-steered dashboard behavior
- Filecoin-ready live snapshots
- FEVM-ready run lifecycle anchoring

So the correct conclusion is:

- `autoresearch` is viable as the research execution layer
- the next autoresearch experiment should add structured run events and canonical JSON artifacts
- Filecoin / FEVM integration should be built around those outputs, not around direct governance of arbitrary training code
