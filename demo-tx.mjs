import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  defineChain
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import crypto from "node:crypto";

const ABI = parseAbi([
  "function configureVoterWeight(bytes32 agentId, address voter, uint256 weight)",
  "function registerAgent(bytes32 agentId, string metadataCid)",
  "function proposeDirection(bytes32 agentId, uint8 stage, uint256 parentDirectionId, string proposalCid, bytes32 proposalDigest) returns (uint256)",
  "function voteOnDirection(bytes32 agentId, uint256 proposalId)",
  "function finalizeDirection(bytes32 agentId, uint256 proposalId, string directionCid, bytes32 directionDigest)",
  "function submitResearchRun(bytes32 agentId, uint256 directionId, string stateCid, bytes32 stateDigest)",
  "function hasVoted(bytes32 agentId, uint256 proposalId, address voter) view returns (bool)",
  "function voterWeights(bytes32 agentId, address voter) view returns (uint256)",
  "function agents(bytes32 agentId) view returns (address owner, string metadataCid, uint256 activeDirectionId, string activeDirectionCid, bytes32 activeDirectionDigest, string latestStateCid, bytes32 latestStateDigest, uint256 proposalCount, uint256 updatedAt)",
  "function proposals(bytes32 agentId, uint256 proposalId) view returns (uint256 id, uint8 stage, uint256 parentDirectionId, string proposalCid, bytes32 proposalDigest, address proposer, uint256 voteWeight, bool finalized, uint256 createdAt)"
]);

const DEFAULT_AGENT_ID = "0x33fe488c831546fd0385aa07dd5357b1c8057e65805c98afd4be4f3ab59f44cf";
const WORKSPACE_DIR = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const rpcUrl = process.env.RPC_URL ?? process.env.RPC;
  const privateKey = process.env.PRIVATE_KEY;
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const waitSeconds = Number(process.env.DEMO_WAIT_SECONDS ?? 20);
  const metadataPath = process.env.METADATA_PATH ?? path.join(WORKSPACE_DIR, "experiments/filecoin/output/metadata.json");
  const manifestPath = process.env.MANIFEST_PATH ?? path.join(WORKSPACE_DIR, "experiments/filecoin/output/artifact-manifest.json");
  const proposalsPath = process.env.PROPOSALS_PATH ?? path.join(WORKSPACE_DIR, "experiments/filecoin/output/proposals.json");
  const updatesPath = process.env.UPDATES_PATH ?? path.join(WORKSPACE_DIR, "experiments/filecoin/output/run-updates.json");
  const statePath = process.env.STATE_PATH ?? path.join(WORKSPACE_DIR, "experiments/filecoin/output/state.json");
  const activeDirectionPath = process.env.ACTIVE_DIRECTION_PATH ?? path.join(WORKSPACE_DIR, "experiments/filecoin/output/active-direction.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const proposalsSet = JSON.parse(await fs.readFile(proposalsPath, "utf8"));
  const runUpdates = JSON.parse(await fs.readFile(updatesPath, "utf8"));
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const activeDirection = JSON.parse(await fs.readFile(activeDirectionPath, "utf8"));

  if (!rpcUrl || !privateKey || !contractAddress) {
    throw new Error("Set RPC_URL or RPC, PRIVATE_KEY, and CONTRACT_ADDRESS to run the demo tx flow.");
  }

  const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  const freshAgent = process.env.FRESH_AGENT !== "false";
  const agentId = process.env.AGENT_ID ?? (freshAgent ? deriveAgentId(account.address) : DEFAULT_AGENT_ID);
  const chain = defineChain({
    id: Number(process.env.CHAIN_ID ?? 314159),
    name: process.env.CHAIN_NAME ?? "DemoChain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  });

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });

  const proposal = activeDirection.proposal;
  const runState = {
    stateCid: metadata.latestStateCid,
    stateDigest: metadata.latestStateDigest
  };
  const stageCode = (stage) => (stage === "bootstrap" ? 0 : 1);
  const agent = await readAgent(publicClient, contractAddress, agentId);
  const activeProposal = await readProposal(publicClient, contractAddress, agentId, proposal.id);

  const steps = [];
  if (!agent || agent[0] === "0x0000000000000000000000000000000000000000") {
    steps.push(["registerAgent", [agentId, manifest.artifacts.metadataCid]]);
  }
  const voterWeight = await publicClient.readContract({
    address: contractAddress,
    abi: ABI,
    functionName: "voterWeights",
    args: [agentId, account.address]
  }).catch(() => 0n);
  if (voterWeight === 0n) {
    steps.push(["configureVoterWeight", [agentId, account.address, 1]]);
  }
  for (const item of proposalsSet.proposals) {
    if (item.executionCompatibility !== "current-autoresearch") {
      continue;
    }
    const existing = await findProposal(publicClient, contractAddress, agentId, item.cid);
    if (!existing) {
      steps.push(["proposeDirection", [agentId, stageCode(item.stage), item.parentDirectionId, item.cid, item.digest]]);
    }
  }
  const alreadyVoted = await publicClient.readContract({
    address: contractAddress,
    abi: ABI,
    functionName: "hasVoted",
    args: [agentId, proposal.id, account.address]
  });
  if (!alreadyVoted) {
    steps.push(["voteOnDirection", [agentId, proposal.id]]);
  }
  if (!activeProposal?.[7]) {
    steps.push(["finalizeDirection", [agentId, proposal.id, activeDirection.proposal.cid, activeDirection.proposal.digest]]);
  }
  if (!agent || agent[5] !== runState.stateCid) {
    steps.push(["submitResearchRun", [agentId, activeDirection.proposal.id, runState.stateCid, runState.stateDigest]]);
  }

  const sent = [];
  for (const [name, args] of steps) {
    try {
      const hash = await send(name, args, walletClient, contractAddress);
      sent.push({ name, hash, args, status: "sent" });
      printStep(name, hash, args);
    } catch (error) {
      sent.push({ name, args, status: "failed", error: error.shortMessage ?? error.message });
      printFailedStep(name, error, args);
      continue;
    }
  }

  const receipts = [];
  for (const { name, hash } of sent) {
    const receipt = await waitForReceipt(publicClient, hash, waitSeconds);
    receipts.push({ name, ...receipt });
  }

  console.log("");
  console.log("=== Demo Summary ===");
  console.log(`agent: ${agentId}`);
  console.log(`contract: ${contractAddress}`);
  console.log(`deployer: ${account.address}`);
  console.log(`active direction: ${activeDirection.proposal.slug}`);
  console.log(`proposal id: ${proposal.id}`);
  console.log(`run state cid: ${runState.stateCid}`);
  console.log(`run updates: ${runUpdates.updates.length}`);
  console.log("");
  console.log(JSON.stringify({
    sent,
    receipts,
    demo: {
      activeDirection: activeDirection.proposal.slug,
      proposalId: proposal.id,
      stateCid: runState.stateCid,
      runUpdates: runUpdates.updates.length
    }
  }, null, 2));
}

async function send(name, args, walletClient, contractAddress) {
  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: ABI,
    functionName: name,
    args
  });
  return hash;
}

async function waitForReceipt(publicClient, hash, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) {
      return {
        hash: receipt.transactionHash,
        status: receipt.status,
        blockNumber: receipt.blockNumber?.toString()
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  return {
    hash,
    status: "pending",
    blockNumber: null
  };
}

function printStep(name, hash, args) {
  console.log(`\n[tx] ${name}`);
  console.log(`hash: ${hash}`);
  console.log(`args: ${JSON.stringify(args)}`);
}

function printFailedStep(name, error, args) {
  console.log(`\n[tx] ${name} (failed)`);
  console.log(`error: ${error.shortMessage ?? error.message}`);
  console.log(`args: ${JSON.stringify(args)}`);
}

function deriveAgentId(address) {
  const digest = crypto.createHash("sha256").update(`plgenesis:${address}:${Date.now()}`).digest("hex");
  return `0x${digest}`;
}

async function readAgent(publicClient, contractAddress, agentId) {
  return publicClient.readContract({
    address: contractAddress,
    abi: ABI,
    functionName: "agents",
    args: [agentId]
  }).catch(() => null);
}

async function findProposal(publicClient, contractAddress, agentId, proposalCid) {
  for (let id = 1; id <= 12; id += 1) {
    const proposal = await readProposal(publicClient, contractAddress, agentId, id);
    if (proposal && proposal.proposalCid === proposalCid) {
      return proposal;
    }
  }
  return null;
}

async function readProposal(publicClient, contractAddress, agentId, proposalId) {
  return publicClient.readContract({
    address: contractAddress,
    abi: ABI,
    functionName: "proposals",
    args: [agentId, proposalId]
  }).catch(() => null);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
