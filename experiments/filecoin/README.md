# Filecoin Experiment

This experiment now targets community-driven autoresearch, not just passive storage. The community can propose the initial research architecture, vote on later hyperparameter or architecture adjustments, and have the selected direction anchored for the next autoresearch run.

## What this experiment does

- Models community proposals for two research stages:
  - `bootstrap`: define the initial autoresearch architecture and operating directives.
  - `tuning`: propose later hyperparameter or architecture updates against the active baseline.
- Converts those proposals, vote tallies, the active direction, and the resulting research state into Filecoin-ready JSON objects.
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
4. Autoresearch reads the active direction and uses it to decide how to edit `program.md` and `train.py`.
5. After a run completes, the new research state is uploaded and anchored with `submitResearchRun`.

## Why this satisfies community-driven research direction

The key difference from the earlier version is that the selected research direction is no longer implicit or offchain-only.

- The community can define the initial research architecture through `bootstrap` proposals.
- The community can guide later hyperparameter and architecture changes through `tuning` proposals.
- Every autoresearch run is tied to a specific winning direction ID.
- The Filecoin objects keep the full proposal content, rationale, and tuning instructions, while the contract keeps the authoritative active direction pointer.

## Limits

- The environment still does not include real Filecoin upload credentials or a deployed Calibration contract.
- The generated `urn:sha256:...` values are deterministic placeholders and must be replaced by real CIDs from Filecoin Pin after a funded upload.
- Solidity compilation is not exercised here because `solc`/`forge` is not available in this workspace; instead, tests verify the integration boundary and contract behavior through a matching local model.

## Assessment

This is integration-ready for the hackathon plan.

- The contract surface now supports community steering instead of just storage anchoring.
- The payload shape maps directly onto autoresearch concepts: baseline architecture, tuning deltas, controlled files, and the next run target.
- The resulting app flow is coherent: community decides direction, autoresearch executes it, Filecoin stores the full artifacts, and the dashboard can show proposal lineage and run provenance.
