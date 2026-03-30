import { createHash } from "node:crypto";
import { stableStringify } from "./stable-json.js";
import {
  encodeConfigureVoterWeight,
  encodeFinalizeDirection,
  encodeProposeDirection,
  encodeRegisterAgent,
  encodeSubmitResearchRun,
  encodeVoteOnDirection
} from "./evm-abi.js";
import { buildGovernancePlan } from "./governance.js";

const NETWORK = {
  name: "filecoin-calibration",
  chainId: 314159,
  contractPurpose: "community-driven-autoresearch-registry"
};

const OWNER = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";

export function prepareExperiment(rawInput) {
  const input = validateInput(rawInput);
  const agentSlug = slugify(input.agentName);
  const agentId = bytes32FromText(agentSlug);

  const governancePlan = buildGovernancePlan(input.steering, agentId);
  const proposalPayloads = governancePlan.proposals.map((proposal) => {
    const payload = stableStringify({
      schema: "plgenesis/research-direction@v1",
      agentId,
      runId: input.runId,
      slug: proposal.slug,
      stage: proposal.stage,
      parentDirectionId: proposal.parentId,
      title: proposal.title,
      executionCompatibility: proposal.executionCompatibility,
      directionKind: proposal.directionKind,
      mode: proposal.mode,
      branchStrategy: proposal.branchStrategy,
      branchTarget: proposal.branchTarget,
      author: proposal.author,
      rationale: proposal.rationale,
      objectiveMetadata: proposal.objectiveMetadata ?? null,
      objectiveMetadataDelta: proposal.objectiveMetadataDelta ?? null,
      runtimeKnobs: proposal.runtimeKnobs ?? null,
      runtimeKnobsDelta: proposal.runtimeKnobsDelta ?? null,
      architecture: proposal.architecture ?? null,
      hyperparameters: proposal.hyperparameters ?? null,
      architectureDelta: proposal.architectureDelta ?? null,
      hyperparameterDelta: proposal.hyperparameterDelta ?? null,
      programDirectives: proposal.programDirectives,
      runnableNow: proposal.executionCompatibility === "current-autoresearch",
      autoresearch: input.autoresearch
    });

    return {
      ...proposal,
      cid: pseudoCid(payload),
      digest: sha256Hex(payload),
      json: payload
    };
  });

  const tallies = governancePlan.tallies.map((tally) => ({
    ...tally,
    proposalCid: proposalPayloads.find((proposal) => proposal.id === tally.proposalId).cid
  }));

  const winners = {
    bootstrap: governancePlan.winners.bootstrap,
    tuning: governancePlan.winners.tuning,
    active: governancePlan.activeWinner
  };

  const activeProposal = proposalPayloads.find(
    (proposal) => proposal.id === winners.active.proposalId
  );

  const activeDirection = stableStringify({
    schema: "plgenesis/active-direction@v1",
    agentId,
    runId: input.runId,
    governance: input.steering.governance,
    bootstrapWinner: winners.bootstrap,
    tuningWinner: winners.tuning,
    activeWinner: winners.active,
    selectionPolicy: {
      activeDirectionSource: "runnable-proposals-only",
      excludedCompatibility: "future-autoresearch"
    },
    explorationBudget: input.steering.explorationBudget,
    proposal: {
      id: activeProposal.id,
      slug: activeProposal.slug,
      stage: activeProposal.stage,
      executionCompatibility: activeProposal.executionCompatibility,
      directionKind: activeProposal.directionKind,
      mode: activeProposal.mode,
      branchStrategy: activeProposal.branchStrategy,
      branchTarget: activeProposal.branchTarget,
      parentDirectionId: activeProposal.parentId,
      cid: activeProposal.cid,
      digest: activeProposal.digest
    }
  });
  const activeDirectionCid = pseudoCid(activeDirection);
  const activeDirectionDigest = sha256Hex(activeDirection);

  const runUpdates = input.runSimulation.snapshots.map((snapshot, index) => {
    const payload = stableStringify({
      schema: "plgenesis/run-update@v1",
      agentId,
      runId: input.runId,
      scheduledRunId: input.runSimulation.scheduledRunId,
      directionId: activeProposal.id,
      directionSlug: activeProposal.slug,
      event: snapshot.event,
      timestamp: snapshot.timestamp,
      step: snapshot.step,
      status: snapshot.status,
      metrics: extractMetrics(snapshot),
      context: {
        branchSelected: input.runSimulation.branchSelected,
        modeSelected: input.runSimulation.modeSelected,
        snapshotIndex: index
      },
      message: snapshot.message ?? null
    });

    return {
      index,
      event: snapshot.event,
      timestamp: snapshot.timestamp,
      step: snapshot.step,
      status: snapshot.status,
      metrics: extractMetrics(snapshot),
      cid: pseudoCid(payload),
      digest: sha256Hex(payload),
      json: payload
    };
  });

  const state = {
    schema: "plgenesis/run-final@v1",
    agentId,
    agentName: input.agentName,
    runId: input.runId,
    generatedAt: input.generatedAt,
    goal: input.goal,
    summary: input.summary,
    findings: input.findings,
    sources: input.sources,
    autoresearch: input.autoresearch,
    steering: {
      governance: input.steering.governance,
      explorationBudget: input.steering.explorationBudget,
      voterWeights: input.steering.voterWeights,
      winners
    },
    execution: {
      activeDirectionId: activeProposal.id,
      activeDirectionSlug: activeProposal.slug,
      branchSelected: input.runSimulation.branchSelected,
      modeSelected: input.runSimulation.modeSelected,
      scheduledRunId: input.runSimulation.scheduledRunId,
      controlledFiles: input.autoresearch.controlledFiles,
      steerableSurface: input.autoresearch.steerableSurface,
      expectedNextEditTargets:
        activeProposal.stage === "bootstrap" ? ["program.md", "train.py"] : ["program.md", "train.py"]
    },
    latestMetrics: input.runSimulation.latestMetrics,
    lifecycle: input.autoresearch.runLifecycle,
    runUpdates: runUpdates.map((update) => ({
      index: update.index,
      event: update.event,
      timestamp: update.timestamp,
      step: update.step,
      status: update.status,
      metrics: update.metrics,
      cid: update.cid,
      digest: update.digest
    }))
  };

  const stateJson = stableStringify(state);
  const stateDigest = sha256Hex(stateJson);
  const latestStateCid = pseudoCid(stateJson);

  const metadata = {
    schema: "plgenesis/agent-metadata@v3",
    agentId,
    agentName: input.agentName,
    agentSlug,
    latestRunId: input.runId,
    latestScheduledRunId: input.runSimulation.scheduledRunId,
    activeDirectionId: activeProposal.id,
    activeDirectionCid,
    activeDirectionDigest,
    latestStateCid,
    latestStateDigest: stateDigest,
    storagePolicy: {
      hotCopies: 1,
      coldCopies: 2,
      ttlDays: 30
    },
    network: NETWORK
  };

  const dashboardState = stableStringify({
    schema: "plgenesis/dashboard-state@v1",
    mode: "derived-convenience-view",
    agentId,
    runId: input.runId,
    liveRunPanel: {
      activeDirectionId: activeProposal.id,
      activeDirectionSlug: activeProposal.slug,
      branchSelected: input.runSimulation.branchSelected,
      modeSelected: input.runSimulation.modeSelected,
      runStatus: input.runSimulation.status,
      latestMetrics: input.runSimulation.latestMetrics
    },
    directionFeed: {
      proposals: proposalPayloads.map((proposal) => ({
        id: proposal.id,
        slug: proposal.slug,
        stage: proposal.stage,
        executionCompatibility: proposal.executionCompatibility,
        directionKind: proposal.directionKind,
        mode: proposal.mode,
        parentDirectionId: proposal.parentId,
        cid: proposal.cid
      })),
      winners
    },
    runTimeline: runUpdates.map((update) => ({
      index: update.index,
      event: update.event,
      timestamp: update.timestamp,
      step: update.step,
      status: update.status,
      cid: update.cid
    })),
    artifactPanel: {
      metadataCid: pseudoCid(metadataJsonPlaceholder(metadata)),
      activeDirectionCid,
      latestStateCid
    }
  });

  const talliesJson = stableStringify({
    schema: "plgenesis/governance-tally@v1",
    agentId,
    runId: input.runId,
    tallies,
    winners
  });

  const proposalsJson = stableStringify({
    schema: "plgenesis/research-direction-set@v1",
    agentId,
    runId: input.runId,
    proposals: proposalPayloads.map((proposal) => ({
      id: proposal.id,
      slug: proposal.slug,
      stage: proposal.stage,
      executionCompatibility: proposal.executionCompatibility,
      parentDirectionId: proposal.parentId,
      cid: proposal.cid,
      digest: proposal.digest,
      title: proposal.title
    }))
  });

  const metadataJson = stableStringify(metadata);
  const metadataCid = pseudoCid(metadataJson);

  const dashboardStateJson = stableStringify({
    ...JSON.parse(dashboardState),
    artifactPanel: {
      metadataCid,
      activeDirectionCid,
      latestStateCid,
      runUpdateCids: runUpdates.map((update) => update.cid)
    }
  });

  const runUpdatesJson = stableStringify({
    schema: "plgenesis/run-update-set@v1",
    agentId,
    runId: input.runId,
    scheduledRunId: input.runSimulation.scheduledRunId,
    updates: runUpdates.map((update) => ({
      index: update.index,
      runId: input.runId,
      scheduledRunId: input.runSimulation.scheduledRunId,
      directionId: activeProposal.id,
      directionSlug: activeProposal.slug,
      event: update.event,
      timestamp: update.timestamp,
      step: update.step,
      status: update.status,
      metrics: update.metrics,
      cid: update.cid,
      digest: update.digest
    }))
  });

  const artifactManifestJson = stableStringify({
    schema: "plgenesis/artifact-manifest@v1",
    agentId,
    runId: input.runId,
    dashboardStateMode: "derived-convenience-view",
    artifacts: {
      metadataCid,
      proposalSetCid: pseudoCid(proposalsJson),
      activeDirectionCid,
      governanceTallyCid: pseudoCid(talliesJson),
      runUpdateSetCid: pseudoCid(runUpdatesJson),
      dashboardStateCid: pseudoCid(dashboardStateJson),
      finalStateCid: latestStateCid
    }
  });

  const calldata = {
    registerAgent: encodeRegisterAgent({
      agentId,
      metadataCid
    }),
    configureVoterWeights: input.steering.voterWeights.map((entry) => ({
      voter: entry.voter,
      weight: entry.weight,
      calldata: encodeConfigureVoterWeight({
        agentId,
        voter: entry.voter,
        weight: entry.weight
      })
    })),
    proposeDirection: proposalPayloads.map((proposal) => ({
      proposalId: proposal.id,
      slug: proposal.slug,
      calldata: encodeProposeDirection({
        agentId,
        stage: proposal.stageCode,
        parentDirectionId: proposal.parentId,
        proposalCid: proposal.cid,
        proposalDigest: proposal.digest
      })
    })),
    voteOnDirection: input.steering.votes.map((vote) => {
      const proposal = proposalPayloads.find((item) => item.slug === vote.proposalSlug);
      return {
        proposalId: proposal.id,
        proposalSlug: proposal.slug,
        voter: vote.voter,
        calldata: encodeVoteOnDirection({
          agentId,
          proposalId: proposal.id
        })
      };
    }),
    finalizeDirection: encodeFinalizeDirection({
      agentId,
      proposalId: activeProposal.id,
      directionCid: activeDirectionCid,
      directionDigest: activeDirectionDigest
    }),
    submitResearchRun: encodeSubmitResearchRun({
      agentId,
      directionId: activeProposal.id,
      stateCid: latestStateCid,
      stateDigest
    })
  };

  return {
    network: NETWORK,
    owner: OWNER,
    agentId,
    governancePlan: {
      proposals: proposalPayloads,
      tallies,
      winners
    },
    files: {
      "metadata.json": metadataJson,
      "state.json": stateJson,
      "active-direction.json": `${activeDirection}\n`.trimEnd(),
      "governance-tally.json": talliesJson,
      "proposals.json": proposalsJson,
      "run-updates.json": runUpdatesJson,
      "dashboard-state.json": dashboardStateJson,
      "artifact-manifest.json": artifactManifestJson
    },
    summary: {
      agentName: input.agentName,
      runId: input.runId,
      metadataCid,
      activeDirectionId: activeProposal.id,
      activeDirectionSlug: activeProposal.slug,
      activeDirectionCid,
      activeDirectionDigest,
      latestStateCid,
      latestStateDigest: stateDigest,
      winners,
      dashboardStateMode: "derived-convenience-view",
      explorationBudget: input.steering.explorationBudget,
      dashboardStateCid: pseudoCid(dashboardStateJson),
      runUpdateSetCid: pseudoCid(runUpdatesJson),
      artifactManifestCid: pseudoCid(artifactManifestJson),
      calldata
    }
  };
}

function metadataJsonPlaceholder(metadata) {
  return stableStringify(metadata);
}

function validateInput(input) {
  const required = [
    "agentName",
    "runId",
    "generatedAt",
    "goal",
    "summary",
    "findings",
    "sources",
    "autoresearch",
    "steering",
    "runSimulation"
  ];

  for (const key of required) {
    if (!(key in input)) {
      throw new Error(`Missing required field: ${key}`);
    }
  }

  if (!Array.isArray(input.steering?.proposals) || input.steering.proposals.length === 0) {
    throw new Error("Missing required field: steering.proposals");
  }

  if (!Array.isArray(input.steering?.votes) || input.steering.votes.length === 0) {
    throw new Error("Missing required field: steering.votes");
  }

  return input;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function sha256Hex(value) {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function pseudoCid(value) {
  return `urn:sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function extractMetrics(snapshot) {
  const metrics = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (["event", "timestamp", "step", "status", "message"].includes(key)) {
      continue;
    }
    metrics[key] = value;
  }
  return Object.keys(metrics).length > 0 ? metrics : null;
}

function bytes32FromText(value) {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}
