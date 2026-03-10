# Integration Experiment

This experiment is the orchestration layer for the PL_Genesis concept.

It is not a new research engine and not a new storage layer. It connects the two existing experiments:

- `workspace/experiments/autoresearch`
- `workspace/experiments/filecoin`

## What app this needs

The MVP app is a community research orchestrator.

It should do four jobs:

1. accept community proposals and votes
2. resolve the winning direction into autoresearch-compatible inputs
3. run or schedule the next autoresearch job
4. package the resulting state for Filecoin storage and FEVM anchoring

## What this experiment does

This experiment implements the logic part of that app:

- validates whether the selected community direction can actually be expressed by the current autoresearch fork
- builds the concrete autoresearch execution plan when it can
- parses a completed autoresearch run log
- creates a normalized run record tied to the winning proposal
- reuses the Filecoin experiment payload generation so the full workflow can be tested end to end

## Workflow

1. The Filecoin governance input selects an active direction.
2. The integration layer resolves parent lineage and merges architecture plus hyperparameter deltas.
3. The integration layer checks whether the result can be represented by the current autoresearch environment controls.
4. If compatible, it emits the exact `AUTORESEARCH_*` environment variables and command to run.
5. After a run, it parses the log into metrics and produces a run record bound to the chosen direction.
6. The workflow summary shows what the dashboard/backend would expose.

## Current boundary

The current autoresearch fork can only be driven exactly for the parameters already exposed through environment variables in `train.py`.

That means this integration currently supports exact community steering for:

- depth
- aspect ratio implied by `n_embd / n_layer`
- head dimension implied by `n_embd / n_head`
- `window_pattern`
- optimizer learning rates and a few runtime controls

It does not yet encode arbitrary source-code patches as governance payloads.

## Run

```bash
cd workspace/experiments/integration
npm test
node src/cli.js fixtures/workflow-input.json fixtures/sample-run.log
```
