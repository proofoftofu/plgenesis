# plgenesis Demo

This workspace contains the submission demo for a community-driven autoresearch system.

## General Description

The product is a community-driven research workflow.

- Community members propose research directions.
- The contract stores the compact public truth about those directions.
- Autoresearch reads the selected direction and runs the actual experiment.
- Filecoin stores the larger research artifacts, logs, and run snapshots.
- The frontend can show the research as a live stream.

In this system, a "direction" is a structured research instruction bundle, not just a topic title.

It can include:

- objective metadata
- runtime knobs such as time budget and batch size
- architecture family and model shape
- hyperparameters
- branch strategy
- mode: `explore` or `exploit`
- lineage to a parent proposal

Autoresearch consumes those fields as working input, then emits machine-readable progress and final-state artifacts.

## What is stored on-chain

The contract stores compact pointers and governance state, not the full research payload.

Stored on-chain:

- agent registration
- proposal records
- vote weights
- vote status
- active direction selection
- progress anchors
- final run anchors

Exact on-chain actions:

- `registerAgent(agentId, metadataCid)`
- `configureVoterWeight(agentId, voter, weight)`
- `proposeDirection(agentId, stage, parentDirectionId, proposalCid, proposalDigest)`
- `voteOnDirection(agentId, proposalId)`
- `finalizeDirection(agentId, proposalId, directionCid, directionDigest)`
- `submitResearchProgress(agentId, directionId, step, progressCid, progressDigest)`
- `submitResearchRun(agentId, directionId, stateCid, stateDigest)`

What the contract does not store:

- every optimizer step
- raw training tensors
- the full dashboard view
- the full proposal text

Those larger objects live in Filecoin-backed artifacts.

## How autoresearch uses on-chain data

Autoresearch is the execution engine. It does not invent the direction on its own.

Workflow:

1. Community proposals are written to Filecoin-ready payloads and anchored through the contract.
2. The contract resolves the active direction after voting and finalization.
3. The demo runner or orchestrator reads the active direction ID, slug, branch target, mode, and budget.
4. Autoresearch receives those values as environment variables and runtime inputs.
5. Autoresearch runs the selected direction and emits:
   - `run_start`
   - `run_progress`
   - `run_eval`
   - `run_finish`
6. The integration layer converts those emitted events into Filecoin-ready progress artifacts.
7. Selected progress snapshots are committed back on-chain with `submitResearchProgress`.
8. The final run state is committed on-chain with `submitResearchRun`.

In short:

- on-chain proposal = what research should be done
- on-chain progress = evidence that the selected research is actually moving forward
- on-chain final result = the completed research state

## What information is registered on-chain

Each proposal can register:

- proposal identity
- stage: bootstrap or tuning
- parent direction ID
- proposal CID and digest
- direction kind: baseline or challenger
- mode: explore or exploit
- branch strategy
- branch target
- objective metadata
- runtime knobs
- architecture family and shape
- hyperparameters
- program directives

Each progress snapshot can register:

- direction ID
- training step
- progress CID
- progress digest
- timestamp

Each final run record can register:

- direction ID
- final state CID
- final state digest
- timestamp

## Sample data objects

Proposal sample:

```json
{
  "agentId": "0x33fe488c831546fd0385aa07dd5357b1c8057e65805c98afd4be4f3ab59f44cf",
  "runId": "run-2026-03-11-filecoin",
  "schema": "plgenesis/research-direction-set@v1",
  "proposals": [
    {
      "id": 3,
      "slug": "tune-extend-short-window",
      "stage": "tuning",
      "parentDirectionId": 1,
      "executionCompatibility": "current-autoresearch",
      "cid": "urn:sha256:48fd5441da47b7f28c0c7b01f74f49b3bdfa59266b9b262908f3133f5bbe9587",
      "digest": "0x48fd5441da47b7f28c0c7b01f74f49b3bdfa59266b9b262908f3133f5bbe9587"
    }
  ]
}
```

Progress sample:

```json
{
  "agentId": "0x33fe488c831546fd0385aa07dd5357b1c8057e65805c98afd4be4f3ab59f44cf",
  "runId": "run-2026-03-11-filecoin",
  "scheduledRunId": "sched-2026-03-11-01",
  "schema": "plgenesis/run-update-set@v1",
  "updates": [
    {
      "event": "progress",
      "directionId": 3,
      "directionSlug": "tune-extend-short-window",
      "step": 95,
      "status": "running",
      "metrics": {
        "tokens_M": 49.7,
        "train_loss": 2.91
      },
      "cid": "urn:sha256:904a2bff8ff76454d52ced3c20c67e1d0e02f83565b8bb399a1150aaa966baa9"
    }
  ]
}
```

Final state sample:

```json
{
  "agentId": "0x33fe488c831546fd0385aa07dd5357b1c8057e65805c98afd4be4f3ab59f44cf",
  "runId": "run-2026-03-11-filecoin",
  "schema": "plgenesis/run-final@v1",
  "activeDirectionId": 3,
  "activeDirectionSlug": "tune-extend-short-window",
  "latestMetrics": {
    "num_steps": 948,
    "peak_vram_mb": 21580,
    "training_seconds": 300,
    "val_bpb": 0.9924
  },
  "runUpdates": [
    {
      "event": "final",
      "step": 948,
      "status": "completed"
    }
  ]
}
```

## Demo flow

The submission demo runs as:

1. deploy or attach to the registry contract
2. register a fresh agent
3. propose research directions
4. vote on the active direction
5. finalize the direction
6. run autoresearch from the CLI
7. commit progress snapshots on-chain
8. commit the final research state on-chain
9. print `🎯 Demo complete`

## Current demo contract

The currently deployed demo registry used in the successful run is:

- `0x2a2d50c45c8449129c47a2570019c6232e78cee8`

## Source of truth

The detailed implementation is documented in:

- `workspace/experiments/filecoin/README.md`
- `workspace/experiments/filecoin/RESULT.md`
- `workspace/experiments/integration/src/cli.js`
- `workspace/demo-tx.mjs`
