import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const WORKSPACE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.join(WORKSPACE_DIR, "experiments/filecoin/contracts/ResearchRegistry.sol");

async function main() {
  const rpcUrl = process.env.RPC_URL ?? process.env.RPC;
  const privateKey = process.env.PRIVATE_KEY;
  if (!rpcUrl || !privateKey) {
    throw new Error("Set RPC_URL or RPC, and PRIVATE_KEY in workspace/experiments/filecoin/.env first.");
  }

  const source = await fs.readFile(CONTRACT_PATH, "utf8");
  const { abi, bytecode } = compile(source);
  const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  const chain = defineChain({
    id: Number(process.env.CHAIN_ID ?? 314159),
    name: process.env.CHAIN_NAME ?? "Filecoin Calibration",
    nativeCurrency: { name: "tFIL", symbol: "tFIL", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });

  const hash = await walletClient.deployContract({ abi, bytecode });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.log(JSON.stringify({
    contract: "ResearchRegistry",
    deployer: account.address,
    hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber?.toString(),
    contractAddress: receipt.contractAddress
  }, null, 2));
}

function compile(source) {
  const input = {
    language: "Solidity",
    sources: {
      "ResearchRegistry.sol": { content: source }
    },
    settings: {
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"]
        }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = output.errors ?? [];
  const fatal = errors.filter((error) => error.severity === "error");
  if (fatal.length) {
    throw new Error(fatal.map((error) => error.formattedMessage).join("\n"));
  }

  const contract = output.contracts["ResearchRegistry.sol"].ResearchRegistry;
  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`
  };
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
