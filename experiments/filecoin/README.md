# Filecoin Experiment

This experiment treats autoresearch as the execution engine and FEVM/Filecoin as the community steering, provenance, and storage layer.

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

## Why this satisfies community-driven research direction

The key difference from the earlier version is that the selected research direction is no longer implicit or offchain-only.

- The community can define the initial research architecture through `bootstrap` proposals.
- The community can guide later bounded changes through `tuning` proposals.
- The live run can be represented as a research stream through periodic snapshots and dashboard state, not only a final result.
- Every autoresearch run is tied to a specific winning direction ID.
- The Filecoin objects keep proposal content, rationale, live updates, dashboard state, and final run artifacts, while the contract keeps the authoritative active direction pointer.

## Limits

- The environment still does not include real Filecoin upload credentials or a deployed Calibration contract.
- The generated `urn:sha256:...` values are deterministic placeholders and must be replaced by real CIDs from Filecoin Pin after a funded upload.
- Solidity compilation is not exercised here because `solc`/`forge` is not available in this workspace; instead, tests verify the integration boundary and contract behavior through a matching local model.

## Assessment

This is integration-ready for the hackathon plan.

- The contract surface now supports community steering instead of just storage anchoring.
- The payload shape now maps directly onto the intended workflow: bounded steering inputs, branch lineage, exploration budget, live snapshots, and final run records.
- The resulting app flow is coherent: community decides direction, the orchestrator schedules runs, autoresearch executes them, Filecoin stores the full artifacts, and the dashboard can show proposal lineage, live progress, and run provenance.
