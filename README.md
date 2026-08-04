# stellar-agent-pay-cli

A CLI that pays an [x402](https://github.com/x402-foundation/x402)-gated URL from the terminal: **402 → pay → unlock**, one command. Built for the GrantFox Stellar Builder Summit SP 2026 bounty — sub-lane 3B (CLI Plugins for Agents) — and pairs with [`stellar-x402-paywall-kit`](https://github.com/leocagli/stellar-x402-paywall-kit) (sub-lane 3A) for a full end-to-end demo: gate a route with the kit, pay it with this CLI.

```bash
stellar-agent-pay https://api.example.com/weather
```

That's the whole interaction. Any agent or shell script that can run a binary can now pay for API access — no custody logic, no manual transaction building.

## Install

```bash
npm install -g stellar-agent-pay-cli
```

## Setup

```
export STELLAR_NETWORK=stellar:testnet
export STELLAR_SECRET_KEY=S...    # needs a funded USDC balance — see testnet runbook below
```

## Usage

```bash
# Pay and print the unlocked response body (stdout is clean — pipe it anywhere)
stellar-agent-pay https://api.example.com/weather

# See what it would cost, without paying
stellar-agent-pay https://api.example.com/weather --dry-run

# Refuse to pay more than $0.01 — fails closed if every offer exceeds the cap
stellar-agent-pay https://api.example.com/weather --max-price 0.01

# POST with a body
stellar-agent-pay https://api.example.com/report --method POST --data '{"city":"BA"}'

# Extra headers, JSON envelope on stdout (status + body + settlement)
stellar-agent-pay https://api.example.com/weather --header "X-Trace: 1" --json

# Structured JSONL audit trail — one line per attempt, timestamp/url/status/amount/tx
stellar-agent-pay https://api.example.com/weather --log-file ~/.stellar-agent-pay/payments.jsonl
```

Settlement info (tx hash, network) goes to **stderr**; the response body goes to **stdout** — safe to pipe into `jq` or another agent step without noise:

```bash
stellar-agent-pay https://api.example.com/weather | jq .temp
```

Exit codes: `0` success, `1` config error (missing URL/secret/malformed flag), `2` payment or HTTP error (including "every offer exceeded --max-price").

## Safety: `--max-price` and session caps

x402 lets a server name its price per-request. For an unattended agent, that's a blank check unless something caps it. `--max-price` registers an [x402 client policy](https://github.com/x402-foundation/x402) that filters out any payment option above the cap *before* a payment is ever built — if nothing survives the filter, the request fails closed instead of silently paying whatever was asked.

The x402 "exact" scheme is intentionally one-shot/per-request; there's no protocol-native way to cap *cumulative* spend across many calls. The one-shot CLI can't track that (each invocation is a fresh process) — but the [MCP server](#mcp-tool-bonus) is long-lived across a whole agent session, so it adds `STELLAR_AGENT_PAY_SESSION_CAP_USD`: a running-total budget checked *before* each payment is signed, not after. Concurrent tool calls are serialized internally (`src/sessionCap.js`) so two simultaneous payments can't both pass the check before either is recorded — the same race a naive per-request-only cap is exposed to. This is an app-level approximation, not an atomic on-chain guarantee; for a session budget with a real on-chain guarantee (pre-authorized deposit, cumulative commitments, one settlement), that's what MPP **Channel mode** is for instead of x402 — see the `stellar-agentic-payments` skill.

### Known gaps (documented, not hidden)

- **Replay / double-grant on the seller side**: a signed x402 payment auth entry is valid until its `max_ledger` expiration, which bounds *how long* it's valid, not whether it's been redeemed once already. Research on x402 deployments has found resource servers that grant access repeatedly for a single settlement when they don't track "this payment has already been claimed" ([Five Attacks on x402, arXiv:2605.11781](https://arxiv.org/html/2605.11781v1)). This CLI is the buyer side and doesn't control that — if you're building the seller, see the security note in [`stellar-x402-paywall-kit`](https://github.com/leocagli/stellar-x402-paywall-kit)'s README.
- **Facilitator settle dedup is unverified for Stellar**: whether OZ Channels' `/settle` endpoint deduplicates a retried submission of the same auth entry isn't documented anywhere we could find for the Stellar scheme. This is why this CLI's own retry (`src/resilientFetch.js`) is scoped to the *transport* layer only (retrying a dropped connection mid-request), never to re-running the whole payment flow — that distinction is the difference between "retry a delivery" and "sign and submit a second payment."

## Demo: pair it with `stellar-x402-paywall-kit`

```bash
# Terminal 1 — gate a route (see stellar-x402-paywall-kit/examples/express-app)
cd stellar-x402-paywall-kit/examples/express-app && npm start

# Terminal 2 — pay it
stellar-agent-pay http://localhost:3001/weather
```

## MCP tool (bonus)

For MCP-aware agents (Claude Code, etc.), the same logic is exposed as three MCP tools instead of shelling out to the CLI.

#### `peek_paywall`

Inspect the price of a 402-gated URL without paying.

| Parameter | Type   | Description                  |
|-----------|--------|-------------------------------|
| `url`     | string | The URL to inspect (required) |

#### `pay_url`

Pay a 402-gated URL and return the unlocked resource. Checks the session cap (below) before signing, not after.

| Parameter     | Type   | Description                                                  |
|---------------|--------|----------------------------------------------------------------|
| `url`         | string | The URL to pay for (required)                                  |
| `method`      | string | HTTP method (optional, default `GET`)                          |
| `maxPriceUsd` | string | Refuse to pay more than this many USD for this one call (optional, e.g. `"0.01"`) |

#### `session_status`

Report cumulative spend and remaining budget for this MCP session. No parameters.

Set `STELLAR_AGENT_PAY_SESSION_CAP_USD` to cap *cumulative* spend across the whole MCP session (see [Safety](#safety---max-price-and-session-caps) above) — this is the one thing the one-shot CLI structurally can't do.

```bash
npm install stellar-agent-pay-cli @modelcontextprotocol/sdk zod
```

```json
{
  "mcpServers": {
    "stellar-agent-pay": {
      "command": "stellar-agent-pay-mcp",
      "env": {
        "STELLAR_NETWORK": "stellar:testnet",
        "STELLAR_SECRET_KEY": "S...",
        "STELLAR_AGENT_PAY_SESSION_CAP_USD": "1.00"
      }
    }
  }
}
```

## Testnet runbook

1. Generate a payer keypair and fund it:
   ```bash
   node -e "const {Keypair}=require('@stellar/stellar-sdk'); const k=Keypair.random(); console.log(k.publicKey(), k.secret())"
   curl "https://friendbot.stellar.org?addr=<G...>"
   ```
2. Add a USDC trustline to it (see `stellar-x402-paywall-kit/scripts/setup-testnet.mjs` — the same script sets up both sides of a demo).
3. Fund it with testnet USDC: [faucet.circle.com](https://faucet.circle.com/) (Stellar testnet, web-only, can't be scripted).
4. `export STELLAR_SECRET_KEY=<the S... from step 1>`, `export STELLAR_NETWORK=stellar:testnet`.

## Testing

```bash
npm test   # node --test — no network calls, no live facilitator or funded account needed
```

`test/e2e.test.js` runs a *real* payment against the OZ Channels testnet facilitator instead of a mock — it's skipped automatically unless `OZ_API_KEY` + a funded `STELLAR_SECRET_KEY`/recipient are set, so it never breaks `npm test` for anyone without a funded account.

## Troubleshooting

**Process crashes on exit with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (Windows)** — this was a real bug we hit and fixed: calling `process.exit()` immediately after creating the Ed25519 signer (native crypto bindings via `stellar-sdk`) could race a pending libuv handle on Windows. Fixed by using `process.exitCode` and letting the event loop drain naturally instead of forcing termination — if you see this from an older build, update.

## Dependency versions

Pinned to `@x402/*@2.20.0` (the v2 protocol family), not a floating `^` range in the lockfile — [GHSA-3j63-5h8p-gf7c](https://github.com/advisories/GHSA-3j63-5h8p-gf7c) affected the older, differently-named `x402`/`x402-express`/`x402-hono`/`x402-next` v1 packages (not `@x402/*`), and [GHSA-qr2g-p6q7-w82m](https://github.com/advisories/GHSA-qr2g-p6q7-w82m) hit `@x402/svm` facilitators, not Stellar's — neither applies directly here, but both are a reminder this protocol has had real facilitator-side vulnerabilities. Don't float `@x402/*` on `^` in production; pin and watch advisories.

## License

MIT
