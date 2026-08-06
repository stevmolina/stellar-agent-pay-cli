import { usdToBaseUnits, baseUnitsToUsd } from "./money.js";

export class SessionCapExceededError extends Error {
  constructor(message: string) {
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
 * substitute for it. For a real multi-call session budget with an atomic on-chain
 * guarantee, see MPP Channel mode (pre-authorized deposit + cumulative off-chain
 * commitments + single settlement) in the `stellar-agentic-payments` skill.
 *
 * `reserve()` and `release()` are serialized through an internal queue so
 * concurrent calls on the same instance can't both pass the check before either
 * records its spend (the same race the per-request --max-price filter is exposed to).
 *
 * Reservation is optimistic: `reserve()` records the spend immediately, and
 * `release()` gives it back if the payment provably never happened. There is no
 * separate commit step, so a successful reserve is already the record of spend.
 * See spendGuard.ts for what decides when a release is safe.
 */
export class SessionSpendCap {
  #capBaseUnits: bigint | null;
  #spentBaseUnits = 0n;
  #queue: Promise<void> = Promise.resolve();

  /** @param capUsd Cap in USD, or null/undefined for no cap. */
  constructor(capUsd?: string | number | null) {
    this.#capBaseUnits = capUsd != null ? usdToBaseUnits(capUsd) : null;
  }

  /** Whether a cap is actually configured, as opposed to unlimited spend. */
  get hasCap(): boolean {
    return this.#capBaseUnits != null;
  }

  #serialize<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    const result = this.#queue.then(fn);
    // Swallow rejections in the chain itself so one failed reservation doesn't
    // wedge the queue for subsequent calls; callers still see their own rejection.
    this.#queue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  /**
   * Atomically checks that `amountBaseUnits` fits in the remaining budget and,
   * if so, records it as spent immediately (optimistic reservation). Throws
   * SessionCapExceededError otherwise. Call `release()` if the payment then fails
   * downstream, to give the budget back.
   */
  reserve(amountBaseUnits: bigint): Promise<void> {
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
            `(${baseUnitsToUsd(this.remainingBaseUnits() ?? 0n)} remaining).`
        );
      }
      this.#spentBaseUnits += amountBaseUnits;
    });
  }

  /** Give back a reservation for a payment that failed after `reserve()` succeeded. */
  release(amountBaseUnits: bigint): Promise<void> {
    return this.#serialize(() => {
      this.#spentBaseUnits -= amountBaseUnits;
      if (this.#spentBaseUnits < 0n) this.#spentBaseUnits = 0n;
    });
  }

  remainingBaseUnits(): bigint | null {
    if (this.#capBaseUnits == null) return null;
    const remaining = this.#capBaseUnits - this.#spentBaseUnits;
    return remaining < 0n ? 0n : remaining;
  }

  remainingUsd(): string | null {
    const remaining = this.remainingBaseUnits();
    return remaining == null ? null : baseUnitsToUsd(remaining);
  }

  spentUsd(): string {
    return baseUnitsToUsd(this.#spentBaseUnits);
  }
}
