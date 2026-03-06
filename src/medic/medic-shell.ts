/**
 * Lightweight CLI-first medic check.
 * Runs as a shell cron (no LLM cost when idle).
 * Only spawns an LLM session when issues are detected.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveAntfarmCli } from "../installer/paths.js";

const MEDIC_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Run the medic check via CLI and return parsed JSON.
 */
export function runMedicCheck(): {
  id: string;
  checkedAt: string;
  issuesFound: number;
  actionsTaken: number;
  summary: string;
  findings: Array<{
    check: string;
    severity: string;
    message: string;
    action: string;
    runId?: string;
    remediated: boolean;
  }>;
} | null {
  try {
    const cli = resolveAntfarmCli();
    const output = execSync("node " + cli + " medic run --json", {
      encoding: "utf-8",
      timeout: 30000,
    });
    return JSON.parse(output.trim());
  } catch (error) {
    console.error("[medic-shell] Failed to run medic check:", error);
    return null;
  }
}

/**
 * Check if there are any critical unremediated issues.
 */
export function hasCriticalIssues(checkResult: ReturnType<typeof runMedicCheck>): boolean {
  if (!checkResult) return false;
  return (
    checkResult.issuesFound > 0 &&
    checkResult.findings.some((f) => f.severity === "critical" && !f.remediated)
  );
}

/**
 * Generate the crontab entry for the lightweight medic.
 */
export function generateMedicCronEntry(): string {
  const cli = resolveAntfarmCli();
  const scriptPath = path.join(os.homedir(), ".openclaw", "antfarm-medic-check.sh");
  
  // Generate the shell script content
  // Note: Using string concatenation instead of template literals to avoid escaping issues
  const scriptContent = [
    "#!/bin/bash",
    "# Antfarm lightweight medic check - runs as shell cron, no LLM cost when idle",
    "# Only spawns LLM session when critical issues are detected",
    "",
    'LOG_DIR="$HOME/.openclaw/logs/medic"',
    "mkdir -p \"$LOG_DIR\"",
    "",
    'CLI="' + cli + '"',
    'LOG_FILE="$LOG_DIR/medic-$(date +%Y%m%d).log"',
    "",
    "# Run the medic check",
    'OUTPUT=$("$CLI" medic run --json 2>&1)',
    "EXIT_CODE=$?",
    "",
    "if [ $EXIT_CODE -ne 0 ]; then",
    '  echo "$(date -Iseconds) ERROR: medic check failed: $OUTPUT" >> "$LOG_FILE"',
    "  exit 1",
    "fi",
    "",
    "# Extract issuesFound from JSON",
    'ISSUES=$(echo "$OUTPUT" | grep -o \'"issuesFound":[0-9]*\' | grep -o \'[0-9]*\')',
    "",
    "if [ -z \"$ISSUES\" ] || [ \"$ISSUES\" -eq 0 ]; then",
    '  echo "$(date -Iseconds) OK: no issues found" >> "$LOG_FILE"',
    "  exit 0",
    "fi",
    "",
    "# Issues found - check if any are critical",
    'CRITICAL=$(echo "$OUTPUT" | grep -c \'"severity":"critical"\' || true)',
    'REMEDIATED=$(echo "$OUTPUT" | grep -c \'"remediated":true\' || true)',
    "",
    "UNREMEDIATED=$((CRITICAL - REMEDIATED))",
    "",
    'if [ "$UNREMEDIATED" -gt 0 ]; then',
    '  echo "$(date -Iseconds) ALERT: $UNREMEDIATED unremediated critical issues found" >> "$LOG_FILE"',
    '  echo "$OUTPUT" >> "$LOG_FILE"',
    "fi",
    "",
    "exit 0",
  ].join("\n");

  // Write the script
  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
  
  // Generate crontab entry
  const cronInterval = "*/" + (MEDIC_CHECK_INTERVAL_MS / 60000) + " * * * *";
  const logPath = os.homedir() + "/.openclaw/logs/medic/cron.log";
  const cronEntry = cronInterval + " " + scriptPath + " >> " + logPath + " 2>&1";
  
  return cronEntry;
}

/**
 * Install the lightweight medic cron (shell-based, not LLM-based).
 */
export async function installMedicCronLite(): Promise<{ ok: boolean; error?: string }> {
  const cronEntry = generateMedicCronEntry();
  const cronFile = "/tmp/antfarm-medic-cron-temp";
  
  try {
    // Read existing crontab
    const existingCrontab = execSync("crontab -l 2>/dev/null || true", { encoding: "utf-8" });
    
    // Remove any existing antfarm medic entries
    const filteredCrontab = existingCrontab
      .split("\n")
      .filter((line) => !line.includes("antfarm-medic-check.sh"))
      .filter((line) => line.trim() !== "")
      .join("\n");
    
    // Add new entry
    const newCrontab = filteredCrontab + "\n" + cronEntry + "\n";
    
    // Write new crontab
    fs.writeFileSync(cronFile, newCrontab);
    execSync("crontab " + cronFile, { encoding: "utf-8" });
    fs.unlinkSync(cronFile);
    
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * Uninstall the lightweight medic cron.
 */
export async function uninstallMedicCronLite(): Promise<{ ok: boolean; error?: string }> {
  try {
    const scriptPath = path.join(os.homedir(), ".openclaw", "antfarm-medic-check.sh");
    
    // Remove script
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // ignore if not exists
    }
    
    // Remove from crontab
    const existingCrontab = execSync("crontab -l 2>/dev/null || true", { encoding: "utf-8" });
    const filteredCrontab = existingCrontab
      .split("\n")
      .filter((line) => !line.includes("antfarm-medic-check.sh"))
      .join("\n");
    
    const cronFile = "/tmp/antfarm-medic-cron-temp";
    fs.writeFileSync(cronFile, filteredCrontab);
    execSync("crontab " + cronFile, { encoding: "utf-8" });
    fs.unlinkSync(cronFile);
    
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
