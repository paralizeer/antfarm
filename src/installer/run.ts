import crypto from "node:crypto";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { resolveWorkflowDir } from "./paths.js";
import { getDb, nextRunNumber } from "../db.js";
import { logger } from "../lib/logger.js";
import { ensureWorkflowCrons } from "./agent-cron.js";
import { emitEvent } from "./events.js";
import { resolveTemplate } from "./step-ops.js";

export interface DryRunResult {
  workflowId: string;
  workflowName: string;
  task: string;
  steps: DryRunStep[];
  context: Record<string, string>;
}

export interface DryRunStep {
  stepIndex: number;
  stepId: string;
  agentId: string;
  type: "single" | "loop";
  inputTemplate: string;
  resolvedInput: string;
  expects: string;
  status: string;
}

export async function dryRunWorkflow(params: {
  workflowId: string;
  taskTitle: string;
}): Promise<DryRunResult> {
  // 1. Validate workflow YAML
  const workflowDir = resolveWorkflowDir(params.workflowId);
  const workflow = await loadWorkflowSpec(workflowDir);

  // 2. Build execution context with placeholder values
  const placeholderContext: Record<string, string> = {
    task: params.taskTitle,
    run_id: "dry-run-00000000-0000-0000-0000-000000000000",
    run_number: "0",
    ...workflow.context,
  };

  // Add placeholder values for any workflow context variables not provided
  if (workflow.context) {
    for (const [key, value] of Object.entries(workflow.context)) {
      placeholderContext[key] = value;
    }
  }

  // 3. Resolve all step input templates
  const steps: DryRunStep[] = [];
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const agentId = workflow.id + "_" + step.agent;
    const stepType = step.type ?? "single";

    // Resolve the input template against our context
    const resolvedInput = resolveTemplate(step.input, placeholderContext);

    steps.push({
      stepIndex: i,
      stepId: step.id,
      agentId,
      type: stepType,
      inputTemplate: step.input,
      resolvedInput,
      expects: step.expects,
      status: i === 0 ? "pending" : "waiting",
    });
  }

  // 4. Print execution plan
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("                    DRY-RUN EXECUTION PLAN");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("Workflow: " + (workflow.name ?? workflow.id) + " (" + workflow.id + ")");
  console.log("Task: " + params.taskTitle);
  console.log("Steps: " + steps.length);
  console.log("");

  console.log("─────────────────────────────────────────────────────────────────");
  console.log("CONTEXT (placeholder values):");
  console.log("─────────────────────────────────────────────────────────────────");
  for (const [key, value] of Object.entries(placeholderContext)) {
    console.log("  {{" + key + "}}: " + value);
  }
  console.log("");

  console.log("─────────────────────────────────────────────────────────────────");
  console.log("EXECUTION ORDER:");
  console.log("─────────────────────────────────────────────────────────────────");
  for (const step of steps) {
    const statusIcon = step.status === "pending" ? "→" : "…";
    const typeLabel = step.type === "loop" ? " [LOOP]" : "";
    console.log(statusIcon + " Step " + (step.stepIndex + 1) + ": " + step.stepId + typeLabel);
    console.log("    Agent: " + step.agentId);
    const inputPreview = step.resolvedInput.slice(0, 100);
    const inputSuffix = step.resolvedInput.length > 100 ? "..." : "";
    console.log("    Input: " + inputPreview + inputSuffix);
    console.log("    Expects: " + step.expects);
    console.log("");
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("                       VALIDATION PASSED");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Workflow YAML is valid. All templates resolved.");
  console.log("No database entries created. No agents spawned.");
  console.log("");

  return {
    workflowId: workflow.id,
    workflowName: workflow.name ?? workflow.id,
    task: params.taskTitle,
    steps,
    context: placeholderContext,
  };
}

export async function runWorkflow(params: {
  workflowId: string;
  taskTitle: string;
  notifyUrl?: string;
}): Promise<{ id: string; runNumber: number; workflowId: string; task: string; status: string }> {
  const workflowDir = resolveWorkflowDir(params.workflowId);
  const workflow = await loadWorkflowSpec(workflowDir);
  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const runNumber = nextRunNumber();

  const initialContext: Record<string, string> = {
    task: params.taskTitle,
    ...workflow.context,
  };

  db.exec("BEGIN");
  try {
    const notifyUrl = params.notifyUrl ?? workflow.notifications?.url ?? null;
    const insertRun = db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, notify_url, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)"
    );
    insertRun.run(runId, runNumber, workflow.id, params.taskTitle, JSON.stringify(initialContext), notifyUrl, now, now);

    const insertStep = db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const stepUuid = crypto.randomUUID();
      const agentId = workflow.id + "_" + step.agent;
      const status = i === 0 ? "pending" : "waiting";
      const maxRetries = step.max_retries ?? step.on_fail?.max_retries ?? 2;
      const stepType = step.type ?? "single";
      const loopConfig = step.loop ? JSON.stringify(step.loop) : null;
      insertStep.run(stepUuid, runId, step.id, agentId, i, step.input, step.expects, status, maxRetries, stepType, loopConfig, now, now);
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Start crons for this workflow (no-op if already running from another run)
  try {
    await ensureWorkflowCrons(workflow);
  } catch (err) {
    // Roll back the run since it can't advance without crons
    const db2 = getDb();
    db2.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), runId);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error("Cannot start workflow run: cron setup failed. " + message);
  }

  emitEvent({ ts: new Date().toISOString(), event: "run.started", runId, workflowId: workflow.id });

  logger.info("Run started: \"" + params.taskTitle + "\"", {
    workflowId: workflow.id,
    runId,
    stepId: workflow.steps[0]?.id,
  });

  return { id: runId, runNumber, workflowId: workflow.id, task: params.taskTitle, status: "running" };
}
