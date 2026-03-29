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

const ABI = parseAbi([
  "function configureVoterWeight(bytes32 agentId, address voter, uint256 weight)",
  "function registerAgent(bytes32 agentId, string metadataCid)",
  "function proposeDirection(bytes32 agentId, uint8 stage, uint256 parentDirectionId, string proposalCid, bytes32 proposalDigest) returns (uint256)",
  "function voteOnDirection(bytes32 agentId, uint256 proposalId)",
  "function finalizeDirection(bytes32 agentId, uint256 proposalId, string directionCid, bytes32 directionDigest)",
  "function submitResearchRun(bytes32 agentId, uint256 directionId, string stateCid, bytes32 stateDigest)"
]);

const DEFAULT_AGENT_ID = "0x33fe488c831546fd0385aa07dd5357b1c8057e65805c98afd4be4f3ab59f44cf";
const WORKSPACE_DIR = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const rpcUrl = process.env.RPC_URL ?? process.env.RPC;
  const privateKey = process.env.PRIVATE_KEY;
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const agentId = process.env.AGENT_ID ?? DEFAULT_AGENT_ID;
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

  const txs = [];

  txs.push(await send("registerAgent", [agentId, manifest.artifacts.metadataCid], walletClient, contractAddress));
  txs.push(await send("configureVoterWeight", [agentId, account.address, 1], walletClient, contractAddress));
  for (const item of proposalsSet.proposals) {
    if (item.executionCompatibility !== "current-autoresearch") {
      continue;
    }
    txs.push(
      await send(
        "proposeDirection",
        [agentId, stageCode(item.stage), item.parentDirectionId, item.cid, item.digest],
        walletClient,
        contractAddress
      )
    );
  }
  txs.push(await send("voteOnDirection", [agentId, proposal.id], walletClient, contractAddress));
  txs.push(await send("finalizeDirection", [agentId, proposal.id, activeDirection.proposal.cid, activeDirection.proposal.digest], walletClient, contractAddress));
  txs.push(await send("submitResearchRun", [agentId, activeDirection.proposal.id, runState.stateCid, runState.stateDigest], walletClient, contractAddress));

  const receipts = [];
  for (const hash of txs) {
    receipts.push(await publicClient.waitForTransactionReceipt({ hash }));
  }

  console.log(JSON.stringify({
    agentId,
    contractAddress,
    account: account.address,
    txs,
    receipts: receipts.map((receipt) => ({
      hash: receipt.transactionHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber?.toString()
    })),
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

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
