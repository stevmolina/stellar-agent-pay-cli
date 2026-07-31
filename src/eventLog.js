import fs from "node:fs";

/**
 * Append one JSONL payment-event line — a structured, pipeable/tailable audit
 * trail of what an agent paid for, when, and how much, distinct from the
 * human-readable stderr status lines the CLI also prints.
 *
 * @param {string|undefined} logFile - Path to append to. No-op if undefined.
 * @param {Record<string, unknown>} event
 */
export function logPaymentEvent(logFile, event) {
  if (!logFile) return;
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  fs.appendFileSync(logFile, line + "\n");
}
