---
type: Interface Reference
title: CLI and MCP interfaces
description: Documents the shell CLI and stdio MCP server that expose the shared Stellar x402 payment workflow to scripts and agents.
resource: /bin/cli.js
tags: [interfaces, cli, mcp, agents, x402]
---

# CLI and MCP interfaces

The repository presents one [payment flow](../architecture/payment-flow.md) through two transports. `bin/cli.js` serves shell scripts and command runners; `src/mcp.js` serves MCP clients over stdio. They share `payUrl`, `peekPaymentRequirements`, and `amountOf`, so price inspection and signed-payment behavior stay centralized.

## CLI: `stellar-agent-pay`

The package's `bin` map exposes `bin/cli.js` as `stellar-agent-pay` (`package.json`). It accepts a URL positional plus:

| Option | Behavior |
| --- | --- |
| `--method <verb>` | HTTP method; default `GET`. |
| `--data <json>` | Request body; sets `Content-Type: application/json` unless supplied as an extra header. |
| `--header <K: V>` | Repeatable header; malformed values raise a configuration error. |
| `--dry-run` | Calls `peekPaymentRequirements`; prints the returned requirements to stdout and human price/recipient details to stderr. No payment is made. |
| `--max-price <usd>` | Sends a per-request price policy to the [payment flow](../architecture/payment-flow.md); no surviving offer means the request fails closed. |
| `--network`, `--secret` | Override environment-derived network and secret for that invocation. |
| `--json` | Emits `{ status, body, settlement }` as stdout JSON instead of the response body alone. |
| `--log-file <path>` | Appends one JSONL event per completed attempt or payment-flow exception. |

On ordinary execution, the response body is stdout and settlement status is stderr; do not blur this contract because output is intended to be piped. Successful HTTP responses exit `0`; malformed configuration exits `1`; payment or HTTP errors exit `2`. The implementation assigns `process.exitCode` rather than calling `process.exit()`, avoiding an observed shutdown race with native crypto bindings.

The CLI's `--max-price` is one request's offer filter only. It cannot aggregate spend across separate process invocations; use the MCP interface's session cap when the agent remains in one long-lived process.

## MCP: `stellar-agent-pay-mcp`

`src/mcp.js` is the `stellar-agent-pay-mcp` executable. It starts `McpServer` with `StdioServerTransport` and requires the optional MCP SDK plus Zod validation dependencies. It registers:

| Tool | Inputs | Result / effect |
| --- | --- | --- |
| `peek_paywall` | `url` (URL) | Inspects an endpoint without paying. A 402 response is returned as decoded requirements; accepted offers gain `priceUsd`. |
| `pay_url` | `url` (URL); optional `method`, `maxPriceUsd` | Inspects first, reserves the offered price against the session budget when possible, then calls `payUrl` and returns `{ status, body, settlement, sessionSpentUsd }`. |
| `session_status` | none | Returns spent and remaining session budget. |

`pay_url` makes its preflight inspection before it invokes the shared flow, so it can reserve an amount before signing. It relies on [Safety and observability](../architecture/safety-and-observability.md) for serialized reservations and releases the reservation if `payUrl` throws. The first offer in `requirements.accepts` is used as the reservation amount; maintainers changing offer selection need to align the reservation choice with the paid offer selected by x402.

## Configuration boundaries

- `STELLAR_SECRET_KEY` is required only when a paid fetch must be created. Do not put its value in MCP configuration committed to the repository.
- `STELLAR_NETWORK` defaults to `stellar:testnet` in the shared core.
- `STELLAR_AGENT_PAY_SESSION_CAP_USD` is read once when the MCP process starts. Changing the environment later does not alter that process's existing cap.
- The CLI's `--secret` provides a command-line override, but using an environment variable generally avoids exposing a secret in process listings or shell history.

## Change guide

When adding an interface option or tool parameter, trace it through input validation, `RequestInit` construction, [payment-flow](../architecture/payment-flow.md) options, stdout/stderr or MCP response shape, and tests. Keep the core transport-neutral; logic that merely formats output belongs in the CLI or MCP layer.
