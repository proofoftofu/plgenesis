// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ResearchRegistry {
    enum Stage {
        BootstrapArchitecture,
        ResearchTuning
    }

    struct AgentRecord {
        address owner;
        string metadataCid;
        uint256 activeDirectionId;
        string activeDirectionCid;
        bytes32 activeDirectionDigest;
        string latestStateCid;
        bytes32 latestStateDigest;
        uint256 proposalCount;
        uint256 updatedAt;
    }

    struct DirectionProposal {
        uint256 id;
        Stage stage;
        uint256 parentDirectionId;
        string proposalCid;
        bytes32 proposalDigest;
        address proposer;
        uint256 voteWeight;
        bool finalized;
        uint256 createdAt;
    }

    struct ResearchProgressRecord {
        uint256 directionId;
        uint256 step;
        string progressCid;
        bytes32 progressDigest;
        uint256 updatedAt;
    }

    mapping(bytes32 => AgentRecord) public agents;
    mapping(bytes32 => mapping(uint256 => DirectionProposal)) public proposals;
    mapping(bytes32 => mapping(address => uint256)) public voterWeights;
    mapping(bytes32 => mapping(uint256 => mapping(address => bool))) public hasVoted;
    mapping(bytes32 => mapping(uint256 => ResearchProgressRecord)) public progressRecords;

    event AgentRegistered(bytes32 indexed agentId, address indexed owner, string metadataCid);
    event VoterWeightConfigured(bytes32 indexed agentId, address indexed voter, uint256 weight);
    event DirectionProposed(
        bytes32 indexed agentId,
        uint256 indexed proposalId,
        Stage stage,
        uint256 parentDirectionId,
        string proposalCid,
        bytes32 proposalDigest,
        address proposer
    );
    event DirectionVoted(
        bytes32 indexed agentId,
        uint256 indexed proposalId,
        address indexed voter,
        uint256 weight,
        uint256 totalVoteWeight
    );
    event DirectionFinalized(
        bytes32 indexed agentId,
        uint256 indexed proposalId,
        string directionCid,
        bytes32 directionDigest
    );
    event ResearchRunSubmitted(
        bytes32 indexed agentId,
        uint256 indexed directionId,
        string stateCid,
        bytes32 stateDigest
    );
    event ResearchProgressSubmitted(
        bytes32 indexed agentId,
        uint256 indexed directionId,
        uint256 step,
        string progressCid,
        bytes32 progressDigest
    );

    function registerAgent(bytes32 agentId, string calldata metadataCid) external {
        require(agentId != bytes32(0), "agentId required");
        require(bytes(metadataCid).length > 0, "metadataCid required");

        AgentRecord storage record = agents[agentId];
        if (record.owner == address(0)) {
            record.owner = msg.sender;
        }

        record.metadataCid = metadataCid;
        record.updatedAt = block.timestamp;

        emit AgentRegistered(agentId, record.owner, metadataCid);
    }

    function configureVoterWeight(
        bytes32 agentId,
        address voter,
        uint256 weight
    ) external {
        require(voter != address(0), "voter required");
        require(weight > 0, "weight required");
        require(voter == msg.sender, "self only");

        voterWeights[agentId][voter] = weight;
        emit VoterWeightConfigured(agentId, voter, weight);
    }

    function proposeDirection(
        bytes32 agentId,
        Stage stage,
        uint256 parentDirectionId,
        string calldata proposalCid,
        bytes32 proposalDigest
    ) external returns (uint256 proposalId) {
        require(agents[agentId].updatedAt != 0, "agent missing");
        require(bytes(proposalCid).length > 0, "proposalCid required");
        require(proposalDigest != bytes32(0), "proposalDigest required");
        if (stage == Stage.ResearchTuning) {
            require(parentDirectionId > 0, "parentDirectionId required");
        }

        AgentRecord storage agent = agents[agentId];
        agent.proposalCount += 1;
        proposalId = agent.proposalCount;

        proposals[agentId][proposalId] = DirectionProposal({
            id: proposalId,
            stage: stage,
            parentDirectionId: parentDirectionId,
            proposalCid: proposalCid,
            proposalDigest: proposalDigest,
            proposer: msg.sender,
            voteWeight: 0,
            finalized: false,
            createdAt: block.timestamp
        });

        emit DirectionProposed(
            agentId,
            proposalId,
            stage,
            parentDirectionId,
            proposalCid,
            proposalDigest,
            msg.sender
        );
    }

    function voteOnDirection(bytes32 agentId, uint256 proposalId) external {
        require(!hasVoted[agentId][proposalId][msg.sender], "already voted");

        DirectionProposal storage proposal = proposals[agentId][proposalId];
        require(proposal.id != 0, "proposal missing");
        require(!proposal.finalized, "proposal finalized");

        uint256 weight = voterWeights[agentId][msg.sender];
        if (weight == 0) {
            weight = 1;
        }
        hasVoted[agentId][proposalId][msg.sender] = true;
        proposal.voteWeight += weight;

        emit DirectionVoted(agentId, proposalId, msg.sender, weight, proposal.voteWeight);
    }

    function finalizeDirection(
        bytes32 agentId,
        uint256 proposalId,
        string calldata directionCid,
        bytes32 directionDigest
    ) external {
        require(bytes(directionCid).length > 0, "directionCid required");
        require(directionDigest != bytes32(0), "directionDigest required");

        DirectionProposal storage proposal = proposals[agentId][proposalId];
        require(proposal.id != 0, "proposal missing");
        require(!proposal.finalized, "proposal finalized");
        require(proposal.voteWeight > 0, "votes required");

        proposal.finalized = true;

        AgentRecord storage agent = agents[agentId];
        agent.activeDirectionId = proposalId;
        agent.activeDirectionCid = directionCid;
        agent.activeDirectionDigest = directionDigest;
        agent.updatedAt = block.timestamp;

        emit DirectionFinalized(agentId, proposalId, directionCid, directionDigest);
    }

    function submitResearchRun(
        bytes32 agentId,
        uint256 directionId,
        string calldata stateCid,
        bytes32 stateDigest
    ) external {
        require(directionId == agents[agentId].activeDirectionId, "inactive direction");
        require(bytes(stateCid).length > 0, "stateCid required");
        require(stateDigest != bytes32(0), "stateDigest required");

        AgentRecord storage agent = agents[agentId];
        agent.latestStateCid = stateCid;
        agent.latestStateDigest = stateDigest;
        agent.updatedAt = block.timestamp;

        emit ResearchRunSubmitted(agentId, directionId, stateCid, stateDigest);
    }

    function submitResearchProgress(
        bytes32 agentId,
        uint256 directionId,
        uint256 step,
        string calldata progressCid,
        bytes32 progressDigest
    ) external {
        require(directionId == agents[agentId].activeDirectionId, "inactive direction");
        require(bytes(progressCid).length > 0, "progressCid required");
        require(progressDigest != bytes32(0), "progressDigest required");

        progressRecords[agentId][directionId] = ResearchProgressRecord({
            directionId: directionId,
            step: step,
            progressCid: progressCid,
            progressDigest: progressDigest,
            updatedAt: block.timestamp
        });

        emit ResearchProgressSubmitted(agentId, directionId, step, progressCid, progressDigest);
    }
}
