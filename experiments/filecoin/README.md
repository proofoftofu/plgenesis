# Filecoin Experiment

This experiment treats autoresearch as the execution engine and FEVM/Filecoin as the community steering, provenance, and storage layer.

## General Description

The product is a community-driven research system.

- Community members propose research directions.
- The contract stores the compact public truth about those directions.
- Autoresearch reads the selected direction and runs the actual experiment.
- Filecoin stores the larger research artifacts, logs, and run snapshots.
- The frontend can show the research as a live stream, similar to a research-focused live broadcast.

In this model, a "direction" is not just a topic title. It is a structured research instruction bundle that can include:

- objective metadata
- runtime knobs such as time budget and batch size
- architecture family and model shape
- hyperparameters
- branch strategy
- mode: `explore` or `exploit`
- lineage to a parent proposal

Autoresearch consumes those fields as its working input, then emits machine-readable progress and final-state artifacts.

## What this experiment does

- Models community proposals for two research stages:
  - `bootstrap`: define the initial autoresearch architecture and operating directives.
  - `tuning`: propose later hyperparameter or architecture updates against the active baseline.
- Restricts governance to a bounded steering surface for MVP:
  - objective metadata
  - runtime knobs
  - architecture family within the current fork limits
  - hyperparameters
  - branch choice
  - `explore` vs `exploit`
  - proposal lineage
- Converts those proposals, vote tallies, active direction, live run updates, dashboard state, and final run state into Filecoin-ready JSON objects.
- Generates EVM calldata for a Filecoin Calibration contract that supports:
  - `registerAgent`
  - `configureVoterWeight`
  - `proposeDirection`
  - `voteOnDirection`
  - `finalizeDirection`
  - `submitResearchRun`
- Includes local tests for deterministic payload generation and the governance state machine.

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

Exact on-chain entries:

- `registerAgent(agentId, metadataCid)`
  - registers the agent identity and its metadata pointer
- `configureVoterWeight(agentId, voter, weight)`
  - records a voter weight for that agent
- `proposeDirection(agentId, stage, parentDirectionId, proposalCid, proposalDigest)`
  - stores a research direction proposal pointer and digest
- `voteOnDirection(agentId, proposalId)`
  - records that a voter supported a proposal
- `finalizeDirection(agentId, proposalId, directionCid, directionDigest)`
  - marks the winning direction as active
- `submitResearchProgress(agentId, directionId, step, progressCid, progressDigest)`
  - anchors a live progress snapshot
- `submitResearchRun(agentId, directionId, stateCid, stateDigest)`
  - anchors the final research state

The contract does not store:

- every optimizer step
- raw training tensors
- the full dashboard view
- the full proposal text

Those larger objects live in Filecoin-backed artifacts.

## How autoresearch uses on-chain data

Autoresearch is the execution engine. It does not invent the direction on its own.

The workflow is:

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

Each proposal can register the following kinds of information:

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

## Files

- `contracts/ResearchRegistry.sol`: registry plus minimal community governance for direction proposals.
- `src/cli.js`: runnable experiment entrypoint.
- `src/lib/payload.js`: converts autoresearch + governance input into Filecoin and EVM integration artifacts.
- `src/lib/governance.js`: offchain governance planning plus a contract-behavior model used by tests.
- `src/lib/evm-abi.js`: minimal ABI encoder for contract calls.
- `src/lib/filecoin-upload.js`: real Filecoin Pin integration for uploading generated artifacts.
- `src/upload.js`: live upload entrypoint that reads `.env` and writes an upload manifest.
- `fixtures/research-input.json`: sample community-steered autoresearch input.
- `tests/payload.test.js`: local verification.

## Run

```bash
npm test
npm run experiment
npm run upload:filecoin
```

The experiment writes generated artifacts to `output/`:

- `output/metadata.json`
- `output/proposals.json`
- `output/governance-tally.json`
- `output/active-direction.json`
- `output/run-updates.json`
- `output/dashboard-state.json`
- `output/artifact-manifest.json`
- `output/state.json`
- `output/summary.json`
- `output/filecoin-upload-manifest.json`

## Integration meaning

This is the intended flow between community governance, autoresearch, Filecoin, and the app:

1. Community members submit direction proposals describing either:
   - the initial baseline architecture for autoresearch, or
   - a follow-up tuning change to the current baseline.
2. Each proposal is stored as a Filecoin-backed object.
3. The contract stores only compact pointers and governance state:
   - proposal IDs
   - proposal CIDs/digests
   - vote totals
   - active direction ID
   - latest run CID/digest
4. The orchestrator selects the next run using the active direction, branch strategy, and exploration budget.
5. Autoresearch executes the run and emits machine-readable run snapshots.
6. Run-start, progress, dashboard, and final artifacts are stored to Filecoin-backed storage.
7. After a run completes, the final run record is anchored with `submitResearchRun`.

## Compatibility Rules

Every proposal marked `executionCompatibility: "current-autoresearch"` is intended to be runnable against the current autoresearch fork.

For those proposals, the fixture now enforces:

- `n_embd % n_head === 0`
- `n_kv_head === n_head`
- `window_pattern` uses only `S` and `L`
- `n_embd % n_layer === 0` when the proposal is meant to map cleanly to the current aspect-ratio style configuration

Proposals marked `executionCompatibility: "future-autoresearch"` are stored and visible, but they are excluded from active-direction selection in this experiment.

## Dashboard State

`dashboard-state.json` is treated as a derived convenience view, not the canonical source of truth.

- Canonical artifacts: proposals, active direction, run updates, final run state
- Derived artifact: dashboard state assembled from those canonical artifacts for easier UI consumption

## Why this satisfies community-driven research direction

The key difference from the earlier version is that the selected research direction is no longer implicit or offchain-only.

- The community can define the initial research architecture through `bootstrap` proposals.
- The community can guide later bounded changes through `tuning` proposals.
- The live run can be represented as a research stream through periodic snapshots and dashboard state, not only a final result.
- Every autoresearch run is tied to a specific winning direction ID.
- The Filecoin objects keep proposal content, rationale, live updates, dashboard state, and final run artifacts, while the contract keeps the authoritative active direction pointer.
- The experiment also emits an artifact manifest so the integration app can resolve the main Filecoin objects from one place.

## Limits

- The environment still does not include real Filecoin upload credentials or a deployed Calibration contract.
- The generated `urn:sha256:...` values are deterministic placeholders and must be replaced by real CIDs from Filecoin Pin after a funded upload.
- Solidity compilation is not exercised here because `solc`/`forge` is not available in this workspace; instead, tests verify the integration boundary and contract behavior through a matching local model.

## Assessment

This is integration-ready for the hackathon plan.

- The contract surface now supports community steering instead of just storage anchoring.
- The payload shape now maps directly onto the intended workflow: bounded steering inputs, branch lineage, exploration budget, live snapshots, and final run records.
- The resulting app flow is coherent: community decides direction, the orchestrator schedules runs, autoresearch executes them, Filecoin stores the full artifacts, and the dashboard can show proposal lineage, live progress, and run provenance.
