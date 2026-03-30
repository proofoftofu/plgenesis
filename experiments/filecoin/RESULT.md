# Filecoin Experiment Result

## Scope

This experiment validates whether the PL_Genesis plan can use Filecoin as the persistence and coordination layer for community-driven autoresearch.

The target outcome is:

- the community can propose the initial autoresearch architecture
- the community can vote on later bounded tuning changes
- the winning direction can be anchored onchain
- the full proposal, tally, live run updates, dashboard state, and final run state can be stored as Filecoin-backed artifacts
- autoresearch can consume the selected direction as input while remaining the execution engine

## What was tested

### 1. Governance-aware FEVM contract shape

Tested a Solidity contract for Filecoin EVM / Calibration in [`contracts/ResearchRegistry.sol`](workspace/experiments/filecoin/contracts/ResearchRegistry.sol).

The contract shape supports:

- `registerAgent`
- `configureVoterWeight`
- `proposeDirection`
- `voteOnDirection`
- `finalizeDirection`
- `submitResearchRun`

This is the minimum onchain surface needed so research direction is community-driven instead of hidden in offchain prompts only.

### 2. Filecoin-ready artifact generation

Tested conversion of autoresearch + governance input into storage objects in [`src/lib/payload.js`](workspace/experiments/filecoin/src/lib/payload.js).

The generated artifacts include:

- agent metadata
- proposal set
- governance tally
- active direction
- run update set
- dashboard state
- latest final run state
- EVM calldata for all governance and state-anchor actions

The proposal schema now focuses on bounded governance inputs:

- objective metadata
- runtime knobs
- architecture family
- hyperparameters
- branch strategy
- `explore` vs `exploit`
- lineage to parent proposals

It also now marks each proposal with `executionCompatibility`:

- `current-autoresearch`
- `future-autoresearch`

Only proposals compatible with the current autoresearch fork are eligible to become the active direction in this experiment.

### 3. Governance behavior

Tested the intended contract behavior in a local state model in [`src/lib/governance.js`](workspace/experiments/filecoin/src/lib/governance.js).

Verified behaviors:

- proposals can be created
- weighted voters can vote
- duplicate votes are rejected
- a direction can be finalized only after votes exist
- a research run can be submitted only for the active direction

### 4. Real Filecoin upload path

Tested integration with the official Filecoin Pin CLI via:

- [`src/lib/filecoin-upload.js`](workspace/experiments/filecoin/src/lib/filecoin-upload.js)
- [`src/upload.js`](workspace/experiments/filecoin/src/upload.js)

This uses real `filecoin-pin` commands against Filecoin Calibration, not a mock path.

The live test confirmed:

- the wallet in `.env` is recognized on Calibration
- `filecoin-pin add` can package the artifact and produce a real IPFS root CID locally
- the current wallet is blocked at the payment layer because it has no Calibration FIL for gas

## Test status

Automated tests passed with `npm test`.

Covered by tests:

- deterministic payload generation
- governance winner selection
- contract-behavior simulation
- duplicate-vote rejection
- upload helper parsing and failure classification

Test files:

- [`tests/payload.test.js`](workspace/experiments/filecoin/tests/payload.test.js)
- [`tests/upload.test.js`](workspace/experiments/filecoin/tests/upload.test.js)

## Data available

### Input fixture

The canonical sample input is:

- [`fixtures/research-input.json`](workspace/experiments/filecoin/fixtures/research-input.json)

It contains:

- autoresearch constraints
- steerable surface definition
- run lifecycle
- snapshot policy
- voter weights
- bootstrap proposals
- tuning proposals
- exploration budget
- votes
- execution target stage
- simulated live run snapshots

### Generated experiment artifacts

Generated in:

- [`output/metadata.json`](workspace/experiments/filecoin/output/metadata.json)
- [`output/proposals.json`](workspace/experiments/filecoin/output/proposals.json)
- [`output/governance-tally.json`](workspace/experiments/filecoin/output/governance-tally.json)
- [`output/active-direction.json`](workspace/experiments/filecoin/output/active-direction.json)
- [`output/run-updates.json`](workspace/experiments/filecoin/output/run-updates.json)
- [`output/dashboard-state.json`](workspace/experiments/filecoin/output/dashboard-state.json)
- [`output/artifact-manifest.json`](workspace/experiments/filecoin/output/artifact-manifest.json)
- [`output/state.json`](workspace/experiments/filecoin/output/state.json)
- [`output/summary.json`](workspace/experiments/filecoin/output/summary.json)
- [`output/filecoin-upload-manifest.json`](workspace/experiments/filecoin/output/filecoin-upload-manifest.json)

### Live Filecoin status captured

Current live upload state:

- network: Calibration
- wallet recognized: `0x0Bc298a4a0a205875F5Ae3B19506669c55B38d01`
- status: `blocked_no_fil`

The upload manifest records the real failure reason from Filecoin Pin:

- wallet has no FIL balance for gas

## Functionality achieved

This experiment currently provides:

- FEVM-compatible governance contract design
- offchain generation of Filecoin-backed governance and research artifacts
- bounded community steering inputs that match the autoresearch MVP more closely
- deterministic EVM calldata generation for contract interaction
- a tested governance state machine
- live run update and dashboard-state artifact generation
- a real Filecoin upload entrypoint using the official CLI
- persistent recording of live upload status

## Integration decisions

- Runnable fixture: yes, current-autoresearch-compatible proposals are now explicitly marked and validated by fixture design.
- Stable run-update schema: yes, each run update now has `runId`, `scheduledRunId`, `directionId`, `directionSlug`, `event`, `timestamp`, `step`, `status`, and optional `metrics`.
- Dashboard state: derived convenience view, not canonical truth.

## Functionality not yet completed

Not yet completed in this environment:

- successful upload of the artifacts to Filecoin Calibration
- replacement of placeholder `urn:sha256:...` references with returned Filecoin-backed identifiers
- deployed Calibration contract interaction
- end-to-end dashboard integration

The immediate blocker is funding:

- Calibration `tFIL` is required for gas
- Calibration `USDFC` may also be required for payment setup and storage deposit

## Assessment against the plan

The plan is achievable with this design.

Why:

- research direction can be community-defined from the first run, not only tuned later
- governance acts on bounded inputs that are realistic to schedule and compare
- autoresearch can consume a concrete active direction with proposal lineage, branch strategy, and mode
- Filecoin stores the full direction, live update, dashboard, and final run artifacts, which suits large research state better than storing all of it onchain
- FEVM stores the compact authoritative pointers and vote outcomes

This is the right architecture for the hackathon idea:

- community decides direction
- orchestrator schedules and launches runs
- autoresearch executes direction
- Filecoin stores full artifacts and live snapshots
- FEVM anchors the current truth
- the dashboard can show provenance, lineage, live progress, and the latest state

## Next required step

To complete the live Filecoin part, fund the wallet in `.env` with Calibration `tFIL`, then rerun:

```bash
npm run upload:filecoin
```

After that, the experiment should be able to continue from preflight into actual Filecoin storage uploads.
