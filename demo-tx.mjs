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
import { spawn } from "node:child_process";
import { runFilecoinPreflight, runFilecoinUpload, normalizePrivateKey } from "./experiments/filecoin/src/lib/filecoin-upload.js";

const ABI = parseAbi([
  "function configureVoterWeight(bytes32 agentId, address voter, uint256 weight)",
  "function registerAgent(bytes32 agentId, string metadataCid)",
  "function proposeDirection(bytes32 agentId, uint8 stage, uint256 parentDirectionId, string proposalCid, bytes32 proposalDigest) returns (uint256)",
  "function voteOnDirection(bytes32 agentId, uint256 proposalId)",
  "function finalizeDirection(bytes32 agentId, uint256 proposalId, string directionCid, bytes32 directionDigest)",
  "function submitResearchProgress(bytes32 agentId, uint256 directionId, uint256 step, string progressCid, bytes32 progressDigest)",
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
  const contractAddress = process.env.CONTRACT ?? process.env.CONTRACT_ADDRESS;
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
    throw new Error("Set RPC_URL or RPC, PRIVATE_KEY, and CONTRACT or CONTRACT_ADDRESS to run the demo tx flow.");
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

  console.log("🚀 Hackathon demo started");
  console.log(`🧬 fresh agent: ${agentId}`);
  console.log(`📦 contract: ${contractAddress}`);
  console.log(`👤 wallet: ${account.address}`);
  console.log("");
  console.log("🗳️ Community direction: proposal -> vote -> finalize");
  console.log("🤖 Autoresearch: execute selected direction and commit progress");
  console.log("");
  console.log(JSON.stringify({
    rpc: rpcUrl,
    contractAddress,
    wallet: account.address,
    demo: {
      waitSeconds,
      runAutoresearch: process.env.RUN_AUTORESEARCH !== "false",
      submitProgressOnChain: process.env.SUBMIT_PROGRESS_ONCHAIN !== "false"
    }
  }, null, 2));
  console.log("");

  const filecoinUpload = await maybeUploadToFilecoin();
  if (filecoinUpload) {
    console.log("📡 Filecoin upload ready");
    console.log(JSON.stringify({
      filecoin: filecoinUpload
    }, null, 2));
    console.log("");
  }

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
    console.log("📝 Registering the research agent");
    console.log(JSON.stringify({
      action: "registerAgent",
      agentId,
      metadataCid: manifest.artifacts.metadataCid
    }, null, 2));
    steps.push(["registerAgent", [agentId, manifest.artifacts.metadataCid]]);
  }
  const voterWeight = await publicClient.readContract({
    address: contractAddress,
    abi: ABI,
    functionName: "voterWeights",
    args: [agentId, account.address]
  }).catch(() => 0n);
  if (voterWeight === 0n) {
    console.log("🗳️ Configuring the local voter weight");
    console.log(JSON.stringify({
      action: "configureVoterWeight",
      agentId,
      voter: account.address,
      weight: 1
    }, null, 2));
    steps.push(["configureVoterWeight", [agentId, account.address, 1]]);
  }
  for (const item of proposalsSet.proposals) {
    if (item.executionCompatibility !== "current-autoresearch") {
      continue;
    }
    const existing = await findProposal(publicClient, contractAddress, agentId, item.cid);
    if (!existing) {
      console.log(`📨 Proposing direction: ${item.slug}`);
      console.log(JSON.stringify({
        action: "proposeDirection",
        proposal: item
      }, null, 2));
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
    console.log(`✅ Voting for active direction: ${proposal.slug}`);
    console.log(JSON.stringify({
      action: "voteOnDirection",
      agentId,
      proposalId: proposal.id,
      proposalCid: proposal.cid,
      proposalDigest: proposal.digest
    }, null, 2));
    steps.push(["voteOnDirection", [agentId, proposal.id]]);
  }
  if (!activeProposal?.[7]) {
    console.log(`🏁 Finalizing direction: ${proposal.slug}`);
    console.log(JSON.stringify({
      action: "finalizeDirection",
      agentId,
      proposalId: proposal.id,
      directionCid: activeDirection.proposal.cid,
      directionDigest: activeDirection.proposal.digest
    }, null, 2));
    steps.push(["finalizeDirection", [agentId, proposal.id, activeDirection.proposal.cid, activeDirection.proposal.digest]]);
  }
  if (!agent || agent[5] !== runState.stateCid) {
    console.log("📌 Committing latest research state onchain");
    console.log(JSON.stringify({
      action: "submitResearchRun",
      agentId,
      directionId: activeDirection.proposal.id,
      stateCid: runState.stateCid,
      stateDigest: runState.stateDigest
    }, null, 2));
    steps.push(["submitResearchRun", [agentId, activeDirection.proposal.id, runState.stateCid, runState.stateDigest]]);
  }

  const sent = [];
  const receipts = [];
  for (const [name, args] of steps) {
    try {
      const hash = await send(name, args, walletClient, contractAddress);
      sent.push({ name, hash, args, status: "sent" });
      printStep(name, hash, args);
      const receipt = await waitForReceipt(publicClient, hash, waitSeconds);
      receipts.push({ name, ...receipt });
      if (receipt.status === "pending") {
        console.log(`⏳ Receipt pending: ${name}`);
      } else {
        console.log(`✅ Confirmed: ${name} (${receipt.status})`);
      }
    } catch (error) {
      sent.push({ name, args, status: "failed", error: error.shortMessage ?? error.message });
      printFailedStep(name, error, args);
      receipts.push({ name, status: "failed", blockNumber: null, error: error.shortMessage ?? error.message });
      continue;
    }
  }

  const autoresearch = await maybeRunAutoresearch({
    walletClient,
    publicClient,
    contractAddress,
    agentId,
    directionId: proposal.id
  });

  console.log("");
  console.log("=== Demo Summary ===");
  console.log(`agent: ${agentId}`);
  console.log(`contract: ${contractAddress}`);
  console.log(`deployer: ${account.address}`);
  console.log(`active direction: ${activeDirection.proposal.slug}`);
  console.log(`proposal id: ${proposal.id}`);
  console.log(`run state cid: ${runState.stateCid}`);
  console.log(`run updates: ${runUpdates.updates.length}`);
  if (autoresearch) {
    console.log(`autoresearch run: ${autoresearch.runId}`);
    console.log(`autoresearch output: ${autoresearch.outputDir}`);
  }
  console.log("🎯 Demo complete");
  console.log("");
  console.log(JSON.stringify({
    sent,
    receipts,
    autoresearch,
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

async function maybeRunAutoresearch({ walletClient, publicClient, contractAddress, agentId, directionId }) {
  if (process.env.RUN_AUTORESEARCH === "false") {
    return null;
  }

  const inputPath = path.join(WORKSPACE_DIR, "experiments/integration/fixtures/runtime-input.json");
  const outputDir = path.join(WORKSPACE_DIR, "demo-autoresearch-output");
  const integrationDir = path.join(WORKSPACE_DIR, "experiments/integration");

  console.log("");
  console.log("=== Autoresearch ===");
  console.log("🚀 Launching the community-selected research run...");
  console.log(`📄 Input: ${path.relative(WORKSPACE_DIR, inputPath)}`);
  console.log(`📂 Output: ${path.relative(WORKSPACE_DIR, outputDir)}`);
  console.log(JSON.stringify({
    runtimeInput: {
      path: path.relative(WORKSPACE_DIR, inputPath)
    },
    runtimeOutput: {
      path: path.relative(WORKSPACE_DIR, outputDir)
    }
  }, null, 2));
  console.log("🧠 The runner will resolve the active direction, execute autoresearch, and write run-final.json + run-events.json.");

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const child = spawn("node", ["src/cli.js", inputPath, "--execute", "--output", outputDir], {
    cwd: integrationDir,
    env: {
      ...process.env,
      DEMO_WAIT_SECONDS: process.env.DEMO_WAIT_SECONDS ?? "3",
      AUTORESEARCH_EVAL_TOKENS: process.env.AUTORESEARCH_EVAL_TOKENS ?? "2048",
      AUTORESEARCH_PROGRESS_INTERVAL_SECONDS: process.env.AUTORESEARCH_PROGRESS_INTERVAL_SECONDS ?? "2"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (code !== 0) {
    throw new Error(`Autoresearch execution failed with code ${code}: ${stderr || stdout}`);
  }

  await commitAutoresearchProgress({
    walletClient,
    publicClient,
    contractAddress,
    agentId,
    directionId,
    eventsPath: path.join(outputDir, "runtime", "run-events.jsonl")
  });

  const logPath = path.join(outputDir, "runtime", "run.log");
  const eventsPath = path.join(outputDir, "runtime", "run-events.jsonl");
  const finalPath = path.join(outputDir, "runtime", "run-final.json");
  const summary = JSON.parse(await fs.readFile(path.join(outputDir, "summary.json"), "utf8"));
  const eventsText = await fs.readFile(eventsPath, "utf8").catch(() => "");
  const finalText = await fs.readFile(finalPath, "utf8").catch(() => "");

  console.log("📊 Autoresearch finished successfully");
  console.log(JSON.stringify({
    logs: {
      runtimeLog: path.relative(WORKSPACE_DIR, logPath),
      events: path.relative(WORKSPACE_DIR, eventsPath),
      final: path.relative(WORKSPACE_DIR, finalPath)
    }
  }, null, 2));
    console.log(`📈 Measured metric: ${summary.measuredMetric ?? "n/a"}`);
  console.log(`🧩 Active direction: ${summary.activeDirectionSlug}`);
  console.log(`📦 Event lines: ${eventsText.split(/\r?\n/).filter(Boolean).length}`);
  console.log(`🧷 Final record bytes: ${finalText.length}`);

  return {
    runId: summary.runId,
    outputDir,
    activeDirectionSlug: summary.activeDirectionSlug,
    measuredMetric: summary.measuredMetric ?? null
  };
}

async function maybeUploadToFilecoin() {
  if (process.env.FILECOIN_UPLOAD === "false") {
    return null;
  }

  const filecoinDir = path.join(WORKSPACE_DIR, "experiments/filecoin");
  const envPath = path.join(filecoinDir, ".env");
  const privateKey = process.env.PRIVATE_KEY;
  const outputDir = path.join(filecoinDir, "output");
  if (!privateKey) {
    return null;
  }

  console.log("");
  console.log("=== Filecoin Upload ===");
  console.log("📤 Uploading demo artifacts to Filecoin/IPFS...");
  console.log(JSON.stringify({
    filecoin: {
      network: process.env.NETWORK ?? "calibration",
      outputDir: path.relative(WORKSPACE_DIR, outputDir)
    }
  }, null, 2));

  const minLockup = Number(process.env.FILECOIN_MIN_LOCKUP_USDFC ?? 0.16);
  const preflight = await runFilecoinPreflight({
    cwd: filecoinDir,
    privateKey: normalizePrivateKey(privateKey),
    network: process.env.NETWORK ?? "calibration"
  });

  console.log(JSON.stringify({
    filecoinPreflight: {
      walletAddress: preflight.walletAddress,
      usdfcAvailable: preflight.usdfcAvailable,
      minLockup
    }
  }, null, 2));

  return runFilecoinUpload({
    cwd: filecoinDir,
    envPath,
    outputDir,
    envOverride: {
      PRIVATE_KEY: normalizePrivateKey(privateKey)
    }
  }).catch((error) => {
    const failureText = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`;
    const lockupMatch = failureText.match(/InsufficientLockupFunds\(address payer, uint256 minimumRequired, uint256 available\)\s*\(([^,]+),\s*([0-9]+),\s*([0-9]+)\)/i);
    const hint = lockupMatch
      ? `Need more lockup funds: minimum=${lockupMatch[2]}, available=${lockupMatch[3]}`
      : /USDFC/i.test(failureText)
      ? "Calibration wallet needs test USDFC to use filecoin-pin upload"
      : /FIL balance|gas fees/i.test(failureText)
        ? "Calibration wallet needs FIL balance for filecoin-pin upload"
        : "Check the Calibration wallet balance and payment status";
    console.log("⚠️ Filecoin upload skipped");
    console.log(JSON.stringify({
      error: error.message,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      hint
    }, null, 2));
    return null;
  });
}

async function commitAutoresearchProgress({ walletClient, publicClient, contractAddress, agentId, directionId, eventsPath }) {
  if (process.env.SUBMIT_PROGRESS_ONCHAIN === "false") {
    console.log("⏭️  Progress commit disabled by SUBMIT_PROGRESS_ONCHAIN=false");
    return;
  }

  const text = await fs.readFile(eventsPath, "utf8").catch(() => "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const seen = new Set();
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.event !== "run_progress" && event.event !== "run_eval") {
      continue;
    }
    const key = `${event.event}:${event.step ?? "na"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const payload = {
      schema: "plgenesis/run-progress-anchor@v1",
      agentId,
      directionId,
      event
    };
    const progressJson = stableJson(payload);
    const progressDigest = `0x${crypto.createHash("sha256").update(progressJson).digest("hex")}`;
    const progressCid = `urn:sha256:${progressDigest.slice(2)}`;

    console.log(`📡 Committing progress on-chain: ${event.event} step ${event.step ?? "n/a"}`);
    const hash = await send(
      "submitResearchProgress",
      [agentId, directionId, Number(event.step ?? 0), progressCid, progressDigest],
      walletClient,
      contractAddress
    );
    printStep("submitResearchProgress", hash, [agentId, directionId, Number(event.step ?? 0), progressCid, progressDigest]);
    const receipt = await waitForReceipt(publicClient, hash, Number(process.env.DEMO_WAIT_SECONDS ?? 3));
    console.log(`⛓️ Confirmed: submitResearchProgress (${receipt.status})`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
