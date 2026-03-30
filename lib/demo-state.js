import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, defineChain, parseAbi } from "viem";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(ROOT, "..");
const DEFAULT_FILES = {
  dashboard: path.join(WORKSPACE, "experiments/filecoin/output/dashboard-state.json"),
  activeDirection: path.join(WORKSPACE, "experiments/filecoin/output/active-direction.json"),
  proposals: path.join(WORKSPACE, "experiments/filecoin/output/proposals.json"),
  runUpdates: path.join(WORKSPACE, "experiments/filecoin/output/run-updates.json"),
  summary: path.join(WORKSPACE, "experiments/filecoin/output/summary.json")
};

const ABI = parseAbi([
  "function agents(bytes32 agentId) view returns (address owner, string metadataCid, uint256 activeDirectionId, string activeDirectionCid, bytes32 activeDirectionDigest, string latestStateCid, bytes32 latestStateDigest, uint256 proposalCount, uint256 updatedAt)",
  "function proposals(bytes32 agentId, uint256 proposalId) view returns (uint256 id, uint8 stage, uint256 parentDirectionId, string proposalCid, bytes32 proposalDigest, address proposer, uint256 voteWeight, bool finalized, uint256 createdAt)",
  "function hasVoted(bytes32 agentId, uint256 proposalId, address voter) view returns (bool)",
  "function voterWeights(bytes32 agentId, address voter) view returns (uint256)"
]);

function makeChain(rpcUrl) {
  return defineChain({
    id: Number(process.env.CHAIN_ID ?? 314159),
    name: process.env.CHAIN_NAME ?? "DemoChain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  });
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function parseMode(state) {
  return state?.dashboard?.mode ?? state?.mode ?? "generated";
}

function proposalFromContract(index, raw) {
  return {
    id: Number(raw.id),
    stage: Number(raw.stage),
    parentDirectionId: Number(raw.parentDirectionId),
    cid: raw.proposalCid,
    digest: raw.proposalDigest,
    slug: `proposal-${Number(raw.id)}`,
    executionCompatibility: "current-autoresearch",
    title: `Contract proposal ${Number(raw.id)}`,
    finalized: Boolean(raw.finalized),
    proposer: raw.proposer,
    voteWeight: Number(raw.voteWeight),
    index
  };
}

async function loadFallbackState() {
  const [dashboard, activeDirection, proposals, runUpdates, summary] = await Promise.all([
    readJson(DEFAULT_FILES.dashboard, null),
    readJson(DEFAULT_FILES.activeDirection, null),
    readJson(DEFAULT_FILES.proposals, null),
    readJson(DEFAULT_FILES.runUpdates, null),
    readJson(DEFAULT_FILES.summary, null)
  ]);

  return {
    name: "De-Autoresearch",
    purpose: "Community-directed autoresearch with on-chain proposal and progress tracking.",
    dashboard,
    activeDirection,
    proposals,
    runUpdates,
    summary,
    sourceFiles: DEFAULT_FILES,
    live: false
  };
}

async function loadFromContract() {
  const rpcUrl = process.env.RPC_URL ?? process.env.RPC;
  const contractAddress = process.env.CONTRACT ?? process.env.CONTRACT_ADDRESS;
  const agentId = process.env.AGENT_ID ?? process.env.DEMO_AGENT_ID;

  if (!rpcUrl || !contractAddress || !agentId) {
    return loadFallbackState();
  }

  const client = createPublicClient({ chain: makeChain(rpcUrl), transport: http(rpcUrl) });
  const agent = await client.readContract({
    address: contractAddress,
    abi: ABI,
    functionName: "agents",
    args: [agentId]
  }).catch(() => null);

  if (!agent || agent[0] === "0x0000000000000000000000000000000000000000") {
    return loadFallbackState();
  }

  const proposalCount = Number(agent[7] ?? 0n);
  const proposals = [];
  for (let i = 1; i <= proposalCount; i += 1) {
    const proposal = await client.readContract({
      address: contractAddress,
      abi: ABI,
      functionName: "proposals",
      args: [agentId, i]
    }).catch(() => null);
    if (proposal) {
      proposals.push(proposalFromContract(i, proposal));
    }
  }

  const activeProposal = proposals.find((proposal) => proposal.id === Number(agent[2])) ?? proposals[0] ?? null;
  const dashboard = {
    agentId,
    artifactPanel: {
      metadataCid: agent[1],
      activeDirectionCid: agent[3],
      latestStateCid: agent[5],
      runUpdateCids: []
    },
    directionFeed: {
      proposals,
      winners: {
        active: activeProposal ? {
          proposalId: activeProposal.id,
          slug: activeProposal.slug,
          stage: activeProposal.stage === 0 ? "bootstrap" : "tuning",
          voteWeight: activeProposal.voteWeight,
          executionCompatibility: "current-autoresearch",
          parentId: activeProposal.parentDirectionId
        } : null
      }
    },
    liveRunPanel: {
      activeDirectionId: Number(agent[2]),
      activeDirectionSlug: activeProposal?.slug ?? "n/a",
      latestMetrics: null,
      runStatus: activeProposal?.finalized ? "completed" : "running"
    },
    mode: "live-contract-view"
  };

  return {
    name: "De-Autoresearch",
    purpose: "Community-directed autoresearch with on-chain proposal and progress tracking.",
    dashboard,
    activeDirection: activeProposal ? {
      proposal: {
        id: activeProposal.id,
        stage: activeProposal.stage === 0 ? "bootstrap" : "tuning",
        parentDirectionId: activeProposal.parentDirectionId,
        cid: activeProposal.cid,
        digest: activeProposal.digest,
        slug: activeProposal.slug,
        mode: activeProposal.stage === 0 ? "explore" : "explore",
        branchStrategy: "contract-resolved",
        branchTarget: agent[3]
      }
    } : null,
    proposals: { agentId, proposals },
    runUpdates: { updates: [] },
    summary: { contractAddress, rpcUrl, agentId },
    sourceFiles: DEFAULT_FILES,
    live: true,
    contract: {
      agent,
      agentId,
      contractAddress,
      rpcUrl
    },
    mode: parseMode({ dashboard })
  };
}

export async function getDemoState() {
  try {
    return await loadFromContract();
  } catch {
    return loadFallbackState();
  }
}

