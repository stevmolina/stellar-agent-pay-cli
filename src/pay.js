import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { decodePaymentResponseHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { AgentPayConfigError } from "./errors.js";
import { usdToBaseUnits } from "./money.js";
import { withRetry } from "./resilientFetch.js";

/**
 * @typedef {Object} AgentPayOptions
 * @property {string} [network] - CAIP-2 network id. Defaults to STELLAR_NETWORK env or "stellar:testnet".
 * @property {string} [secretKey] - Raw S... Stellar secret key. Defaults to STELLAR_SECRET_KEY env.
 * @property {string|number} [maxPriceUsd] - Refuse (filter out) any payment option above this USD amount.
 */

/**
 * Read a PaymentRequirements' price. The wire-format field is `amount` — confirmed
 * against a live facilitator response — NOT `maxAmountRequired`, which is a
 * *different* type in @x402/core (server-side RouteConfig), not this client-side
 * shape. Kept as a named export + the `?? maxAmountRequired` fallback specifically
 * because this was shipped wrong once (see test/pay.test.js) and silently filtered
 * out every payment option regardless of the cap.
 * @param {Record<string, unknown>} requirement
 */
export function amountOf(requirement) {
  return requirement?.amount ?? requirement?.maxAmountRequired;
}

/**
 * An x402 client PaymentPolicy that filters out any option pricier than `capUsd`.
 * Exported standalone so its field-name handling is unit-testable without a live
 * facilitator or a signed request.
 * @param {string|number} capUsd
 */
export function buildMaxPricePolicy(capUsd) {
  const capBaseUnits = usdToBaseUnits(capUsd);
  return (_x402Version, requirements) =>
    requirements.filter((r) => {
      try {
        return BigInt(amountOf(r)) <= capBaseUnits;
      } catch {
        return false;
      }
    });
}

/**
 * Build a payment-aware fetch for a single Stellar signer/network, with an optional
 * safety cap so an unattended agent never pays more than it was told to.
 *
 * @param {AgentPayOptions} [opts]
 * @returns {typeof fetch}
 */
export function createPaidFetch(opts = {}) {
  const network = opts.network ?? process.env.STELLAR_NETWORK ?? "stellar:testnet";
  const secretKey = opts.secretKey ?? process.env.STELLAR_SECRET_KEY;

  if (!secretKey) {
    throw new AgentPayConfigError(
      "STELLAR_SECRET_KEY is required (a testnet/mainnet S... secret with a funded USDC balance). " +
        "Set it in the environment or pass { secretKey }. See the README testnet runbook."
    );
  }

  // createEd25519Signer takes the raw S... secret and the CAIP-2 network id directly —
  // don't pre-wrap with Keypair.fromSecret, it does that internally.
  const signer = createEd25519Signer(secretKey, network);

  const policies = opts.maxPriceUsd != null ? [buildMaxPricePolicy(opts.maxPriceUsd)] : [];

  // Retry is applied to the *transport* (this base fetch), not around the whole
  // 402-negotiation flow — see resilientFetch.js for why that distinction matters
  // (retrying the business-logic layer could sign and submit a second payment).
  return wrapFetchWithPaymentFromConfig(withRetry(fetch), {
    schemes: [{ network, client: new ExactStellarScheme(signer) }],
    policies,
  });
}

/**
 * Peek at a 402-gated URL's payment requirements without paying.
 * Used for `--dry-run` so an agent can decide whether a price is worth paying.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<{ status: number, requirements: unknown } | { status: number, requirements: null }>}
 */
export async function peekPaymentRequirements(url, init = {}) {
  const res = await fetch(url, init);
  if (res.status !== 402) {
    return { status: res.status, requirements: null };
  }
  // The actual challenge (price, payTo, network, ...) travels in the
  // PAYMENT-REQUIRED header, base64-encoded — the 402 response body itself is
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
  const body = await res.json().catch(() => null);
  return { status: 402, requirements: body };
}

/**
 * Complete the 402 -> pay -> unlock loop for a single URL.
 *
 * @param {string} url
 * @param {RequestInit & AgentPayOptions} [options]
 * @returns {Promise<{ response: Response, settlement: unknown }>}
 */
export async function payUrl(url, options = {}) {
  const { network, secretKey, maxPriceUsd, ...init } = options;
  const fetchWithPayment = createPaidFetch({ network, secretKey, maxPriceUsd });
  const response = await fetchWithPayment(url, init);

  let settlement = null;
  const header = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("payment-response");
  if (header) {
    try {
      settlement = decodePaymentResponseHeader(header);
    } catch {
      settlement = null;
    }
  }

  return { response, settlement };
}
