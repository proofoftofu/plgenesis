import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createIntegrationWorkflow,
  normalizeRuntimeArtifacts,
  parseAutoresearchLog
} from "../src/lib/workflow.js";

const WORKFLOW_FIXTURE_URL = new URL("../fixtures/workflow-input.json", import.meta.url);
const RUN_LOG_URL = new URL("../fixtures/sample-run.log", import.meta.url);
const FILECOIN_FIXTURE_URL = new URL("../../filecoin/fixtures/research-input.json", import.meta.url);
const EXAMPLE_RUN_EVENTS_URL = new URL("../../autoresearch/example-run-events.jsonl", import.meta.url);
const EXAMPLE_RUN_FINAL_URL = new URL("../../autoresearch/example-run-final.json", import.meta.url);

test("integration workflow resolves a voted direction into an autoresearch execution plan", async () => {
  const input = JSON.parse(await readFile(WORKFLOW_FIXTURE_URL, "utf8"));
  const logText = await readFile(RUN_LOG_URL, "utf8");
  const workflow = createIntegrationWorkflow(input, { logText, logPath: "fixtures/sample-run.log" });

  assert.equal(workflow.summary.readyToRun, true);
  assert.equal(workflow.summary.logIngested, true);
  assert.equal(workflow.executionPlan.activeDirection.slug, "tune-extend-short-window");
  assert.equal(workflow.executionPlan.activeDirection.mode, "explore");
  assert.equal(
    workflow.executionPlan.activeDirection.branchStrategy,
    "diverge-from-parent"
  );
  assert.deepEqual(workflow.executionPlan.activeDirection.lineage, [
    { id: 1, slug: "bootstrap-compact-gpt", stage: "bootstrap" },
    { id: 3, slug: "tune-extend-short-window", stage: "tuning" }
  ]);
  assert.equal(workflow.executionPlan.autoresearch.runtimeKnobs.batchSize, 4);
  assert.equal(
    workflow.executionPlan.autoresearch.objectiveMetadata.goalLabel,
    "context-pattern-challenger"
  );
  assert.equal(workflow.executionPlan.autoresearch.env.AUTORESEARCH_DEPTH, 10);
  assert.equal(workflow.executionPlan.autoresearch.env.AUTORESEARCH_ASPECT_RATIO, 64);
  assert.equal(workflow.executionPlan.autoresearch.env.AUTORESEARCH_HEAD_DIM, 128);
  assert.equal(workflow.executionPlan.autoresearch.env.AUTORESEARCH_WINDOW_PATTERN, "SSLL");
  assert.equal(workflow.executionPlan.autoresearch.env.AUTORESEARCH_DEVICE_BATCH_SIZE, 4);
  assert.equal(workflow.executionPlan.autoresearch.env.AUTORESEARCH_MATRIX_LR, 0.018);
  assert.equal(workflow.runRecord.metrics.val_bpb, 2.184321);
  assert.equal(workflow.summary.filecoinAnchorReady, true);
  assert.ok(workflow.summary.dashboardStateCid);
  assert.match(workflow.files["filecoin/summary.json"], /tune-extend-short-window/);
  assert.match(workflow.files["filecoin/run-updates.json"], /run-update-set/);
  assert.match(workflow.files["filecoin/dashboard-state.json"], /dashboard-state/);
  assert.match(workflow.files["integration/execution-plan.json"], /AUTORESEARCH_WINDOW_PATTERN/);
});

test("integration respects the updated filecoin fixture and excludes future-only proposals from the active direction", async () => {
  const input = JSON.parse(await readFile(FILECOIN_FIXTURE_URL, "utf8"));
  const workflow = createIntegrationWorkflow(input);

  assert.equal(workflow.summary.readyToRun, true);
  assert.equal(workflow.executionPlan.status, "ready");
  assert.equal(workflow.executionPlan.activeDirection.slug, "tune-extend-short-window");
  assert.equal(workflow.activeDirection.activeProposal.executionCompatibility, "current-autoresearch");
});

test("integration can ingest real autoresearch runtime artifacts and fold them into the filecoin workflow", async () => {
  const input = JSON.parse(await readFile(FILECOIN_FIXTURE_URL, "utf8"));
  const runtimeArtifacts = normalizeRuntimeArtifacts({
    eventsText: await readFile(EXAMPLE_RUN_EVENTS_URL, "utf8"),
    finalText: await readFile(EXAMPLE_RUN_FINAL_URL, "utf8"),
    eventsPath: "workspace/experiments/autoresearch/example-run-events.jsonl",
    finalPath: "workspace/experiments/autoresearch/example-run-final.json"
  });
  const workflow = createIntegrationWorkflow(input, { runArtifacts: runtimeArtifacts });

  assert.equal(workflow.summary.runtimeArtifactsIngested, true);
  assert.equal(workflow.summary.logIngested, true);
  assert.equal(workflow.summary.runId, "run_demo_001");
  assert.equal(workflow.runRecord.status, "finished");
  assert.equal(workflow.runRecord.scheduledRunId, "sched_demo_001");
  assert.equal(workflow.runRecord.metrics.val_bpb, 2.275344);
  assert.equal(workflow.runArtifacts.events.length, 6);
  assert.equal(workflow.input.runSimulation.snapshots[0].event, "run_start");
  assert.match(workflow.files["integration/run-events.json"], /run_progress/);
  assert.match(workflow.files["integration/run-final.json"], /run_demo_001/);
  assert.match(workflow.files["filecoin/run-updates.json"], /run_start/);
});

test("parseAutoresearchLog extracts the metric summary block", async () => {
  const logText = await readFile(RUN_LOG_URL, "utf8");
  const metrics = parseAutoresearchLog(logText);

  assert.deepEqual(metrics, {
    val_bpb: 2.184321,
    training_seconds: 300,
    total_seconds: 322.4,
    peak_vram_mb: 0,
    mfu_percent: 0,
    total_tokens_M: 45.7,
    num_steps: 904,
    num_params_M: 7.9,
    depth: 10
  });
});
