import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepareExperiment } from "../src/lib/payload.js";
import { ResearchRegistryModel, STAGE } from "../src/lib/governance.js";

const FIXTURE_URL = new URL("../fixtures/research-input.json", import.meta.url);

test("prepareExperiment builds deterministic governance-ready Filecoin payloads", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
  const result = prepareExperiment(fixture);

  assert.equal(result.network.chainId, 314159);
  assert.equal(result.summary.activeDirectionSlug, "tune-extend-short-window");
  assert.equal(result.summary.winners.bootstrap.slug, "bootstrap-compact-gpt");
  assert.equal(result.summary.winners.tuning.slug, "tune-extend-short-window");
  assert.equal(result.summary.dashboardStateMode, "derived-convenience-view");
  assert.equal(result.summary.explorationBudget.challengerRunsPerCycle, 1);
  assert.match(result.summary.dashboardStateCid, /^urn:sha256:[a-f0-9]{64}$/);
  assert.match(result.summary.runUpdateSetCid, /^urn:sha256:[a-f0-9]{64}$/);
  assert.match(result.summary.artifactManifestCid, /^urn:sha256:[a-f0-9]{64}$/);
  assert.match(result.summary.metadataCid, /^urn:sha256:[a-f0-9]{64}$/);
  assert.match(result.summary.activeDirectionCid, /^urn:sha256:[a-f0-9]{64}$/);
  assert.match(result.summary.latestStateDigest, /^0x[a-f0-9]{64}$/);
  assert.equal(result.governancePlan.proposals.length, 4);
  assert.equal(result.governancePlan.tallies.length, 4);
  assert.equal(result.governancePlan.proposals[0].stageCode, STAGE.bootstrap);
  assert.equal(result.governancePlan.proposals[2].stageCode, STAGE.tuning);
  assert.equal(result.governancePlan.proposals[0].executionCompatibility, "current-autoresearch");
  assert.equal(result.governancePlan.proposals[3].executionCompatibility, "future-autoresearch");
  assert.equal(result.governancePlan.proposals[2].branchStrategy, "diverge-from-parent");
  assert.equal(result.governancePlan.proposals[3].mode, "exploit");
  assert.equal(result.governancePlan.winners.tuning.slug, "tune-extend-short-window");
  assert.equal(result.summary.calldata.configureVoterWeights.length, 3);
  assert.equal(result.summary.calldata.proposeDirection.length, 4);
  assert.equal(result.summary.calldata.voteOnDirection.length, 6);
  assert.equal(result.summary.calldata.registerAgent.slice(0, 10), "0x76d43dd9");
  assert.equal(result.summary.calldata.configureVoterWeights[0].calldata.slice(0, 10), "0x92e6656e");
  assert.equal(result.summary.calldata.proposeDirection[0].calldata.slice(0, 10), "0xcecefc38");
  assert.equal(result.summary.calldata.voteOnDirection[0].calldata.slice(0, 10), "0x466186b1");
  assert.equal(result.summary.calldata.finalizeDirection.slice(0, 10), "0xbaef95cf");
  assert.equal(result.summary.calldata.submitResearchRun.slice(0, 10), "0xc80f1c67");
  assert.ok("artifact-manifest.json" in result.files);
  assert.ok("run-updates.json" in result.files);
  assert.ok("dashboard-state.json" in result.files);

  const runUpdates = JSON.parse(result.files["run-updates.json"]);
  assert.equal(runUpdates.updates[0].runId, fixture.runId);
  assert.equal(runUpdates.updates[0].scheduledRunId, fixture.runSimulation.scheduledRunId);
  assert.equal(runUpdates.updates[0].directionId, result.summary.activeDirectionId);
  assert.equal(runUpdates.updates[0].directionSlug, result.summary.activeDirectionSlug);
  assert.equal(runUpdates.updates[0].event, "run-start");
  assert.equal(runUpdates.updates[0].status, "started");
  assert.equal(runUpdates.updates[0].step, 0);
  assert.ok("metrics" in runUpdates.updates[0]);

  const artifactManifest = JSON.parse(result.files["artifact-manifest.json"]);
  assert.equal(artifactManifest.dashboardStateMode, "derived-convenience-view");
  assert.equal(artifactManifest.artifacts.finalStateCid, result.summary.latestStateCid);
});

test("contract model supports propose, vote, finalize, and run submission", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
  const result = prepareExperiment(fixture);
  const model = new ResearchRegistryModel();
  const owner = result.owner;

  model.registerAgent({
    agentId: result.agentId,
    owner,
    metadataCid: result.summary.metadataCid
  });

  for (const voter of fixture.steering.voterWeights) {
    model.configureVoterWeight({
      agentId: result.agentId,
      owner,
      voter: voter.voter,
      weight: voter.weight
    });
  }

  for (const proposal of result.governancePlan.proposals) {
    const proposalId = model.proposeDirection({
      agentId: result.agentId,
      proposer: owner,
      stageCode: proposal.stageCode,
      parentDirectionId: proposal.parentId,
      proposalCid: proposal.cid,
      proposalDigest: proposal.digest
    });
    assert.equal(proposalId, proposal.id);
  }

  for (const vote of fixture.steering.votes) {
    const proposal = result.governancePlan.proposals.find(
      (item) => item.slug === vote.proposalSlug
    );
    model.voteOnDirection({
      agentId: result.agentId,
      proposalId: proposal.id,
      voter: vote.voter
    });
  }

  model.finalizeDirection({
    agentId: result.agentId,
    owner,
    proposalId: result.summary.activeDirectionId,
    directionCid: result.summary.activeDirectionCid,
    directionDigest: result.summary.activeDirectionDigest
  });

  model.submitResearchRun({
    agentId: result.agentId,
    owner,
    directionId: result.summary.activeDirectionId,
    stateCid: result.summary.latestStateCid,
    stateDigest: result.summary.latestStateDigest
  });

  const agent = model.agents.get(result.agentId);
  assert.equal(agent.activeDirectionId, result.summary.activeDirectionId);
  assert.equal(agent.latestStateCid, result.summary.latestStateCid);
  assert.equal(
    agent.proposals.get(result.summary.activeDirectionId).voteWeight,
    result.governancePlan.tallies.find(
      (item) => item.proposalId === result.summary.activeDirectionId
    ).weight
  );
});

test("contract model rejects duplicate votes", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
  const result = prepareExperiment(fixture);
  const model = new ResearchRegistryModel();
  const owner = result.owner;
  const voter = fixture.steering.voterWeights[0];
  const proposal = result.governancePlan.proposals[0];

  model.registerAgent({
    agentId: result.agentId,
    owner,
    metadataCid: result.summary.metadataCid
  });
  model.configureVoterWeight({
    agentId: result.agentId,
    owner,
    voter: voter.voter,
    weight: voter.weight
  });
  model.proposeDirection({
    agentId: result.agentId,
    proposer: owner,
    stageCode: proposal.stageCode,
    parentDirectionId: proposal.parentId,
    proposalCid: proposal.cid,
    proposalDigest: proposal.digest
  });

  model.voteOnDirection({
    agentId: result.agentId,
    proposalId: proposal.id,
    voter: voter.voter
  });

  assert.throws(
    () =>
      model.voteOnDirection({
        agentId: result.agentId,
        proposalId: proposal.id,
        voter: voter.voter
      }),
    /already voted/
  );
});

test("prepareExperiment rejects incomplete input", () => {
  assert.throws(
    () =>
      prepareExperiment({
        agentName: "x"
      }),
    /Missing required field: runId/
  );
});
