---
type: Safety and Operations Guide
title: Payment safety and observability
description: Describes price and session spend controls, concurrency handling, retry limits, audit events, and residual x402 payment risks for the Stellar payment client.
resource: /src/sessionCap.js
tags: [security, reliability, observability, payments, x402]
---

# Payment safety and observability

This client handles agent-initiated payments, so cost and replay behavior are part of the product contract. The [payment flow](payment-flow.md) provides the shared mechanics; this page documents the controls that constrain that flow and the limits maintainers must not overstate.

## Two spend boundaries

### Per-request price policy

`--max-price` in the [CLI and MCP interfaces](../interfaces/cli-and-mcp.md) becomes `buildMaxPricePolicy(capUsd)` in `src/pay.js`. It converts a user price into seven-decimal Stellar USDC base units and filters x402 payment requirements before the exact-scheme payment is built. Invalid or unpriced offers are rejected; if no offer survives, x402 cannot proceed. This is a fail-closed offer-selection control, not a cumulative budget.

### MCP process session cap

`src/mcp.js` constructs `SessionSpendCap` once from `STELLAR_AGENT_PAY_SESSION_CAP_USD`. Before `pay_url` calls the shared [payment flow](payment-flow.md), it inspects the challenge and reserves the selected offer amount. The reservation is optimistic: it counts immediately so concurrent calls cannot each see the same remaining balance. If the downstream payment flow throws, `release()` gives the budget back.

`SessionSpendCap` serializes `reserve()` and `release()` through an internal Promise queue. Its tests verify that five concurrent $0.03 reservations against a $0.10 cap yield at most three successes. Preserve this serialization whenever modifying cap state; a simple check-then-increment permits overspending under concurrent agent tool calls.

This cap is in-memory and process-lifetime only. It is not an atomic on-chain guarantee, does not survive process restart, and cannot aggregate independent CLI invocations. It is deliberately documented as an application-level approximation rather than a replacement for a cumulative-payment protocol.

## Delivery retry and duplicate-payment risk

`src/resilientFetch.js` retries only known transport failures (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`, and `UND_ERR_SOCKET`) with two retries and exponential backoff from 250 ms by default. It does **not** retry HTTP statuses. The [payment flow](payment-flow.md) applies this wrapper below the x402 wrapper, so a retry resends one HTTP request, potentially including an already-signed payment header, rather than restarting negotiation.

Do not wrap `payUrl` in a generic retry helper. Restarting the business flow may sign and submit a second payment. The README also records two external/operational limits that remain unresolved by this buyer client:

- A seller must prevent replay or double-grant of an authorization while it remains valid; the client cannot enforce seller redemption tracking.
- Facilitator deduplication of a repeated Stellar settlement submission is unverified. Keep retries narrowly scoped until facilitator semantics are confirmed.

## Audit events

The CLI's `--log-file` calls `logPaymentEvent` in `src/eventLog.js`. When enabled, it synchronously appends one JSON object per line with an ISO timestamp plus supplied fields. For an exception during `payUrl`, it writes `url`, `method`, `paid: false`, and the error message; after a response, it records HTTP status, whether settlement was present, amount/network, and a transaction identifier if provided.

The log is deliberately distinct from human stderr output. JSONL files are ignored by Git via `*.jsonl`; use a user-controlled path with appropriate filesystem permissions and never treat the audit file as a secret store.

## Change checklist

- **Amounts:** use `usdToBaseUnits`/`baseUnitsToUsd` and `BigInt`, never floating-point comparisons. Run `test/money.test.js` and `test/pay.test.js`.
- **Caps:** preserve reserve-before-payment, release-on-failure, and queue serialization. Run `test/sessionCap.test.js`.
- **Retries:** review whether a change replays a signed request or creates a new payment authorization. Add a targeted test before changing codes, counts, or scope.
- **Logging:** preserve best-effort audit semantics without leaking secret keys or raw credential-bearing configuration.
- **Dependency updates:** `@x402/*` versions are pinned at `2.20.0` in `package.json`; evaluate protocol/facilitator advisories deliberately rather than broadening them to floating ranges.
