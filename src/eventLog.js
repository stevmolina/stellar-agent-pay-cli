import fs from "node:fs";
import path from "node:path";

/**
 * Append one JSONL payment-event line: a structured, pipeable/tailable audit
 * trail of what an agent paid for, when, and how much, distinct from the
 * human-readable stderr status lines the CLI also prints.
 *
 * Creates the parent directory if needed. The README's own suggested path
 * (`~/.stellar-agent-pay/payments.jsonl`) points at a directory that won't exist
 * on a fresh machine, and this is called *after* a payment settles, so an ENOENT
 * here used to lose the caller its response body for a payment that had already
 * cost real money. For the same reason a write failure warns on stderr rather
 * than throwing: the money is already gone, so hiding the resource the user paid
 * for is strictly worse than an unwritten log line.
 *
 * @param {string|undefined} logFile - Path to append to. No-op if undefined.
 * @param {Record<string, unknown>} event
 * @returns {boolean} true if the line was written
 */
export function logPaymentEvent(logFile, event) {
  if (!logFile) return false;
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  try {
    const dir = path.dirname(path.resolve(logFile));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logFile, line + "\n");
    return true;
  } catch (err) {
    process.stderr.write(`warning: could not write payment log to ${logFile}: ${err.message}\n`);
    return false;
  }
}
