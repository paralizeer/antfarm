/**
 * Step output parsing and template resolution utilities.
 * Extracted from step-ops.ts for better code organization.
 */

/**
 * Parse KEY: value lines from step output with support for multi-line values.
 * Accumulates continuation lines until the next KEY: boundary or end of output.
 * Returns a map of lowercase keys to their (trimmed) values.
 * Skips STORIES_JSON keys (handled separately).
 */
export function parseOutputKeyValues(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = output.split("\n");
  let pendingKey: string | null = null;
  let pendingValue = "";

  function commitPending() {
    if (pendingKey && !pendingKey.startsWith("STORIES_JSON")) {
      result[pendingKey.toLowerCase()] = pendingValue.trim();
    }
    pendingKey = null;
    pendingValue = "";
  }

  for (const line of lines) {
    const match = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (match) {
      // New KEY: line found — flush previous key
      commitPending();
      pendingKey = match[1];
      pendingValue = match[2];
    } else if (pendingKey) {
      // Continuation line — append to current key's value
      pendingValue += "\n" + line;
    }
  }
  // Flush any remaining pending value
  commitPending();

  return result;
}

/**
 * Resolve {{key}} placeholders in a template against a context object.
 */
export function resolveTemplate(template: string, context: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    if (key in context) return context[key];
    const lower = key.toLowerCase();
    if (lower in context) return context[lower];
    return `[missing: ${key}]`;
  });
}

/**
 * Find missing template placeholders for a given context object.
 */
export function findMissingTemplateKeys(template: string, context: Record<string, string>): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    const lower = key.toLowerCase();
    const hasExact = Object.prototype.hasOwnProperty.call(context, key);
    const hasLower = Object.prototype.hasOwnProperty.call(context, lower);
    if (!hasExact && !hasLower && !seen.has(lower)) {
      seen.add(lower);
      missing.push(lower);
    }
    return "";
  });
  return missing;
}
