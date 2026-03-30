import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_NETWORK = "calibration";

export async function runFilecoinUpload({
  cwd,
  envPath = path.join(cwd, ".env"),
  outputDir = path.join(cwd, "output"),
  envOverride = {}
}) {
  const envFile = await readEnvFile(envPath);
  const privateKey = normalizePrivateKey(
    envOverride.PRIVATE_KEY ?? envFile.PRIVATE_KEY ?? process.env.PRIVATE_KEY
  );
  const network = envOverride.NETWORK ?? envFile.NETWORK ?? process.env.NETWORK ?? DEFAULT_NETWORK;
  const targets = buildUploadTargets(outputDir);

  const preflight = await runFilecoinPreflight({
    cwd,
    privateKey,
    network
  });

  if (envOverride.SETUP_PAYMENTS !== false && process.env.FILECOIN_SETUP_PAYMENTS !== "false") {
    await runFilecoinPaymentSetup({
      cwd,
      privateKey,
      network
    });
  }

  const manifest = {
    network,
    walletAddress: null,
    preflight,
    status: "started",
    attempts: [],
    errors: []
  };

  manifest.walletAddress = preflight.walletAddress;
  for (const target of targets) {
    try {
      const result = await runCli(
        cwd,
        [
          "add",
          target.path,
          "--auto-fund",
          "--network",
          network,
          "--metadata",
          `app=plgenesis`,
          "--metadata",
          `artifact=${target.artifact}`
        ],
        privateKey,
        network
      );

      manifest.attempts.push({
        file: target.file,
        artifact: target.artifact,
        status: "uploaded",
        rootCid: parseRootCid(result.stdout),
        stdout: result.stdout.trim()
      });
    } catch (error) {
      manifest.status = classifyFailure(error);
      manifest.attempts.push({
        file: target.file,
        artifact: target.artifact,
        status: "failed",
        rootCid: parseRootCid(error.stdout ?? ""),
        error: cleanError(error)
      });
      manifest.errors.push(cleanError(error));
      await writeManifest(outputDir, manifest);
      throw error;
    }
  }

  manifest.status = "uploaded";
  await writeManifest(outputDir, manifest);
  return manifest;
}

export function normalizePrivateKey(value) {
  if (!value) {
    throw new Error("PRIVATE_KEY is required");
  }

  return value.startsWith("0x") ? value : `0x${value}`;
}

export function buildUploadTargets(outputDir) {
  return [
    uploadTarget(outputDir, "metadata.json", "agent-metadata"),
    uploadTarget(outputDir, "proposals.json", "direction-set"),
    uploadTarget(outputDir, "governance-tally.json", "governance-tally"),
    uploadTarget(outputDir, "active-direction.json", "active-direction"),
    uploadTarget(outputDir, "run-updates.json", "run-update-set"),
    uploadTarget(outputDir, "dashboard-state.json", "dashboard-state"),
    uploadTarget(outputDir, "artifact-manifest.json", "artifact-manifest"),
    uploadTarget(outputDir, "state.json", "research-state")
  ];
}

export function parseRootCid(output) {
  const match = output.match(/root CID:\s*([a-z0-9]+)/i);
  return match ? match[1] : null;
}

export function parseWalletAddress(output) {
  const match = output.match(/(?:Owner address|Address):\s*(0x[a-fA-F0-9]{40})/i);
  return match ? match[1] : null;
}

export function parsePaymentAvailability(output) {
  const match = output.match(/Available:\s*([0-9.]+)\s*USDFC/i);
  return match ? Number(match[1]) : null;
}

export async function runFilecoinPreflight({
  cwd,
  privateKey,
  network = DEFAULT_NETWORK
}) {
  const result = await runCli(
    cwd,
    ["payments", "status", "--network", network],
    privateKey,
    network
  );

  return {
    walletAddress: parseWalletAddress(result.stdout),
    usdfcAvailable: parsePaymentAvailability(result.stdout),
    stdout: result.stdout.trim()
  };
}

export async function runFilecoinPaymentSetup({
  cwd,
  privateKey,
  network = DEFAULT_NETWORK
}) {
  return runCli(
    cwd,
    ["payments", "setup", "--auto", "--network", network],
    privateKey,
    network
  );
}

export function classifyFailure(error) {
  const text = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`;
  if (/InsufficientLockupFunds/i.test(text)) {
    return "blocked_insufficient_lockup";
  }
  if (/Account has no FIL balance|Insufficient FIL for gas fees/i.test(text)) {
    return "blocked_no_fil";
  }
  if (/USDFC|allowance|deposit/i.test(text)) {
    return "blocked_no_usdfc";
  }
  return "failed";
}

async function readEnvFile(envPath) {
  let raw = "";
  try {
    raw = await readFile(envPath, "utf8");
  } catch {
    return {};
  }

  return raw.split(/\r?\n/).reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return acc;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      return acc;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    acc[key] = value;
    return acc;
  }, {});
}

async function writeManifest(outputDir, manifest) {
  await writeFile(
    path.join(outputDir, "filecoin-upload-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

function uploadTarget(outputDir, file, artifact) {
  return {
    file,
    artifact,
    path: path.join(outputDir, file)
  };
}

function runCli(cwd, args, privateKey, network) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["filecoin-pin", ...args], {
      cwd,
      env: {
        ...process.env,
        PRIVATE_KEY: privateKey,
        NETWORK: network
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const command = ["filecoin-pin", ...args].join(" ");

    console.log(`🔐 Running ${command}`);

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
    child.on("error", (error) => {
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        Object.assign(new Error(`filecoin-pin exited with code ${code}`), {
          code,
          stdout,
          stderr
        })
      );
    });
  });
}

function cleanError(error) {
  return {
    message: error.message,
    stdout: sanitize(error.stdout ?? ""),
    stderr: sanitize(error.stderr ?? "")
  };
}

function sanitize(value) {
  return value
    .replace(/0x[a-fA-F0-9]{64}/g, "[redacted-private-key-or-hash]")
    .trim();
}
