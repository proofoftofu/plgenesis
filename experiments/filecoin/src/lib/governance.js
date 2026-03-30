export const STAGE = {
  bootstrap: 0,
  tuning: 1
};

export function buildGovernancePlan(steering, agentId) {
  const voterWeightMap = new Map(
    steering.voterWeights.map((entry) => [entry.voter.toLowerCase(), entry.weight])
  );
  const proposals = steering.proposals.map((proposal, index) => ({
    ...proposal,
    id: index + 1,
    stageCode: stageCode(proposal.stage),
    executionCompatibility: proposal.executionCompatibility,
    branchTarget: proposal.branchTarget,
    branchStrategy: proposal.branchStrategy,
    mode: proposal.mode,
    directionKind: proposal.directionKind,
    parentId: proposal.parentSlug
      ? resolveParentId(steering.proposals, proposal.parentSlug)
      : 0
  }));

  const tallyByProposalId = new Map(
    proposals.map((proposal) => [proposal.id, createEmptyTally(proposal)])
  );

  for (const vote of steering.votes) {
    const proposal = proposals.find((item) => item.slug === vote.proposalSlug);
    if (!proposal) {
      throw new Error(`Unknown proposal slug in vote: ${vote.proposalSlug}`);
    }

    const weight = voterWeightMap.get(vote.voter.toLowerCase());
    if (!weight) {
      throw new Error(`Unknown voter in vote list: ${vote.voter}`);
    }

    const tally = tallyByProposalId.get(proposal.id);
    if (tally.voters.includes(vote.voter.toLowerCase())) {
      throw new Error(`Duplicate vote for proposal ${vote.proposalSlug} by ${vote.voter}`);
    }

    tally.weight += weight;
    tally.voteCount += 1;
    tally.voters.push(vote.voter.toLowerCase());
    tally.reasons.push(vote.reason);
  }

  const tallies = proposals.map((proposal) => tallyByProposalId.get(proposal.id));
  const winners = {
    bootstrap: pickWinner(proposals, tallies, "bootstrap", steering.governance.quorum),
    tuning: pickWinner(proposals, tallies, "tuning", steering.governance.quorum),
    runnableBootstrap: pickWinner(
      proposals,
      tallies,
      "bootstrap",
      steering.governance.quorum,
      "current-autoresearch"
    ),
    runnableTuning: pickWinner(
      proposals,
      tallies,
      "tuning",
      steering.governance.quorum,
      "current-autoresearch"
    )
  };

  const activeWinner =
    steering.execution.targetStage === "tuning" && winners.runnableTuning
      ? winners.runnableTuning
      : winners.runnableBootstrap ?? winners.runnableTuning;

  if (!activeWinner) {
    throw new Error("No active direction selected");
  }

  return {
    agentId,
    proposals,
    tallies,
    winners,
    activeWinner,
    explorationBudget: steering.explorationBudget
  };
}

export function createGovernanceArtifacts({ agentId, governancePlan, stateCid, stateDigest }) {
  const register = {
    agentId
  };

  const configureVoterWeights = governancePlan.proposals.length
    ? null
    : null;

  return {
    register,
    configureVoterWeights,
    stateCid,
    stateDigest
  };
}

export class ResearchRegistryModel {
  constructor() {
    this.agents = new Map();
  }

  registerAgent({ agentId, owner, metadataCid }) {
    assertBytes32(agentId, "agentId");
    if (!metadataCid) {
      throw new Error("metadataCid required");
    }

    const record = this.agents.get(agentId) ?? {
      owner,
      metadataCid: "",
      activeDirectionId: 0,
      activeDirectionCid: "",
      activeDirectionDigest: "",
      latestStateCid: "",
      latestStateDigest: "",
      proposalCount: 0,
      proposals: new Map(),
      voterWeights: new Map()
    };

    if (record.owner && record.owner !== owner) {
      throw new Error("owner only");
    }

    record.owner = owner;
    record.metadataCid = metadataCid;
    this.agents.set(agentId, record);
  }

  configureVoterWeight({ agentId, owner, voter, weight }) {
    const agent = this.requireOwner(agentId, owner);
    if (!voter) {
      throw new Error("voter required");
    }
    if (!(weight > 0)) {
      throw new Error("weight required");
    }
    agent.voterWeights.set(voter.toLowerCase(), weight);
  }

  proposeDirection({
    agentId,
    proposer,
    stageCode,
    parentDirectionId,
    proposalCid,
    proposalDigest
  }) {
    const agent = this.requireAgent(agentId);
    if (!proposalCid) {
      throw new Error("proposalCid required");
    }
    if (!proposalDigest) {
      throw new Error("proposalDigest required");
    }
    if (stageCode === STAGE.tuning && !(parentDirectionId > 0)) {
      throw new Error("parentDirectionId required");
    }

    agent.proposalCount += 1;
    const proposal = {
      id: agent.proposalCount,
      proposer,
      stageCode,
      parentDirectionId,
      proposalCid,
      proposalDigest,
      voteWeight: 0,
      finalized: false,
      voters: new Set()
    };
    agent.proposals.set(proposal.id, proposal);
    return proposal.id;
  }

  voteOnDirection({ agentId, proposalId, voter }) {
    const agent = this.requireAgent(agentId);
    const weight = agent.voterWeights.get(voter.toLowerCase()) ?? 0;
    if (!(weight > 0)) {
      throw new Error("voter not configured");
    }

    const proposal = agent.proposals.get(proposalId);
    if (!proposal) {
      throw new Error("proposal missing");
    }
    if (proposal.finalized) {
      throw new Error("proposal finalized");
    }
    if (proposal.voters.has(voter.toLowerCase())) {
      throw new Error("already voted");
    }

    proposal.voters.add(voter.toLowerCase());
    proposal.voteWeight += weight;
  }

  finalizeDirection({ agentId, owner, proposalId, directionCid, directionDigest }) {
    const agent = this.requireOwner(agentId, owner);
    const proposal = agent.proposals.get(proposalId);
    if (!proposal) {
      throw new Error("proposal missing");
    }
    if (proposal.finalized) {
      throw new Error("proposal finalized");
    }
    if (!(proposal.voteWeight > 0)) {
      throw new Error("votes required");
    }
    if (!directionCid) {
      throw new Error("directionCid required");
    }
    if (!directionDigest) {
      throw new Error("directionDigest required");
    }

    proposal.finalized = true;
    agent.activeDirectionId = proposalId;
    agent.activeDirectionCid = directionCid;
    agent.activeDirectionDigest = directionDigest;
  }

  submitResearchRun({ agentId, owner, directionId, stateCid, stateDigest }) {
    const agent = this.requireOwner(agentId, owner);
    if (agent.activeDirectionId !== directionId) {
      throw new Error("inactive direction");
    }
    if (!stateCid) {
      throw new Error("stateCid required");
    }
    if (!stateDigest) {
      throw new Error("stateDigest required");
    }

    agent.latestStateCid = stateCid;
    agent.latestStateDigest = stateDigest;
  }

  requireAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error("agent missing");
    }
    return agent;
  }

  requireOwner(agentId, owner) {
    const agent = this.requireAgent(agentId);
    if (agent.owner !== owner) {
      throw new Error("owner only");
    }
    return agent;
  }
}

function createEmptyTally(proposal) {
  return {
    proposalId: proposal.id,
    slug: proposal.slug,
    stage: proposal.stage,
    weight: 0,
    voteCount: 0,
    voters: [],
    reasons: []
  };
}

function pickWinner(proposals, tallies, stage, quorum, executionCompatibility = null) {
  const stageTallies = tallies.filter((item) => {
    if (item.stage !== stage) {
      return false;
    }
    if (!executionCompatibility) {
      return true;
    }
    const proposal = proposals.find((candidate) => candidate.id === item.proposalId);
    return proposal?.executionCompatibility === executionCompatibility;
  });
  const eligible = stageTallies.filter((item) => item.weight >= quorum);
  const candidates = eligible.length > 0 ? eligible : stageTallies;

  if (candidates.length === 0) {
    return null;
  }

  const winnerTally = [...candidates].sort((left, right) => {
    if (right.weight !== left.weight) {
      return right.weight - left.weight;
    }
    return left.proposalId - right.proposalId;
  })[0];

  const proposal = proposals.find((item) => item.id === winnerTally.proposalId);
  return {
    proposalId: proposal.id,
    slug: proposal.slug,
    stage: proposal.stage,
    executionCompatibility: proposal.executionCompatibility,
    voteWeight: winnerTally.weight,
    parentId: proposal.parentId
  };
}

function resolveParentId(proposals, parentSlug) {
  const index = proposals.findIndex((proposal) => proposal.slug === parentSlug);
  if (index === -1) {
    throw new Error(`Unknown parent proposal slug: ${parentSlug}`);
  }
  return index + 1;
}

function stageCode(stage) {
  if (!(stage in STAGE)) {
    throw new Error(`Unsupported proposal stage: ${stage}`);
  }
  return STAGE[stage];
}

function assertBytes32(value, label) {
  if (!/^0x[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} required`);
  }
}
