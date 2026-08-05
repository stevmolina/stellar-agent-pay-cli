---
type: Runtime Architecture
title: x402 Stellar payment flow
description: Explains how the shared payment library inspects x402 challenges, creates a Stellar exact-scheme paid fetch, filters prices, and returns settlement metadata.
resource: /src/pay.js
tags: [architecture, x402, stellar, payments, http]
---

# x402 Stellar payment flow

`src/pay.js` is the canonical runtime layer. The [CLI and MCP interfaces](../interfaces/cli-and-mcp.md) call its exported functions rather than implementing payment logic independently, which keeps their payment behavior aligned.

## End-to-end path

```text
caller
  → peekPaymentRequirements (optional inspection)
  → payUrl
  → createPaidFetch
  → x402 payment-aware fetch wrapper
  → HTTP resource: 402 challenge → signed exact Stellar payment → unlocked response
```

1. **Inspect without payment.** `peekPaymentRequirements(url, init)` uses ordinary `fetch`. If the endpoint does not return 402, it returns its status with `requirements: null`. For a 402 response, it first decodes the base64 `PAYMENT-REQUIRED` header via `decodePaymentRequiredHeader`; it only falls back to parsing the body when header decoding is unavailable or fails.
2. **Build the paid transport.** `createPaidFetch(opts)` resolves the CAIP-2 network from `opts.network`, `STELLAR_NETWORK`, or `stellar:testnet`; it resolves the raw secret from `opts.secretKey` or `STELLAR_SECRET_KEY`. Missing secrets cause `AgentPayConfigError` before any request.
3. **Select the Stellar scheme.** The function passes an Ed25519 signer and `ExactStellarScheme` into `wrapFetchWithPaymentFromConfig` from the pinned `@x402/*` v2 dependencies.
4. **Apply an optional offer filter.** When `maxPriceUsd` is supplied, `buildMaxPricePolicy` converts that USD value to Stellar USDC base units and keeps only offers at or below it. It rejects malformed or absent prices by dropping them rather than throwing.
5. **Execute and decode settlement.** `payUrl(url, options)` runs the paid fetch, then decodes the optional `PAYMENT-RESPONSE` header into `settlement`. It returns both the raw `Response` and that settlement object so transports can choose their own rendering.

## Price representation is a compatibility boundary

`amountOf(requirement)` reads `requirement.amount`, with `maxAmountRequired` only as a defensive fallback. This is not cosmetic: current client-side challenge data uses `amount`; `maxAmountRequired` names a different server-side configuration shape. Commit `79c4315` records that using the wrong field silently rejected all offers below a cap, omitted dry-run prices, and bypassed MCP reservations. Keep `amountOf` shared across all price-sensitive callers and preserve its regression tests in `test/pay.test.js`.

The monetary helper uses **seven** USDC decimals because Stellar USDC differs from EVM USDC. [Safety and observability](safety-and-observability.md) relies on the same exact `BigInt` representation for session budget accounting; avoid floats in payment-policy or cap changes.

## Retry boundary

`createPaidFetch` wraps only the underlying global `fetch` with `withRetry(fetch)` before handing it to x402. The [safety and observability guidance](safety-and-observability.md) explains why this is deliberately not a retry around `payUrl`: the latter would rerun 402 negotiation and might sign a second authorization. The transport wrapper retries only a bounded set of connection errors and returns HTTP responses, including 4xx/5xx, unchanged.

## Change guide

- Change **challenge parsing** in `src/pay.js` only with tests that exercise header-first behavior and the non-402 path. A challenge body is not guaranteed to contain the payment requirements.
- Change **price filters** with boundary, malformed-value, and real-wire-field regression tests in `test/pay.test.js`.
- Change **network/signer initialization** without exposing secret material in errors, logs, or documentation. The public error should continue to name the environment variable, not its value.
- Change **retry behavior** only alongside review of duplicate-payment implications in [Safety and observability](safety-and-observability.md).
