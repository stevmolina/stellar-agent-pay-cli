import { amountOf } from "./pay.js";
import { SessionCapExceededError } from "./sessionCap.js";
import { baseUnitsToUsd } from "./money.js";

/**
 * Enforces a SessionSpendCap at the one moment the price is known for certain:
 * after the x402 client has selected which offer it will pay, and before the
 * scheme signs anything.
 *
 * Why this exists instead of peeking the price first: an earlier version fetched
 * the 402 challenge separately, reserved `accepts[0]`, and then called payUrl,
 * which re-negotiated from scratch and applied the price/recipient policies
 * independently. Three things were wrong with that. `accepts` has no defined
 * price ordering, so `accepts[0]` was not necessarily the cheapest. The offer that
 * survived the policy filters was not necessarily the one that had been reserved,
 * so the budget could be charged for an offer that was never paid. And it cost an
 * extra 402 round trip per purchase. Hooking the client's own selection removes
 * all three: the amount reserved is the amount signed, by construction.
 */
export class SessionCapGuard {
  #cap;
  #reservedFor = new WeakMap();
  #lastError = null;
  // Tracked alongside #reservedFor because a WeakMap can't be read without the
  // challenge object, and reconcile() runs after payUrl has returned.
  #lastReservedAmount = null;

  /** @param {import("./sessionCap.js").SessionSpendCap} cap */
  constructor(cap) {
    this.#cap = cap;
  }

  /**
   * The refusal that caused the last abort, if any. The x402 client rewraps a
   * thrown hook error into a generic "Failed to create payment payload", losing
   * the type, so the guard keeps the typed original for the caller to report.
   */
  get lastError() {
    return this.#lastError;
  }

  /**
   * Register on an x402 client via `onBeforePaymentCreation` (or pass as
   * `onBeforePayment` to createPaidFetch/payUrl).
   */
  beforePayment = async (context) => {
    // createPaymentPayload can run twice for one purchase: if payload creation
    // fails and a recovery hook replaces it, the client rebuilds against the same
    // PaymentRequired object. Reserving per challenge, not per call, keeps one
    // purchase from being charged to the budget twice.
    if (this.#reservedFor.has(context.paymentRequired)) return;

    const amount = amountOf(context.selectedRequirements ?? {});
    let parsed;
    try {
      parsed = BigInt(amount);
    } catch {
      parsed = null;
    }

    if (parsed == null) {
      // Fail closed. Letting an unpriceable offer through used to skip the
      // reservation entirely and pay anyway, which is the one direction a spend
      // guard must never fail in. With no cap set there is nothing to enforce.
      if (!this.#cap.hasCap) return;
      this.#lastError = new SessionCapExceededError(
        `Refusing to pay: the selected offer has no readable amount (got ${JSON.stringify(amount)}), ` +
          `so it cannot be checked against the session cap.`
      );
      return { abort: true, reason: this.#lastError.message };
    }

    try {
      await this.#cap.reserve(parsed);
    } catch (err) {
      if (err instanceof SessionCapExceededError) {
        this.#lastError = err;
        return { abort: true, reason: err.message };
      }
      throw err;
    }
    this.#reservedFor.set(context.paymentRequired, parsed);
    this.#lastReservedAmount = parsed;
  };

  /**
   * Register on an x402 client via `onPaymentCreationFailure` (or pass as
   * `onPaymentFailure`). Payload creation throwing is the one failure that
   * definitely means nothing was signed and no money moved, so the reservation
   * can be given back safely.
   *
   * Deliberately NOT done for a failure *after* signing (a 5xx, a dropped
   * connection): at that point it is unknown whether settlement happened, and a
   * budget that guesses "no" can be talked into overspending. Holding the
   * reservation can only under-spend, which is the safe direction to be wrong in.
   */
  paymentFailure = async (context) => {
    const reserved = this.#reservedFor.get(context.paymentRequired);
    if (reserved == null) return;
    this.#reservedFor.delete(context.paymentRequired);
    if (this.#lastReservedAmount === reserved) this.#lastReservedAmount = null;
    await this.#cap.release(reserved);
  };

  /**
   * Sanity-check the settled amount against what was reserved and correct any
   * difference.
   *
   * Inert against OZ Channels today, deliberately. A live PAYMENT-RESPONSE decodes to
   * `{success, payer, transaction, network}` with no amount (see the e2e test that
   * pins this), so there is nothing to compare and this returns null. It is kept
   * because the reservation is currently the *only* record of what a payment cost, so
   * if a facilitator ever does report a settled amount, the one thing worth knowing is
   * whether it disagrees. Wire it up rather than trust the reservation forever.
   *
   * @param {{amount?: string|number|bigint}|null} settlement
   * @returns {{drift: bigint, reservedUsd: string, settledUsd: string}|null}
   */
  async reconcile(settlement) {
    if (settlement?.amount == null) return null;
    let settled;
    try {
      settled = BigInt(settlement.amount);
    } catch {
      return null;
    }
    const reserved = this.#lastReservedAmount;
    if (reserved == null || reserved === settled) return null;

    const drift = settled - reserved;
    if (drift > 0n) await this.#cap.reserve(drift);
    else await this.#cap.release(-drift);

    return {
      drift,
      reservedUsd: baseUnitsToUsd(reserved),
      settledUsd: baseUnitsToUsd(settled),
    };
  }
}
