---
type: Project Guide
title: stellar-agent-pay-cli quickstart
description: Entry point for maintaining the Node.js CLI and MCP server that pay Stellar x402-gated HTTP resources with bounded, agent-oriented controls.
resource: /README.md
tags: [nodejs, stellar, x402, payments, cli, mcp]
---

# stellar-agent-pay-cli

`stellar-agent-pay-cli` is a small Node.js client for an x402-protected HTTP resource: request it, receive an HTTP 402 challenge, authorize a Stellar exact-scheme payment, and receive the unlocked response. It is designed for unattended shell workflows and MCP-aware agents rather than for wallet custody or manual transaction construction.

The product has two front doors that share one implementation: the [`stellar-agent-pay` CLI](interfaces/cli-and-mcp.md) and a stdio MCP server. Both route through the [payment flow](architecture/payment-flow.md); the MCP process additionally uses the [safety and observability controls](architecture/safety-and-observability.md) to bound cumulative session spend.

## Start here

1. Install dependencies or the published package as described in [`README.md`](../README.md). The package exposes `stellar-agent-pay` and `stellar-agent-pay-mcp` binaries (`package.json`).
2. Configure `STELLAR_SECRET_KEY` with a funded Stellar account and, if needed, `STELLAR_NETWORK`; the runtime defaults to `stellar:testnet` when no network is supplied (`src/pay.js`). Keep secrets out of repository files and logs.
3. Inspect a protected endpoint before paying:

   ```bash
   stellar-agent-pay https://api.example.com/weather --dry-run
   ```

4. For unattended requests, use `--max-price <USD>` to filter offers before a payment is built. For a long-lived MCP process, optionally set `STELLAR_AGENT_PAY_SESSION_CAP_USD` as well.
5. Run `npm test` after changes. The checked-in suite is Node's built-in test runner and covers monetary conversion, price-policy handling, configuration validation, and session-cap concurrency.

## Documentation map

- [Payment flow](architecture/payment-flow.md) — shared library behavior, x402 headers, Stellar signer/network configuration, price filtering, and retry boundary.
- [CLI and MCP interfaces](interfaces/cli-and-mcp.md) — argument/output contracts, MCP tools, and how each interface calls the shared core.
- [Safety and observability](architecture/safety-and-observability.md) — spend controls, reservation serialization, JSONL audit events, duplicate-payment risks, and high-risk change guidance.

## Repository map

| Area | Role |
| --- | --- |
| `src/pay.js` | Canonical library for challenge inspection, paid fetch construction, and the 402 → pay → unlock flow. |
| `bin/cli.js` | Shell argument parsing, stream/output conventions, exit codes, and optional audit logging. |
| `src/mcp.js` | Stdio MCP server exposing `peek_paywall`, `pay_url`, and `session_status`. |
| `src/sessionCap.js`, `src/resilientFetch.js`, `src/eventLog.js` | Safety and operational support around the core payment flow. |
| `src/money.js`, `src/errors.js` | USDC amount conversion and configuration-error type. |
| `test/` | Offline unit tests; no live facilitator is required by checked-in tests. |
| `.github/workflows/openwiki-update.yml` | Daily/manual OpenWiki regeneration workflow; it creates a documentation PR. |

## Working conventions

- Preserve the separation between **stdout response data** and **stderr diagnostics** in the CLI. Pipelines and agents depend on it (`bin/cli.js`).
- Treat `PaymentRequirements.amount` as the client-side wire-format price. `maxAmountRequired` remains only a defensive fallback because it names a different server-side SDK type; this caused a real cap/dry-run/session-reservation regression fixed in recent history.
- Do not move retry logic around the whole payment flow. Retrying only the underlying transport is intentional because a business-level retry could create a new authorization.
- Runtime JSONL audit files are ignored by Git (`.gitignore`); do not add real payment records to source control.
- The `.github/`, `AGENTS.md`, and `CLAUDE.md` files are currently untracked local OpenWiki automation/instruction additions according to the supplied Git status. This initial wiki does not modify them.

## Verification status

The intended verification command is `npm test`. It could not be executed during this documentation run because the sandbox does not have `npm` installed (`npm: command not found`); source-level test coverage was inspected instead.

## Backlog

- **README E2E-test reference** — `README.md` mentions `test/e2e.test.js`, but no such checked-in file appears under `test/`; defer reconciliation until a live-facilitator test is added or the README is corrected.
