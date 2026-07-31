import { usdToBaseUnits, baseUnitsToUsd } from "./money.js";

export class SessionCapExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionCapExceededError";
  }
}

/**
 * Tracks cumulative spend across a whole process lifetime (e.g. one MCP server
 * session handling many pay_url calls), which a single CLI invocation's
 * per-request --max-price cannot do.
 *
 * x402's "exact" scheme is intentionally one-shot/per-request; it has no protocol-native
 * aggregate-spend primitive. This is an app-level, in-memory approximation, not a
 * substitute for it — for a real multi-call session budget with an atomic on-chain
 * guarantee, see MPP Channel mode (pre-authorized deposit + cumulative off-chain
 * commitments + single settlement) in the `stellar-agentic-payments` skill.
 *
 * `reserve()`/`commit()`/`release()` are serialized through an internal queue so
 * concurrent calls on the same instance can't both pass the check before either
 * records its spend (the same race the per-request --max-price filter is exposed to).
 */
export class SessionSpendCap {
  #capBaseUnits;
  #spentBaseUnits = 0n;
  #queue = Promise.resolve();

  /**
   * @param {string|number|null} [capUsd] - Cap in USD, or null/undefined for no cap.
   */
  constructor(capUsd) {
    this.#capBaseUnits = capUsd != null ? usdToBaseUnits(capUsd) : null;
  }

  #serialize(fn) {
    const result = this.#queue.then(fn);
    // Swallow rejections in the chain itself so one failed reservation doesn't
    // wedge the queue for subsequent calls; callers still see their own rejection.
    this.#queue = result.catch(() => {});
    return result;
  }

  /**
   * Atomically checks that `amountBaseUnits` fits in the remaining budget and,
   * if so, records it as spent immediately (optimistic reservation). Throws
   * SessionCapExceededError otherwise. Call `release()` if the payment then fails
   * downstream, to give the budget back.
   * @param {bigint} amountBaseUnits
   */
  reserve(amountBaseUnits) {
    return this.#serialize(() => {
      if (this.#capBaseUnits == null) {
        this.#spentBaseUnits += amountBaseUnits;
        return;
      }
      if (this.#spentBaseUnits + amountBaseUnits > this.#capBaseUnits) {
        throw new SessionCapExceededError(
          `Session cap exceeded: this payment (${baseUnitsToUsd(amountBaseUnits)}) would bring ` +
            `cumulative spend to ${baseUnitsToUsd(this.#spentBaseUnits + amountBaseUnits)}, ` +
            `over the ${baseUnitsToUsd(this.#capBaseUnits)} session cap ` +
            `(${baseUnitsToUsd(this.remainingBaseUnits())} remaining).`
        );
      }
      this.#spentBaseUnits += amountBaseUnits;
    });
  }

  /** Give back a reservation for a payment that failed after `reserve()` succeeded. */
  release(amountBaseUnits) {
    return this.#serialize(() => {
      this.#spentBaseUnits -= amountBaseUnits;
      if (this.#spentBaseUnits < 0n) this.#spentBaseUnits = 0n;
    });
  }

  remainingBaseUnits() {
    if (this.#capBaseUnits == null) return null;
    const remaining = this.#capBaseUnits - this.#spentBaseUnits;
    return remaining < 0n ? 0n : remaining;
  }

  remainingUsd() {
    const remaining = this.remainingBaseUnits();
    return remaining == null ? null : baseUnitsToUsd(remaining);
  }

  spentUsd() {
    return baseUnitsToUsd(this.#spentBaseUnits);
  }
}
