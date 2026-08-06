import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import type { PaymentRequirements, PaymentRequired, SettleResponse } from "@x402/core/types";
import { AgentPayConfigError } from "./errors.js";
import { usdToBaseUnits } from "./money.js";
import { withRetry } from "./resilientFetch.js";

export type { PaymentRequirements, PaymentRequired };

/**
 * A decoded PAYMENT-RESPONSE header.
 *
 * Worth reading `SettleResponse` at the source: it declares `amount` optional and
 * present only for schemes where the settled figure can differ from the authorized
 * one. The "exact" scheme this package uses is not one of them, which is the same
 * fact the e2e test pins, now enforced by the compiler rather than by memory.
 *
 * `txHash` and `tx` are not protocol fields. They are tolerated because the CLI has
 * always read them as fallbacks, and deleting them here would be a behaviour change
 * dressed up as a type fix.
 */
export type Settlement = SettleResponse & { txHash?: string; tx?: string };

/** What the x402 client hands a before-payment hook once it has picked an offer. */
export type PaymentContext = {
  /** The challenge object, used as a per-purchase identity key. */
  paymentRequired: object;
  /** The offer that will actually be paid. */
  selectedRequirements?: PaymentRequirements;
};

/** What the x402 client hands a payment-failure hook. */
export type PaymentFailureContext = {
  paymentRequired: object;
  error: Error;
};

export type AgentPayOptions = {
  /** CAIP-2 network id. Defaults to STELLAR_NETWORK env or "stellar:testnet". */
  network?: string;
  /** Raw S... Stellar secret key. Defaults to STELLAR_SECRET_KEY env. */
  secretKey?: string;
  /** Refuse (filter out) any payment option above this USD amount. */
  maxPriceUsd?: string | number;
  /** If set, only pay a payTo in this list. */
  allowRecipients?: string[];
  /** Never pay a payTo in this list, even if otherwise valid. */
  blockRecipients?: string[];
  /**
   * Called once the client has chosen which offer to pay, and before anything is signed.
   * Return `{ abort, reason }` to refuse. This is the only place that sees the offer
   * actually being paid, which is why the session cap hooks in here (see spendGuard.ts).
   */
  onBeforePayment?: (context: PaymentContext) => Promise<void | { abort: true; reason: string }>;
  /**
   * Called if building the signed payload throws, which is the one failure that
   * definitely means no money moved.
   */
  onPaymentFailure?: (context: PaymentFailureContext) => Promise<void>;
};

/** The subset of a requirement that carries a price, in either spelling. */
type PricedRequirement = {
  amount?: string | number | bigint;
  maxAmountRequired?: string | number | bigint;
};

/**
 * Read a PaymentRequirements' price. The wire-format field is `amount`, confirmed
 * against a live facilitator response, NOT `maxAmountRequired`, which is a
 * *different* type in @x402/core (server-side RouteConfig), not this client-side
 * shape. Kept as a named export + the `?? maxAmountRequired` fallback specifically
 * because this was shipped wrong once (see test/pay.test.js) and silently filtered
 * out every payment option regardless of the cap.
 *
 * The parameter is typed looser than PaymentRequirements on purpose: the protocol
 * type has no `maxAmountRequired` at all, which is exactly why the fallback exists.
 */
export function amountOf(requirement?: PricedRequirement): string | number | bigint | undefined {
  return requirement?.amount ?? requirement?.maxAmountRequired;
}

/**
 * An x402 client PaymentPolicy that filters out any option pricier than `capUsd`.
 * Exported standalone so its field-name handling is unit-testable without a live
 * facilitator or a signed request.
 */
export function buildMaxPricePolicy(capUsd: string | number) {
  const capBaseUnits = usdToBaseUnits(capUsd);
  return (_x402Version: number, requirements: PaymentRequirements[]): PaymentRequirements[] =>
    requirements.filter((r) => {
      try {
        const amount = amountOf(r);
        // An unreadable price fails closed, same as a BigInt() throw below.
        return amount != null && BigInt(amount) <= capBaseUnits;
      } catch {
        return false;
      }
    });
}

/**
 * An x402 client PaymentPolicy that only allows (or blocks) specific `payTo`
 * recipients, the same shape of guardrail as a recipient/contract allow-list
 * on an on-chain policy signer, applied here at the app level in front of a
 * protocol that doesn't (yet) have a shipped on-chain equivalent for Stellar.
 * A block-list entry always wins over an allow-list match, so you can't
 * accidentally allow-list your way past a known-bad address.
 */
export function buildRecipientPolicy({ allow, block }: { allow?: string[]; block?: string[] } = {}) {
  const allowSet = allow?.length ? new Set(allow) : null;
  const blockSet = block?.length ? new Set(block) : null;
  return (_x402Version: number, requirements: PaymentRequirements[]): PaymentRequirements[] =>
    requirements.filter((r) => {
      // Cast rather than guard on null: an offer with no payTo has always been
      // let through when no allow-list is configured, and tightening that here
      // would be a behaviour change smuggled in under a type annotation.
      const payTo = r.payTo as string;
      if (blockSet?.has(payTo)) return false;
      if (allowSet && !allowSet.has(payTo)) return false;
      return true;
    });
}

/**
 * Build a payment-aware fetch for a single Stellar signer/network, with an optional
 * safety cap so an unattended agent never pays more than it was told to.
 */
export function createPaidFetch(opts: AgentPayOptions = {}): typeof fetch {
  // The CAIP-2 template literal type is what @x402/stellar wants. The value can only
  // ever arrive here as a plain string (a CLI flag or an env var), so it is asserted
  // once, here, instead of at each of the two call sites below.
  const network = (opts.network ??
    process.env.STELLAR_NETWORK ??
    "stellar:testnet") as `${string}:${string}`;
  const secretKey = opts.secretKey ?? process.env.STELLAR_SECRET_KEY;

  if (!secretKey) {
    throw new AgentPayConfigError(
      "STELLAR_SECRET_KEY is required (a testnet/mainnet S... secret with a funded USDC balance). " +
        "Set it in the environment or pass { secretKey }. See the README testnet runbook."
    );
  }

  // createEd25519Signer takes the raw S... secret and the CAIP-2 network id directly.
  // Don't pre-wrap with Keypair.fromSecret, it does that internally.
  const signer = createEd25519Signer(secretKey, network);

  const policies = [];
  if (opts.maxPriceUsd != null) policies.push(buildMaxPricePolicy(opts.maxPriceUsd));
  if (opts.allowRecipients?.length || opts.blockRecipients?.length) {
    policies.push(buildRecipientPolicy({ allow: opts.allowRecipients, block: opts.blockRecipients }));
  }

  // Built explicitly rather than via wrapFetchWithPaymentFromConfig (which is just
  // fromConfig + wrapFetchWithPayment) because the config object has no slot for
  // hooks, and onBeforePayment is the only way to see which offer actually won.
  const client = x402Client.fromConfig({
    schemes: [{ network, client: new ExactStellarScheme(signer) }],
    policies,
  });

  if (opts.onBeforePayment) {
    client.onBeforePaymentCreation(opts.onBeforePayment);
  }
  if (opts.onPaymentFailure) {
    client.onPaymentCreationFailure(opts.onPaymentFailure);
  }

  // Retry is applied to the *transport* (this base fetch), not around the whole
  // 402-negotiation flow. See resilientFetch.ts for why that distinction matters
  // (retrying the business-logic layer could sign and submit a second payment).
  return wrapFetchWithPayment(withRetry(fetch), client);
}

/**
 * Peek at a 402-gated URL's payment requirements without paying.
 * Used for `--dry-run` so an agent can decide whether a price is worth paying.
 */
export async function peekPaymentRequirements(
  url: string,
  init: RequestInit = {}
): Promise<{ status: number; requirements: PaymentRequired | null }> {
  const res = await fetch(url, init);
  if (res.status !== 402) {
    return { status: res.status, requirements: null };
  }
  // The actual challenge (price, payTo, network, ...) travels in the
  // PAYMENT-REQUIRED header, base64-encoded. The 402 response body itself is
  // typically empty (`{}`) unless the route configured a custom unpaidResponseBody.
  // A body-only implementation here would silently show nothing.
  const header = res.headers.get("PAYMENT-REQUIRED") ?? res.headers.get("payment-required");
  if (header) {
    try {
      return { status: 402, requirements: decodePaymentRequiredHeader(header) };
    } catch {
      // fall through to the body below
    }
  }
  // Asserted, not validated: this is the last-resort path for a server that put the
  // challenge in the body instead of the header, so its shape is whatever was sent.
  const body = (await res.json().catch(() => null)) as PaymentRequired | null;
  return { status: 402, requirements: body };
}

/**
 * Complete the 402 -> pay -> unlock loop for a single URL.
 *
 * Returns `amountPaid` in base units, captured from the offer the client selected.
 * It is not read off the settlement: a real PAYMENT-RESPONSE from OZ Channels carries
 * `{success, payer, transaction, network}` and no amount at all, so anything reporting
 * `settlement.amount` records undefined forever (which is what the JSONL audit trail
 * used to do). The selected offer is the only place the price is actually known.
 */
export async function payUrl(
  url: string,
  options: RequestInit & AgentPayOptions = {}
): Promise<{ response: Response; settlement: Settlement | null; amountPaid: string | null }> {
  const {
    network,
    secretKey,
    maxPriceUsd,
    allowRecipients,
    blockRecipients,
    onBeforePayment,
    onPaymentFailure,
    ...init
  } = options;
  // Records the price of the offer the client chose, then defers to the caller's own
  // hook (so a spend guard can still refuse). Runs first so the amount is captured
  // even when the guard goes on to abort.
  let amountPaid: string | null = null;
  const recordThenDelegate = async (context: PaymentContext) => {
    const amount = amountOf(context.selectedRequirements ?? {});
    if (amount != null) amountPaid = String(amount);
    return onBeforePayment ? onBeforePayment(context) : undefined;
  };

  const fetchWithPayment = createPaidFetch({
    network,
    secretKey,
    maxPriceUsd,
    allowRecipients,
    blockRecipients,
    onBeforePayment: recordThenDelegate,
    onPaymentFailure,
  });
  const response = await fetchWithPayment(url, init);

  let settlement: Settlement | null = null;
  const header = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("payment-response");
  if (header) {
    try {
      settlement = decodePaymentResponseHeader(header);
    } catch {
      settlement = null;
    }
  }

  return { response, settlement, amountPaid };
}
