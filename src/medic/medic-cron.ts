/**
 * Medic cron management — install/uninstall the medic's periodic check cron job.
 * 
 * Supports two modes:
 * 1. LLM cron (default): Creates an LLM session that runs medic check
 * 2. CLI-first (recommended): Runs medic check as CLI, only uses LLM when issues found
 */
import { createAgentCronJob, deleteCronJob, listCronJobs } from "../installer/gateway-api.js";
import { resolveAntfarmCli } from "../installer/paths.js";
import { readOpenClawConfig, writeOpenClawConfig } from "../installer/openclaw-config.js";

const MEDIC_CRON_NAME = "antfarm/medic";
const MEDIC_CRON_CLI_NAME = "antfarm/medic-cli";
const MEDIC_EVERY_MS = 5 * 60 * 1000; // 5 minutes
const MEDIC_MODEL = "minimax/MiniMax-M2.5";
const MEDIC_TIMEOUT_SECONDS = 120;

/**
 * Build the standard LLM-based medic prompt.
 * The LLM runs the CLI check and responds based on findings.
 */
function buildMedicPrompt(): string {
  const cli = resolveAntfarmCli();
  return `You are the Antfarm Medic — a lightweight health watchdog.

Run the medic check and respond:
\`\`\`
node ${cli} medic run --json
\`\`\`

Respond with ONLY:
- "HEARTBEAT_OK" (exact text, no other output) if issuesFound is 0
- A summary if issues were found

Do NOT attempt to fix issues yourself. The medic check handles remediation.
If critical issues, alert via sessions_send to agent:main:main.`;
}

/**
 * Build the CLI-first medic prompt.
 * This is more efficient: runs CLI first, only uses LLM for remediation when issues found.
 */
function buildMedicCliPrompt(): string {
  const cli = resolveAntfarmCli();
  return `You are the Antfarm Medic — a lightweight health watchdog.

IMPORTANT: Only use LLM capabilities if there are actual issues to fix. If the farm is healthy, say "HEARTBEAT_OK" immediately.

Step 1 — Check for issues:
\`\`\`
node ${cli} medic run --json
\`\`\`

If issuesFound is 0: respond with ONLY "HEARTBEAT_OK" (no other output)

If issuesFound > 0: This is an escalation — proceed with remediation:
- Analyze the findings
- Take corrective action where safe
- Alert via sessions_send to agent:main:main if critical issues

The CLI already ran the check. Your job is to:
1. If healthy: say "HEARTBEAT_OK" 
2. If issues: fix them using your LLM capabilities`;
}

async function ensureMedicAgent(): Promise<void> {
  try {
    const { path, config } = await readOpenClawConfig();
    const agents = config.agents?.list ?? [];
    if (agents.some((a: any) => a.id === "antfarm-medic")) return;

    if (!config.agents) config.agents = {};
    if (!config.agents.list) config.agents.list = [];
    config.agents.list.push({
      id: "antfarm-medic",
      name: "Antfarm Medic",
      model: MEDIC_MODEL,
    });
    await writeOpenClawConfig(path, config);
  } catch {
    // best-effort — cron will still work without agent provisioning
  }
}

async function removeMedicAgent(): Promise<void> {
  try {
    const { path, config } = await readOpenClawConfig();
    const agents = config.agents?.list ?? [];
    const idx = agents.findIndex((a: any) => a.id === "antfarm-medic");
    if (idx === -1) return;
    agents.splice(idx, 1);
    await writeOpenClawConfig(path, config);
  } catch {
    // best-effort
  }
}

export async function installMedicCron(): Promise<{ ok: boolean; error?: string }> {
  // Check if already installed
  const existing = await findMedicCronJob();
  if (existing) {
    return { ok: true }; // already installed
  }

  // Ensure agent is provisioned in OpenClaw config
  await ensureMedicAgent();

  const result = await createAgentCronJob({
    name: MEDIC_CRON_NAME,
    schedule: { kind: "every", everyMs: MEDIC_EVERY_MS },
    sessionTarget: "isolated",
    agentId: "antfarm-medic",
    payload: {
      kind: "agentTurn",
      message: buildMedicPrompt(),
      model: MEDIC_MODEL,
      timeoutSeconds: MEDIC_TIMEOUT_SECONDS,
    },
    delivery: { mode: "none" },
    enabled: true,
  });

  return result;
}

/**
 * Install CLI-first medic cron (recommended).
 * This mode is more efficient:
 * - Runs CLI check first
 * - Only uses LLM for remediation when issues found
 * - Saves tokens when farm is healthy
 */
export async function installMedicCronCli(): Promise<{ ok: boolean; error?: string }> {
  // Check if already installed
  const existing = await findMedicCronCliJob();
  if (existing) {
    return { ok: true }; // already installed
  }

  // Ensure agent is provisioned in OpenClaw config
  await ensureMedicAgent();

  const result = await createAgentCronJob({
    name: MEDIC_CRON_CLI_NAME,
    schedule: { kind: "every", everyMs: MEDIC_EVERY_MS },
    sessionTarget: "isolated",
    agentId: "antfarm-medic",
    payload: {
      kind: "agentTurn",
      message: buildMedicCliPrompt(),
      model: MEDIC_MODEL,
      timeoutSeconds: MEDIC_TIMEOUT_SECONDS,
    },
    delivery: { mode: "none" },
    enabled: true,
  });

  return result;
}

export async function uninstallMedicCron(): Promise<{ ok: boolean; error?: string }> {
  const job = await findMedicCronJob();
  if (!job) {
    await removeMedicAgent();
    return { ok: true }; // nothing to remove
  }
  const result = await deleteCronJob(job.id);
  if (result.ok) {
    await removeMedicAgent();
  }
  return result;
}

export async function uninstallMedicCronCli(): Promise<{ ok: boolean; error?: string }> {
  const job = await findMedicCronCliJob();
  if (!job) {
    return { ok: true }; // nothing to remove
  }
  const result = await deleteCronJob(job.id);
  return result;
}

export async function isMedicCronInstalled(): Promise<boolean> {
  const job = await findMedicCronJob();
  return job !== null;
}

export async function isMedicCronCliInstalled(): Promise<boolean> {
  const job = await findMedicCronCliJob();
  return job !== null;
}

async function findMedicCronJob(): Promise<{ id: string; name: string } | null> {
  const result = await listCronJobs();
  if (!result.ok || !result.jobs) return null;
  return result.jobs.find(j => j.name === MEDIC_CRON_NAME) ?? null;
}

async function findMedicCronCliJob(): Promise<{ id: string; name: string } | null> {
  const result = await listCronJobs();
  if (!result.ok || !result.jobs) return null;
  return result.jobs.find(j => j.name === MEDIC_CRON_CLI_NAME) ?? null;
}
