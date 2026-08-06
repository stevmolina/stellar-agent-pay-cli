// Transport-level retry with backoff — deliberately scoped to network/connection
// failures BEFORE or DURING a single HTTP round trip, never to "retry the whole
// payment flow." Retrying at the payUrl()/business-logic layer would re-run x402's
// 402 negotiation and could sign and submit a SECOND payment for the same resource;
// retrying the transport layer just re-attempts delivery of the exact same request
// (including an already-signed X-PAYMENT header, if present), which is safe.
const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"]);

/** @param {unknown} err */
function isRetryableError(err) {
  const e = /** @type {{ cause?: { code?: string }, code?: string } | undefined | null} */ (err);
  const code = e?.cause?.code ?? e?.code;
  return code ? RETRYABLE_CODES.has(code) : false;
}

/**
 * Wrap a fetch implementation with bounded retries + exponential backoff for
 * transport-level failures only. 4xx/5xx HTTP responses are returned as-is
 * (not retried) — x402's own 402 handling, and the caller's own error handling
 * for 5xx, stay in charge of those.
 *
 * @param {typeof fetch} baseFetch
 * @param {{ retries?: number, baseDelayMs?: number, onRetry?: (attempt: number, err: Error) => void }} [opts]
 * @returns {typeof fetch}
 */
export function withRetry(baseFetch, opts = {}) {
  const retries = opts.retries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 250;

  return async function retryingFetch(input, init) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await baseFetch(input, init);
      } catch (err) {
        lastErr = err;
        if (!isRetryableError(err) || attempt === retries) throw err;
        opts.onRetry?.(attempt + 1, /** @type {Error} */ (err));
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
      }
    }
    throw lastErr;
  };
}
