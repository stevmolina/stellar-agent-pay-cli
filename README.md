# stellar-agent-pay-cli

A CLI that pays an [x402](https://github.com/x402-foundation/x402)-gated URL from the terminal: **402 → pay → unlock**, one command. Built for the GrantFox Stellar Builder Summit SP 2026 bounty — sub-lane 3B (CLI Plugins for Agents) — and pairs with [`stellar-x402-paywall-kit`](https://github.com/StevenMolina22/stellar-x402-paywall-kit) (sub-lane 3A) for a full end-to-end demo: gate a route with the kit, pay it with this CLI.

```bash
stellar-agent-pay https://api.example.com/weather
```

That's the whole interaction. Any agent or shell script that can run a binary can now pay for API access — no custody logic, no manual transaction building.

**Contents:** [Install](#install) · [Setup](#setup) · [Usage](#usage) · [Proof of work](#proof-of-work) · [Safety](#safety---max-price-and-session-caps) · [Demo pairing](#demo-pair-it-with-stellar-x402-paywall-kit) · [MCP tool](#mcp-tool-bonus) · [Testnet runbook](#testnet-runbook) · [Testing](#testing) · [Troubleshooting](#troubleshooting)

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

# Only pay a known-good recipient — fails closed if the server's payTo isn't on the list
stellar-agent-pay https://api.example.com/weather --allow-recipient GRECIPIENT...

# Never pay a specific recipient, even if the price/route otherwise looks fine
stellar-agent-pay https://api.example.com/weather --block-recipient GBADACTOR...
```

Settlement info (tx hash, network) goes to **stderr**; the response body goes to **stdout** — safe to pipe into `jq` or another agent step without noise:

```bash
stellar-agent-pay https://api.example.com/weather | jq .temp
```

Exit codes: `0` success, `1` config error (missing URL/secret/malformed flag), `2` payment or HTTP error (including "every offer exceeded --max-price").

## Proof of work

Real payments on Stellar testnet, made by this exact CLI against the sibling repo's example server — not mocked, not simulated. Verify any of them on [Stellar Expert](https://stellar.expert/explorer/testnet):

| tx hash | command |
|---|---|
| [`d8adef29...ee7e14fe`](https://stellar.expert/explorer/testnet/tx/d8adef2991af899cbf1009d06e8a428199f7b642ab65948c3fabbf70ee7e14fe) | `stellar-agent-pay http://localhost:3001/weather` |
| [`4b0524e7...cdab979b83`](https://stellar.expert/explorer/testnet/tx/4b0524e754703b99237558f94cc5b89e74e2e4ee3aa2d99d7b9527cdab979b83) | `stellar-agent-pay http://localhost:3001/weather --max-price 0.01` |
| [`3ee14d47...9fed611`](https://stellar.expert/explorer/testnet/tx/3ee14d47ee8ae5b3e4eb374ddb178f108d72e63c262244cce68a563fb9fed611) | `stellar-agent-pay http://localhost:3001/weather/premium` |
| [`bd0f08a6...27018d576`](https://stellar.expert/explorer/testnet/tx/bd0f08a604ca6cb38ebcde8c20c441523e5c750233a1ec87f3060d427018d576) | `stellar-agent-pay http://localhost:3001/weather --allow-recipient G...` |
| [`c5917913...e6f06cd8`](https://stellar.expert/explorer/testnet/tx/c59179133c0d32aa86780ce0b741edb9264ecc05b6effc13830d0ff7e6f06cd8) | `stellar-agent-pay http://localhost:3002/catalog --max-price 0.01` |
| [`8c2eca1e...c55d3333b`](https://stellar.expert/explorer/testnet/tx/8c2eca1ec298e5aa1a63057b5b83617d7e42b35166ff48ec2572459c55d3333b) | `stellar-agent-pay http://localhost:3002/reports/3 --max-price 0.01` |

## Safety: `--max-price` and session caps

x402 lets a server name its price per-request. For an unattended agent, that's a blank check unless something caps it. `--max-price` registers an [x402 client policy](https://github.com/x402-foundation/x402) that filters out any payment option above the cap *before* a payment is ever built — if nothing survives the filter, the request fails closed instead of silently paying whatever was asked.

The x402 "exact" scheme is intentionally one-shot/per-request; there's no protocol-native way to cap *cumulative* spend across many calls. The one-shot CLI can't track that (each invocation is a fresh process) — but the [MCP server](#mcp-tool-bonus) is long-lived across a whole agent session, so it adds `STELLAR_AGENT_PAY_SESSION_CAP_USD`: a running-total budget checked *before* each payment is signed, not after. Concurrent tool calls are serialized internally (`src/sessionCap.js`) so two simultaneous payments can't both pass the check before either is recorded — the same race a naive per-request-only cap is exposed to.

The cap is enforced from inside the payment flow, on the x402 client's `onBeforePaymentCreation` hook (`src/spendGuard.js`), which fires once the client has chosen which offer it will pay and before the scheme signs anything. That placement is the whole design: it is the only point where the price is known for certain. Checking a separately fetched price first, then paying, means two independent negotiations that can disagree about which offer is being bought, and `accepts` has no defined price ordering to make the first one safe to assume. Refusing here costs no transaction and no fee, and leaves nothing to roll back. This is an app-level approximation, not an atomic on-chain guarantee; for a session budget with a real on-chain guarantee (pre-authorized deposit, cumulative commitments, one settlement), that's what MPP **Channel mode** is for instead of x402 — see the `stellar-agentic-payments` skill.

### Recipient allow/block-lists

`--allow-recipient` / `--block-recipient` (both repeatable) filter by the server's `payTo` before a payment is ever built — a block-list entry always wins, so you can't allow-list your way past a known-bad address by mistake. This is the same guardrail shape as a contract/recipient allow-list on an on-chain policy signer, applied here at the app level since x402 on Stellar doesn't (yet) ship one. It extends design thinking from [ArkivGate](https://arkivgate.vercel.app) — a policy gateway for paid AI-agent runtimes the author built independently (x402 payment-intent review + wallet threat-intel + auditable evidence graph on Arkiv) — reimplemented fresh here for Stellar's client-side `PaymentPolicy` API, not ported code.

### Known gaps (documented, not hidden)

- **Replay / double-grant on the seller side**: a signed x402 payment auth entry is valid until its `max_ledger` expiration, which bounds *how long* it's valid, not whether it's been redeemed once already. Research on x402 deployments has found resource servers that grant access repeatedly for a single settlement when they don't track "this payment has already been claimed" ([Five Attacks on x402, arXiv:2605.11781](https://arxiv.org/html/2605.11781v1)). This CLI is the buyer side and doesn't control that — if you're building the seller, see the security note in [`stellar-x402-paywall-kit`](https://github.com/StevenMolina22/stellar-x402-paywall-kit)'s README.
- **A settled payment doesn't tell you what it cost**: a live `PAYMENT-RESPONSE` from OZ Channels decodes to `{success, payer, transaction, network}`, with no amount field (pinned by a live test in `test/e2e.test.js`, so it fails loudly if that ever changes). Anything reporting `settlement.amount` therefore records `undefined` on every payment, which is what this CLI's own audit log quietly did until it was caught by that test. The price is only reliably knowable from the offer the client selected, which is why `payUrl` returns `amountPaid` from there instead. If you build on this, don't trust a settlement to price itself.
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

`STELLAR_AGENT_PAY_ALLOW_RECIPIENTS` / `STELLAR_AGENT_PAY_BLOCK_RECIPIENTS` (comma-separated `G...` addresses) apply to every `pay_url` call automatically. These are deliberately **environment-set, not tool parameters** — the calling agent picks *what* to buy, but doesn't get to decide which recipient guardrails apply to it; that's the operator's call, made once at launch.

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
        "STELLAR_AGENT_PAY_SESSION_CAP_USD": "1.00",
        "STELLAR_AGENT_PAY_BLOCK_RECIPIENTS": "GBADACTOR1...,GBADACTOR2..."
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
npm test   # node --test, 55 offline tests: no network, no facilitator, no funded account
```

`test/e2e.test.js` adds 5 live tests that stand up a real paywall with the sibling [`stellar-x402-paywall-kit`](https://github.com/StevenMolina22/stellar-x402-paywall-kit) and pay it through this package's own `payUrl`, against the live OZ Channels testnet facilitator. They cover the happy path, a `--max-price` refusal, a cumulative session-cap refusal, and the amount actually charged. Running them needs the sibling repo checked out alongside this one plus a funded testnet payer:

```bash
OZ_API_KEY=... STELLAR_RECIPIENT=G... STELLAR_SECRET_KEY=S... npm test   # 60/60
```

Without either, those 5 skip and the suite stays green, so `npm test` never fails for someone who has neither.

The live tests deliberately live *here* rather than in the seller kit. The buyer is what they exercise, and an earlier arrangement where the kit owned the only live test meant that test rebuilt its own x402 client by hand and never touched this package's code at all. See [Proof of work](#proof-of-work) for transactions these produced.

## Troubleshooting

**Process crashes on exit with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (Windows)** — this was a real bug we hit and fixed: calling `process.exit()` immediately after creating the Ed25519 signer (native crypto bindings via `stellar-sdk`) could race a pending libuv handle on Windows. Fixed by using `process.exitCode` and letting the event loop drain naturally instead of forcing termination — if you see this from an older build, update.

## Dependency versions

Pinned to `@x402/*@2.20.0` (the v2 protocol family), not a floating `^` range in the lockfile — [GHSA-3j63-5h8p-gf7c](https://github.com/advisories/GHSA-3j63-5h8p-gf7c) affected the older, differently-named `x402`/`x402-express`/`x402-hono`/`x402-next` v1 packages (not `@x402/*`), and [GHSA-qr2g-p6q7-w82m](https://github.com/advisories/GHSA-qr2g-p6q7-w82m) hit `@x402/svm` facilitators, not Stellar's — neither applies directly here, but both are a reminder this protocol has had real facilitator-side vulnerabilities. Don't float `@x402/*` on `^` in production; pin and watch advisories.

## License

MIT
