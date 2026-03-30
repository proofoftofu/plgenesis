import { stableStringify } from "../../../filecoin/src/lib/stable-json.js";
import { prepareExperiment } from "../../../filecoin/src/lib/payload.js";

const AUTORESEARCH_METRICS = {
  val_bpb: Number,
  training_seconds: Number,
  total_seconds: Number,
  peak_vram_mb: Number,
  mfu_percent: Number,
  total_tokens_M: Number,
  num_steps: Number,
  num_params_M: Number,
  depth: Number
};

export function createIntegrationWorkflow(rawInput, options = {}) {
  const runArtifacts = options.runArtifacts
    ? normalizeRuntimeArtifacts(options.runArtifacts)
    : null;
  const workflowInput = runArtifacts ? applyRuntimeArtifacts(rawInput, runArtifacts) : rawInput;
  const filecoin = prepareExperiment(workflowInput);
  const activeDirection = resolveActiveDirection(filecoin.governancePlan.proposals, filecoin.summary);
  const executionPlan = buildExecutionPlan({
    input: workflowInput,
    filecoin,
    activeDirection
  });

  let runRecord = null;
  if (runArtifacts) {
    runRecord = buildRunRecordFromFinal({
      executionPlan,
      finalRecord: runArtifacts.finalRecord
    });
  } else if (options.logText) {
    const metrics = parseAutoresearchLog(options.logText);
    runRecord = buildRunRecord({
      input: workflowInput,
      executionPlan,
      metrics,
      logPath: options.logPath ?? "workspace/experiments/autoresearch/run.log"
    });
  }

  const workflowState = buildWorkflowState({
    input: workflowInput,
    filecoin,
    activeDirection,
    executionPlan,
    runRecord,
    runArtifacts
  });

  return {
    input: workflowInput,
    filecoin,
    activeDirection,
    executionPlan,
    runRecord,
    runArtifacts,
    workflowState,
    files: {
      "filecoin/metadata.json": `${filecoin.files["metadata.json"]}\n`,
      "filecoin/proposals.json": `${filecoin.files["proposals.json"]}\n`,
      "filecoin/governance-tally.json": `${filecoin.files["governance-tally.json"]}\n`,
      "filecoin/active-direction.json": `${filecoin.files["active-direction.json"]}\n`,
      "filecoin/run-updates.json": `${filecoin.files["run-updates.json"]}\n`,
      "filecoin/dashboard-state.json": `${filecoin.files["dashboard-state.json"]}\n`,
      "filecoin/state.json": `${filecoin.files["state.json"]}\n`,
      "filecoin/summary.json": `${JSON.stringify(filecoin.summary, null, 2)}\n`,
      "integration/execution-plan.json": `${stableStringify(executionPlan)}\n`,
      "integration/workflow-state.json": `${stableStringify(workflowState)}\n`,
      ...(runArtifacts
        ? {
            "integration/run-events.json": `${stableStringify(runArtifacts.events)}\n`,
            "integration/run-final.json": `${stableStringify(runArtifacts.finalRecord)}\n`
          }
        : {}),
      ...(runRecord
        ? {
            "integration/run-record.json": `${stableStringify(runRecord)}\n`
          }
        : {})
    },
    summary: {
      runId: workflowInput.runId,
      activeDirectionSlug: filecoin.summary.activeDirectionSlug,
      compatibilityStatus: executionPlan.compatibility.status,
      blockingIssues: executionPlan.compatibility.issues,
      readyToRun: executionPlan.status === "ready",
      logIngested: Boolean(runRecord),
      objectiveMetric: workflowInput.autoresearch.objective.metric,
      measuredMetric: runRecord?.metrics?.val_bpb ?? null,
      filecoinAnchorReady: Boolean(runRecord),
      dashboardStateCid: filecoin.summary.dashboardStateCid ?? null,
      runtimeArtifactsIngested: Boolean(runArtifacts),
      uploadStatus: "pending_filecoin_upload"
    }
  };
}

export function normalizeRuntimeArtifacts(payload) {
  if (Array.isArray(payload?.events) && payload?.finalRecord) {
    return payload;
  }

  const { eventsText, finalText, eventsPath, finalPath } = payload;
  const events = parseRunEvents(eventsText);
  const finalRecord = JSON.parse(finalText);
  return {
    events,
    finalRecord,
    eventsPath: eventsPath ?? finalRecord.artifact_paths?.run_events_path ?? null,
    finalPath: finalPath ?? finalRecord.artifact_paths?.run_final_path ?? null
  };
}

export function parseAutoresearchLog(logText) {
  const metrics = {};
  for (const rawLine of logText.split(/\r?\n/)) {
    if (!rawLine.includes(":")) {
      continue;
    }
    const [rawKey, ...rawValueParts] = rawLine.split(":");
    const key = rawKey.trim();
    if (!(key in AUTORESEARCH_METRICS)) {
      continue;
    }
    const value = rawValueParts.join(":").trim();
    if (!value) {
      continue;
    }
    metrics[key] = AUTORESEARCH_METRICS[key](value);
  }
  return metrics;
}

export function parseRunEvents(eventsText) {
  return eventsText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function resolveActiveDirection(proposals, summary) {
  const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  const active = proposalById.get(summary.activeDirectionId);
  if (!active) {
    throw new Error(`Active direction ${summary.activeDirectionId} missing`);
  }

  const lineage = [];
  let cursor = active;
  while (cursor) {
    lineage.unshift(cursor);
    cursor = cursor.parentId ? proposalById.get(cursor.parentId) : null;
  }

  const resolved = {
    objectiveMetadata: {},
    runtimeKnobs: {},
    architecture: {},
    hyperparameters: {},
    programDirectives: [],
    directionKind: active.directionKind ?? null,
    mode: active.mode ?? null,
    branchStrategy: active.branchStrategy ?? null,
    branchTarget: active.branchTarget ?? null
  };

  for (const proposal of lineage) {
    if (proposal.objectiveMetadata) {
      Object.assign(resolved.objectiveMetadata, proposal.objectiveMetadata);
    }
    if (proposal.objectiveMetadataDelta) {
      Object.assign(resolved.objectiveMetadata, proposal.objectiveMetadataDelta);
    }
    if (proposal.runtimeKnobs) {
      Object.assign(resolved.runtimeKnobs, proposal.runtimeKnobs);
    }
    if (proposal.runtimeKnobsDelta) {
      Object.assign(resolved.runtimeKnobs, proposal.runtimeKnobsDelta);
    }
    if (proposal.architecture) {
      Object.assign(resolved.architecture, proposal.architecture);
    }
    if (proposal.architectureDelta) {
      Object.assign(resolved.architecture, proposal.architectureDelta);
    }
    if (proposal.hyperparameters) {
      Object.assign(resolved.hyperparameters, proposal.hyperparameters);
    }
    if (proposal.hyperparameterDelta) {
      Object.assign(resolved.hyperparameters, proposal.hyperparameterDelta);
    }
    resolved.directionKind = proposal.directionKind ?? resolved.directionKind;
    resolved.mode = proposal.mode ?? resolved.mode;
    resolved.branchStrategy = proposal.branchStrategy ?? resolved.branchStrategy;
    resolved.branchTarget = proposal.branchTarget ?? resolved.branchTarget;
    resolved.programDirectives.push(...proposal.programDirectives);
  }

  return {
    lineage,
    activeProposal: active,
    resolved
  };
}

export function buildExecutionPlan({ input, filecoin, activeDirection }) {
  const compatibility = assessAutoresearchCompatibility(activeDirection.resolved, input.autoresearch);
  const env = compatibility.status === "ready"
    ? buildAutoresearchEnv(activeDirection.resolved, input.autoresearch.objective.timeBudgetSeconds)
    : null;

  return {
    schema: "plgenesis/integration-execution-plan@v1",
    status: compatibility.status === "ready" ? "ready" : "blocked",
    runId: input.runId,
    agentId: filecoin.agentId,
    activeDirection: {
      id: activeDirection.activeProposal.id,
      slug: activeDirection.activeProposal.slug,
      stage: activeDirection.activeProposal.stage,
      directionKind: activeDirection.resolved.directionKind,
      mode: activeDirection.resolved.mode,
      branchStrategy: activeDirection.resolved.branchStrategy,
      branchTarget: activeDirection.resolved.branchTarget,
      lineage: activeDirection.lineage.map((proposal) => ({
        id: proposal.id,
        slug: proposal.slug,
        stage: proposal.stage
      }))
    },
    compatibility,
    autoresearch: {
      repoPath: "workspace/experiments/autoresearch",
      logPath: "workspace/experiments/autoresearch/run.log",
      parserPath: "workspace/experiments/autoresearch/parse_run_log.py",
      eventLogPath: "workspace/experiments/autoresearch/run-events.jsonl",
      finalRecordPath: "workspace/experiments/autoresearch/run-final.json",
      objective: input.autoresearch.objective,
      objectiveMetadata: activeDirection.resolved.objectiveMetadata,
      runtimeKnobs: activeDirection.resolved.runtimeKnobs,
      controlledFiles: input.autoresearch.controlledFiles,
      programDirectives: activeDirection.resolved.programDirectives,
      env,
      command:
        env === null
          ? null
          : buildRunCommand(env)
    }
  };
}

export function assessAutoresearchCompatibility(resolvedDirection, autoresearch) {
  const issues = [];
  const architecture = resolvedDirection.architecture;
  const hyperparameters = resolvedDirection.hyperparameters;
  const runtimeKnobs = resolvedDirection.runtimeKnobs;
  const requiredArchitectureKeys = ["n_layer", "n_head", "n_kv_head", "n_embd", "window_pattern"];

  for (const key of requiredArchitectureKeys) {
    if (architecture[key] === undefined || architecture[key] === null) {
      issues.push(`Missing architecture field: ${key}`);
    }
  }

  if (issues.length === 0) {
    if (architecture.n_embd % architecture.n_head !== 0) {
      issues.push("n_embd must be divisible by n_head for the current autoresearch model.");
    }
    if (architecture.n_embd % architecture.n_layer !== 0) {
      issues.push("n_embd must be divisible by n_layer to map exactly into AUTORESEARCH_ASPECT_RATIO.");
    }
    if (architecture.n_kv_head !== architecture.n_head) {
      issues.push("Current autoresearch env controls assume n_kv_head equals n_head.");
    }
    if (/[^SL]/.test(String(architecture.window_pattern).toUpperCase())) {
      issues.push("window_pattern may only contain S or L for the current autoresearch fork.");
    }
  }

  const requiredHyperparameters = ["embedding_lr", "matrix_lr", "unembedding_lr", "scalar_lr"];
  for (const key of requiredHyperparameters) {
    if (hyperparameters[key] === undefined || hyperparameters[key] === null) {
      issues.push(`Missing hyperparameter field: ${key}`);
    }
  }

  if (!(autoresearch?.objective?.timeBudgetSeconds > 0)) {
    issues.push("autoresearch.objective.timeBudgetSeconds must be set.");
  }
  if (runtimeKnobs.batchSize !== undefined && !(runtimeKnobs.batchSize > 0)) {
    issues.push("runtimeKnobs.batchSize must be greater than zero.");
  }
  if (
    runtimeKnobs.timeBudgetSeconds !== undefined &&
    !(runtimeKnobs.timeBudgetSeconds > 0)
  ) {
    issues.push("runtimeKnobs.timeBudgetSeconds must be greater than zero.");
  }

  return {
    status: issues.length === 0 ? "ready" : "blocked",
    issues,
    supportedControls: [
      "AUTORESEARCH_DEPTH",
      "AUTORESEARCH_ASPECT_RATIO",
      "AUTORESEARCH_HEAD_DIM",
      "AUTORESEARCH_WINDOW_PATTERN",
      "AUTORESEARCH_EMBEDDING_LR",
      "AUTORESEARCH_MATRIX_LR",
      "AUTORESEARCH_UNEMBEDDING_LR",
      "AUTORESEARCH_SCALAR_LR",
      "AUTORESEARCH_TIME_BUDGET"
    ],
    unsupportedControls: [
      "arbitrary train.py code patches",
      "n_kv_head different from n_head",
      "architectures that cannot be represented by integer aspect ratio and head dimension"
    ]
  };
}

export function buildAutoresearchEnv(resolvedDirection, timeBudgetSeconds) {
  const architecture = resolvedDirection.architecture;
  const hyperparameters = resolvedDirection.hyperparameters;
  const runtimeKnobs = resolvedDirection.runtimeKnobs;
  const budget = runtimeKnobs.timeBudgetSeconds ?? timeBudgetSeconds;

  return {
    AUTORESEARCH_TIME_BUDGET: budget,
    AUTORESEARCH_DEPTH: architecture.n_layer,
    AUTORESEARCH_ASPECT_RATIO: architecture.n_embd / architecture.n_layer,
    AUTORESEARCH_HEAD_DIM: architecture.n_embd / architecture.n_head,
    AUTORESEARCH_WINDOW_PATTERN: architecture.window_pattern,
    ...(runtimeKnobs.batchSize !== undefined
      ? {
          AUTORESEARCH_DEVICE_BATCH_SIZE: runtimeKnobs.batchSize
        }
      : {}),
    AUTORESEARCH_EMBEDDING_LR: hyperparameters.embedding_lr,
    AUTORESEARCH_MATRIX_LR: hyperparameters.matrix_lr,
    AUTORESEARCH_UNEMBEDDING_LR: hyperparameters.unembedding_lr,
    AUTORESEARCH_SCALAR_LR: hyperparameters.scalar_lr
  };
}

export function buildRunRecord({ input, executionPlan, metrics, logPath }) {
  return {
    schema: "plgenesis/autoresearch-run@v1",
    runId: input.runId,
    directionId: executionPlan.activeDirection.id,
    directionSlug: executionPlan.activeDirection.slug,
    status: executionPlan.status === "ready" ? "completed" : "blocked",
    scheduledRunId: input.runSimulation?.scheduledRunId ?? null,
    branchSelected: executionPlan.activeDirection.branchTarget,
    modeSelected: executionPlan.activeDirection.mode,
    objective: input.autoresearch.objective,
    objectiveMetadata: executionPlan.autoresearch.objectiveMetadata,
    runtimeKnobs: executionPlan.autoresearch.runtimeKnobs,
    metrics,
    artifacts: {
      logPath
    }
  };
}

export function buildRunRecordFromFinal({ executionPlan, finalRecord }) {
  return {
    schema: "plgenesis/autoresearch-run@v2",
    runId: finalRecord.run_id,
    directionId: executionPlan.activeDirection.id,
    directionSlug: executionPlan.activeDirection.slug,
    status: finalRecord.status,
    scheduledRunId: finalRecord.scheduled_run_id,
    branchSelected: finalRecord.branch_target,
    modeSelected: finalRecord.mode,
    objective: executionPlan.autoresearch.objective,
    objectiveMetadata: executionPlan.autoresearch.objectiveMetadata,
    runtimeKnobs: executionPlan.autoresearch.runtimeKnobs,
    controls: finalRecord.controls,
    metrics: finalRecord.metrics,
    artifacts: {
      runEventsPath: finalRecord.artifact_paths?.run_events_path ?? null,
      runFinalPath: finalRecord.artifact_paths?.run_final_path ?? null
    },
    timestamps: finalRecord.timestamps
  };
}

function buildWorkflowState({
  input,
  filecoin,
  activeDirection,
  executionPlan,
  runRecord,
  runArtifacts
}) {
  return {
    schema: "plgenesis/integration-workflow-state@v1",
    runId: input.runId,
    agentId: filecoin.agentId,
    community: {
      governance: input.steering.governance,
      explorationBudget: input.steering.explorationBudget ?? null,
      activeDirection: {
        id: activeDirection.activeProposal.id,
        slug: activeDirection.activeProposal.slug,
        stage: activeDirection.activeProposal.stage
      }
    },
    resolvedDirection: activeDirection.resolved,
    executionPlan,
    runRecord,
    runArtifacts,
    filecoin: {
      metadataCid: filecoin.summary.metadataCid,
      activeDirectionCid: filecoin.summary.activeDirectionCid,
      latestStateCid: filecoin.summary.latestStateCid,
      dashboardStateCid: filecoin.summary.dashboardStateCid ?? null,
      runUpdateSetCid: filecoin.summary.runUpdateSetCid ?? null
    }
  };
}

function buildRunCommand(env) {
  const pairs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  return [
    "cd workspace/experiments/autoresearch",
    ...pairs,
    "uv run train.py > run.log 2>&1",
    "uv run python parse_run_log.py run.log"
  ].join(" \\\n");
}

function applyRuntimeArtifacts(rawInput, runArtifacts) {
  const finalRecord = runArtifacts.finalRecord;
  const snapshots = runArtifacts.events.map((event) => ({
    event: event.event,
    timestamp: event.timestamp,
    step: event.step,
    status: event.status,
    message: event.message,
    ...flattenMetrics(event.metrics)
  }));

  return {
    ...rawInput,
    runId: finalRecord.run_id,
    runSimulation: {
      branchSelected: finalRecord.branch_target,
      modeSelected: finalRecord.mode,
      scheduledRunId: finalRecord.scheduled_run_id,
      status: finalRecord.status,
      latestMetrics: buildLatestMetrics(finalRecord.metrics),
      snapshots
    }
  };
}

function buildLatestMetrics(metrics) {
  return {
    val_bpb: metrics.val_bpb ?? null,
    training_seconds: metrics.training_seconds ?? null,
    peak_vram_mb: metrics.peak_vram_mb ?? null,
    num_steps: metrics.num_steps ?? null
  };
}

function flattenMetrics(metrics = {}) {
  return Object.fromEntries(Object.entries(metrics));
}
