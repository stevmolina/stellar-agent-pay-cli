# stellar-agent-pay-cli

[![npm version](https://img.shields.io/npm/v/stellar-agent-pay-cli.svg)](https://www.npmjs.com/package/stellar-agent-pay-cli)
[![license](https://img.shields.io/npm/l/stellar-agent-pay-cli.svg)](LICENSE)
[![node](https://img.shields.io/node/v/stellar-agent-pay-cli.svg)](https://nodejs.org)
[![site](https://img.shields.io/badge/site-stellar--agent--pay--cli.vercel.app-FF6C4C)](https://stellar-agent-pay-cli.vercel.app)

Pay an [x402](https://github.com/x402-foundation/x402)-gated URL from the terminal. One command does the whole loop: **402, pay, unlock**.

```bash
stellar-agent-pay https://api.example.com/weather
```

Any agent or shell script that can run a binary can pay for API access. No custody logic, no manual transaction building.

Built for the GrantFox Stellar Builder Summit SP 2026 bounty, sub-lane 3B (CLI Plugins for Agents). It pairs with [`stellar-x402-paywall-kit`](https://github.com/StevenMolina22/stellar-x402-paywall-kit) (sub-lane 3A): gate a route with the kit, pay it with this CLI.

**Contents:** [Install](#install) · [Setup](#setup) · [Usage](#usage) · [Safety](#safety) · [MCP tool](#mcp-tool) · [Demo](#demo-pair-it-with-the-paywall-kit) · [Testnet runbook](#testnet-runbook) · [Testing](#testing) · [Proof of work](#proof-of-work) · [Troubleshooting](#troubleshooting)

## Install

Requires Node.js 20 or newer.

```bash
npm install -g stellar-agent-pay-cli
```

Or from source:

```bash
git clone https://github.com/StevenMolina22/stellar-agent-pay-cli.git
cd stellar-agent-pay-cli && npm install && npm link
```

## Setup

Two environment variables:

```bash
export STELLAR_NETWORK=stellar:testnet
export STELLAR_SECRET_KEY=S...   # needs a funded USDC balance, see the testnet runbook
```

Both can be overridden per call with `--network` and `--secret`.

## Usage

```bash
# Pay and print the unlocked response body
stellar-agent-pay https://api.example.com/weather

# See what it would cost, without paying
stellar-agent-pay https://api.example.com/weather --dry-run

# Refuse to pay more than $0.01
stellar-agent-pay https://api.example.com/weather --max-price 0.01

# POST with a body, and keep an audit trail
stellar-agent-pay https://api.example.com/report --method POST --data '{"city":"BA"}' \
  --log-file ~/.stellar-agent-pay/payments.jsonl
```

### Options

| Flag | What it does |
|---|---|
| `--method <verb>` | HTTP method. Default `GET`. |
| `--data <json>` | Request body, sent as JSON. Sets `Content-Type: application/json`. |
| `--header <K: V>` | Extra request header. Repeatable. |
| `--max-price <usd>` | Refuse to pay more than this. Fails closed. |
| `--allow-recipient <G...>` | Only pay this recipient. Repeatable. Fails closed if none match. |
| `--block-recipient <G...>` | Never pay this recipient, even if otherwise valid. Repeatable. |
| `--dry-run` | Show the payment requirements without paying. |
| `--network <id>` | CAIP-2 network id. Default `STELLAR_NETWORK` or `stellar:testnet`. |
| `--secret <S...>` | Stellar secret key. Default `STELLAR_SECRET_KEY`. |
| `--json` | Wrap stdout as `{ status, body, settlement }`. |
| `--log-file <path>` | Append one JSONL payment-event line per attempt. |
| `-h`, `--help` | Show help. |

Each `--log-file` line records timestamp, url, method, status, amount in base units and USD, network, payer and transaction hash. The parent directory is created if missing.

### Output and exit codes

The response body goes to **stdout**. Settlement info (amount, transaction hash, network) goes to **stderr**, so piping stays clean:

```bash
stellar-agent-pay https://api.example.com/weather | jq .temp
```

| Code | Meaning |
|---|---|
| `0` | Payment succeeded and the server returned 2xx, or any `--dry-run` that reached the server |
| `1` | Config error: missing URL, missing secret key, malformed flag |
| `2` | Payment or HTTP error, including "every offer exceeded `--max-price`" |

## Safety

x402 lets the server name its price per request. For an unattended agent that is a blank check, so this CLI ships three guardrails. All are checked **before** anything is signed, so a refusal costs no transaction and no fee.

- **`--max-price <usd>`** caps what a single call may pay. Offers above the cap are filtered out. If nothing survives, the request fails instead of paying whatever was asked.
- **`--allow-recipient` and `--block-recipient`** filter on the server's `payTo` address. A block-list entry always wins, so you cannot allow-list your way past a known-bad address by mistake.
- **`STELLAR_AGENT_PAY_SESSION_CAP_USD`** caps cumulative spend across a whole [MCP](#mcp-tool) session. The one-shot CLI cannot do this because each run is a fresh process. The long-lived MCP server can.

Where each check sits, what it approximates, and what it does not cover: [docs/design-notes.md](docs/design-notes.md).

## MCP tool

For MCP-aware agents (Claude Code and similar), the same logic is exposed as three tools instead of shelling out to the CLI.

| Tool | Purpose | Parameters |
|---|---|---|
| `peek_paywall` | Inspect the price without paying | `url` (required) |
| `pay_url` | Pay and return the unlocked resource | `url` (required), `method` (default `GET`), `maxPriceUsd` (e.g. `"0.01"`) |
| `session_status` | Report spend so far and remaining budget | none |

Install the optional peer dependencies, then register the server:

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

`STELLAR_AGENT_PAY_ALLOW_RECIPIENTS` and `STELLAR_AGENT_PAY_BLOCK_RECIPIENTS` take comma-separated `G...` addresses and apply to every `pay_url` call. They are environment variables on purpose, not tool parameters: the agent picks what to buy, the operator decides which guardrails apply.

## Demo: pair it with the paywall kit

```bash
cd stellar-x402-paywall-kit/examples/express-app && npm start   # terminal 1
stellar-agent-pay http://localhost:3001/weather                 # terminal 2
```

For a longer demo where an agent shops across price tiers on a budget, see the kit's `examples/agent-catalog`.

## Testnet runbook

1. Generate a payer keypair and fund it with XLM:
   ```bash
   node -e "const {Keypair}=require('@stellar/stellar-sdk'); const k=Keypair.random(); console.log(k.publicKey(), k.secret())"
   curl "https://friendbot.stellar.org?addr=<G...>"
   ```
2. Add a USDC trustline. `stellar-x402-paywall-kit/scripts/setup-testnet.mjs` sets up both sides of the demo.
3. Fund it with testnet USDC at [faucet.circle.com](https://faucet.circle.com/). Stellar testnet, web only, cannot be scripted.
4. Export the keys from step 1:
   ```bash
   export STELLAR_SECRET_KEY=S...
   export STELLAR_NETWORK=stellar:testnet
   ```

## Testing

```bash
npm test   # 55 offline tests: no network, no facilitator, no funded account
```

`test/e2e.test.js` adds 5 live tests that stand up a real paywall with the sibling kit and pay it through this package's own `payUrl`, against the live OZ Channels testnet facilitator. They cover the happy path, a `--max-price` refusal, a session-cap refusal, the amount actually charged, and the shape of a real settlement. With a funded testnet payer:

```bash
OZ_API_KEY=... STELLAR_RECIPIENT=G... STELLAR_SECRET_KEY=S... npm test   # 60/60
```

Without those credentials the 5 live tests skip, so `npm test` never fails for someone without an account. They live here rather than in the seller kit because the buyer is what they exercise.

## Proof of work

Real payments on Stellar testnet, made by this CLI against the sibling repo's example servers. Not mocked, not simulated. Verify any of them on [Stellar Expert](https://stellar.expert/explorer/testnet):

| tx hash | command |
|---|---|
| [`d8adef29...ee7e14fe`](https://stellar.expert/explorer/testnet/tx/d8adef2991af899cbf1009d06e8a428199f7b642ab65948c3fabbf70ee7e14fe) | `stellar-agent-pay http://localhost:3001/weather` |
| [`4b0524e7...cdab979b83`](https://stellar.expert/explorer/testnet/tx/4b0524e754703b99237558f94cc5b89e74e2e4ee3aa2d99d7b9527cdab979b83) | `stellar-agent-pay http://localhost:3001/weather --max-price 0.01` |
| [`3ee14d47...9fed611`](https://stellar.expert/explorer/testnet/tx/3ee14d47ee8ae5b3e4eb374ddb178f108d72e63c262244cce68a563fb9fed611) | `stellar-agent-pay http://localhost:3001/weather/premium` |
| [`bd0f08a6...27018d576`](https://stellar.expert/explorer/testnet/tx/bd0f08a604ca6cb38ebcde8c20c441523e5c750233a1ec87f3060d427018d576) | `stellar-agent-pay http://localhost:3001/weather --allow-recipient G...` |
| [`c5917913...e6f06cd8`](https://stellar.expert/explorer/testnet/tx/c59179133c0d32aa86780ce0b741edb9264ecc05b6effc13830d0ff7e6f06cd8) | `stellar-agent-pay http://localhost:3002/catalog --max-price 0.01` |
| [`8c2eca1e...c55d3333b`](https://stellar.expert/explorer/testnet/tx/8c2eca1ec298e5aa1a63057b5b83617d7e42b35166ff48ec2572459c55d3333b) | `stellar-agent-pay http://localhost:3002/reports/3 --max-price 0.01` |

## Troubleshooting

**`Config error: ...`** (exit 1) is a missing URL, a missing secret key, or a malformed flag. Check that `STELLAR_SECRET_KEY` is exported.

**Insufficient balance or trustline error.** The payer needs both a USDC trustline and a funded USDC balance. Walk the [testnet runbook](#testnet-runbook) again. The Circle faucet step is the one most often missed.

**Every offer exceeded `--max-price`** (exit 2) is working as intended. Run `--dry-run` to see what the server is asking.

**Crash on exit with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (Windows).** A real bug, already fixed: calling `process.exit()` right after creating the Ed25519 signer could race a pending libuv handle. The fix uses `process.exitCode` and lets the event loop drain. If you see it, update.

## License

MIT
