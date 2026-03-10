import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildAutoresearchEnv,
  createIntegrationWorkflow,
  normalizeRuntimeArtifacts
} from "./lib/workflow.js";

async function main() {
  const inputPath = process.argv[2];
  const args = process.argv.slice(3);

  if (!inputPath) {
    throw new Error("Usage: node src/cli.js <input.json> [run.log] [outputDir] [--events path --final path] [--execute]");
  }

  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const options = parseArgs(args);
  let runtimeArtifacts = null;
  let logText = null;

  if (options.eventsPath && options.finalPath) {
    runtimeArtifacts = normalizeRuntimeArtifacts({
      eventsText: await readFile(options.eventsPath, "utf8"),
      finalText: await readFile(options.finalPath, "utf8"),
      eventsPath: options.eventsPath,
      finalPath: options.finalPath
    });
  } else if (options.execute) {
    const preview = createIntegrationWorkflow(input);
    if (preview.executionPlan.status !== "ready") {
      throw new Error(`Execution blocked: ${preview.executionPlan.compatibility.issues.join("; ")}`);
    }
    runtimeArtifacts = await executeAutoresearchRun({
      input,
      executionPlan: preview.executionPlan,
      outputDir: options.outputDir
    });
  } else if (options.logPath) {
    logText = await readFile(options.logPath, "utf8");
  }

  const workflow = createIntegrationWorkflow(input, {
    logText,
    logPath: options.logPath,
    runArtifacts: runtimeArtifacts
  });

  await mkdir(options.outputDir, { recursive: true });

  for (const [relativePath, contents] of Object.entries(workflow.files)) {
    const target = path.join(options.outputDir, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  await writeFile(
    path.join(options.outputDir, "summary.json"),
    `${JSON.stringify(workflow.summary, null, 2)}\n`
  );

  process.stdout.write(`${JSON.stringify(workflow.summary, null, 2)}\n`);
}

function parseArgs(args) {
  let logPath = null;
  let outputDir = "output";
  let eventsPath = null;
  let finalPath = null;
  let execute = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--events") {
      eventsPath = args[++i];
      continue;
    }
    if (arg === "--final") {
      finalPath = args[++i];
      continue;
    }
    if (arg === "--output") {
      outputDir = args[++i];
      continue;
    }
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (!logPath) {
      logPath = arg;
      continue;
    }
    outputDir = arg;
  }

  return {
    logPath,
    outputDir,
    eventsPath,
    finalPath,
    execute
  };
}

async function executeAutoresearchRun({ input, executionPlan, outputDir }) {
  const autoresearchDir = path.resolve("..", "autoresearch");
  const runtimeDir = path.join(outputDir, "runtime");
  await mkdir(runtimeDir, { recursive: true });

  const env = {
    ...process.env,
    ...stringifyEnv({
      ...executionPlan.autoresearch.env,
      AUTORESEARCH_RUN_ID: input.runId,
      AUTORESEARCH_DIRECTION_ID: String(executionPlan.activeDirection.id),
      AUTORESEARCH_DIRECTION_SLUG: executionPlan.activeDirection.slug,
      AUTORESEARCH_SCHEDULED_RUN_ID: `${input.runId}-scheduled`,
      AUTORESEARCH_MODE: executionPlan.activeDirection.mode ?? "",
      AUTORESEARCH_BRANCH_TARGET: executionPlan.activeDirection.branchTarget ?? "",
      AUTORESEARCH_EVENT_LOG: path.join(runtimeDir, "run-events.jsonl"),
      AUTORESEARCH_FINAL_RECORD: path.join(runtimeDir, "run-final.json"),
      AUTORESEARCH_PROGRESS_INTERVAL_SECONDS: 5
    })
  };
  const logPath = path.join(runtimeDir, "run.log");

  await runCommand({
    cmd: "uv",
    args: ["run", "train.py"],
    cwd: autoresearchDir,
    env,
    stdoutPath: logPath
  });

  return normalizeRuntimeArtifacts({
    eventsText: await readFile(env.AUTORESEARCH_EVENT_LOG, "utf8"),
    finalText: await readFile(env.AUTORESEARCH_FINAL_RECORD, "utf8"),
    eventsPath: env.AUTORESEARCH_EVENT_LOG,
    finalPath: env.AUTORESEARCH_FINAL_RECORD
  });
}

function stringifyEnv(values) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

function runCommand({ cmd, args, cwd, env, stdoutPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      await writeFile(stdoutPath, `${stdout}${stderr}`);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
    });
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
