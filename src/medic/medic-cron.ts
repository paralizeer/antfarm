/**
 * Medic cron management — install/uninstall the medic's periodic check cron job.
 * 
 * Supports two modes:
 * - LLM-based (default): Spawns an LLM session every 5 min to check + remediate
 * - CLI-first (lite): Shell cron that only spawns LLM when issues detected
 */
import { createAgentCronJob, deleteCronJob, listCronJobs } from "../installer/gateway-api.js";
import { resolveAntfarmCli } from "../installer/paths.js";
import { readOpenClawConfig, writeOpenClawConfig } from "../installer/openclaw-config.js";
import {
  installMedicCronLite as installMedicCronLiteImpl,
  uninstallMedicCronLite as uninstallMedicCronLiteImpl,
} from "./medic-shell.js";

const MEDIC_CRON_NAME = "antfarm/medic";
const MEDIC_EVERY_MS = 5 * 60 * 1000; // 5 minutes
const MEDIC_MODEL = "default";
const MEDIC_TIMEOUT_SECONDS = 120;

function buildMedicPrompt(): string {
  const cli = resolveAntfarmCli();
  return `You are the Antfarm Medic — a health watchdog for workflow runs.

Run the medic check:
\`\`\`
node ${cli} medic run --json
\`\`\`

If the check output contains "issuesFound": 0, reply HEARTBEAT_OK and stop.
If issues were found, summarize what was detected and what actions were taken.

If there are critical unremediated issues, use sessions_send to alert the main session:
\`\`\`
sessions_send(sessionKey: "agent:main:main", message: "🚑 Antfarm Medic Alert: <summary of critical issues>")
\`\`\`

Do NOT attempt to fix issues yourself beyond what the medic check already handles.`;
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

async function findMedicCronJob(): Promise<{ id: string; name: string } | null> {
  const result = await listCronJobs();
  if (!result.ok || !result.jobs) return null;
  return result.jobs.find(j => j.name === MEDIC_CRON_NAME) ?? null;
}

// ---------------------------------------------------------------------------
// Medic mode configuration (LLM vs Lite)
// ---------------------------------------------------------------------------

async function getMedicMode(): Promise<"llm" | "lite"> {
  try {
    const { config } = await readOpenClawConfig();
    return (config.antfarm?.medicMode as "llm" | "lite") ?? "llm";
  } catch {
    return "llm";
  }
}

async function setMedicMode(mode: "llm" | "lite"): Promise<void> {
  try {
    const { path, config } = await readOpenClawConfig();
    if (!config.antfarm) config.antfarm = {};
    config.antfarm.medicMode = mode;
    await writeOpenClawConfig(path, config);
  } catch {
    // best-effort
  }
}

export async function getMedicCronStatus(): Promise<{
  mode: "llm" | "lite";
  llmCronInstalled: boolean;
  liteCronInstalled: boolean;
}> {
  const mode = await getMedicMode();
  const job = await findMedicCronJob();
  
  // Check for lite cron via crontab
  let liteCronInstalled = false;
  try {
    const { execSync } = await import("node:child_process");
    const crontab = execSync("crontab -l 2>/dev/null || true", { encoding: "utf-8" });
    liteCronInstalled = crontab.includes("antfarm-medic-check.sh");
  } catch {
    // ignore
  }
  
  return {
    mode,
    llmCronInstalled: job !== null,
    liteCronInstalled,
  };
}

// ---------------------------------------------------------------------------
// LLM-based medic (original)
// ---------------------------------------------------------------------------

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

  if (result.ok) {
    await setMedicMode("llm");
  }
  
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

// ---------------------------------------------------------------------------
// Lite (CLI-first) medic
// ---------------------------------------------------------------------------

export async function installMedicCronLite(): Promise<{ ok: boolean; error?: string }> {
  // Uninstall LLM-based medic first if installed
  await uninstallMedicCron();
  
  // Install lite version (shell-based)
  const result = await installMedicCronLiteImpl();
  
  if (result.ok) {
    await setMedicMode("lite");
  }
  
  return result;
}

export async function uninstallMedicCronLite(): Promise<{ ok: boolean; error?: string }> {
  const result = await uninstallMedicCronLiteImpl();
  await setMedicMode("llm"); // reset to default
  return result;
}

export async function uninstallMedicCronAll(): Promise<{ ok: boolean; error?: string }> {
  // Uninstall LLM-based
  await uninstallMedicCron();
  
  // Uninstall lite-based
  await uninstallMedicCronLiteImpl();
  
  await setMedicMode("llm"); // reset to default
  
  return { ok: true };
}

export async function isMedicCronInstalled(): Promise<boolean> {
  const job = await findMedicCronJob();
  return job !== null;
}
