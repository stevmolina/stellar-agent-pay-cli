# Design notes and known limits

Why the guardrails in [`stellar-agent-pay-cli`](../README.md) sit where they do, and what
they do not cover.

## Where the cap is enforced

The session cap runs on the x402 client's `onBeforePaymentCreation` hook
(`src/spendGuard.js`), which fires after the client picks the offer it will pay and before
the scheme signs anything. That is the only point where the price is known for certain.
Fetching a price separately and then paying means two independent negotiations that can
disagree about which offer is being bought, and `accepts` has no defined price ordering
that would make the first one safe to assume. Concurrent MCP tool calls are serialized
(`src/sessionCap.js`) so two payments cannot both pass the check before either is recorded.

This is an app-level approximation, not an on-chain guarantee. For a session budget with a
real on-chain guarantee (pre-authorized deposit, cumulative commitments, one settlement),
that is what MPP **Channel mode** is for rather than x402.

## Recipient lists

Recipient allow and block lists are the same guardrail shape as a contract allow-list on an
on-chain policy signer, applied at the app level because x402 on Stellar does not ship one
yet. The design thinking comes from [ArkivGate](https://arkivgate.vercel.app), a policy
gateway for paid AI-agent runtimes the author built independently. It was reimplemented here
for Stellar's client-side `PaymentPolicy` API, not ported.

## Replay and double-grant on the seller side

A signed x402 payment auth entry is valid until its `max_ledger` expiry, which bounds how
long it is valid, not whether it has already been redeemed. Research on x402 deployments
found resource servers that grant access repeatedly for a single settlement
([Five Attacks on x402, arXiv:2605.11781](https://arxiv.org/html/2605.11781v1)). This CLI is
the buyer side and does not control that. If you are building the seller, see the security
note in the [paywall kit](https://github.com/StevenMolina22/stellar-x402-paywall-kit).

## A settled payment does not tell you what it cost

A live `PAYMENT-RESPONSE` from OZ Channels decodes to `{success, payer, transaction,
network}` with no amount field, pinned by a live test in `test/e2e.test.js` so it fails
loudly if that changes. Anything reporting `settlement.amount` records `undefined` on every
payment, which is what this CLI's own audit log did until that test caught it. The price is
only reliably known from the offer the client selected, so `payUrl` returns `amountPaid`
from there.

## Facilitator settle dedup is unverified for Stellar

Whether OZ Channels' `/settle` deduplicates a retried submission of the same auth entry is
not documented anywhere we could find for the Stellar scheme. That is why the retry in
`src/resilientFetch.js` is scoped to the transport layer only (a dropped connection
mid-request) and never re-runs the payment flow. Retrying a delivery and signing a second
payment are different things.

## Dependency pinning

`@x402/*` is pinned to exact `2.20.0`, not a floating `^` range.
[GHSA-3j63-5h8p-gf7c](https://github.com/advisories/GHSA-3j63-5h8p-gf7c) affected the older
`x402`/`x402-express`/`x402-hono`/`x402-next` v1 packages, and
[GHSA-qr2g-p6q7-w82m](https://github.com/advisories/GHSA-qr2g-p6q7-w82m) hit `@x402/svm`
facilitators rather than Stellar's. Neither applies here directly, but both show this
protocol has had real facilitator-side vulnerabilities. Pin and watch advisories.
