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
```

Settlement info (tx hash, network) goes to **stderr**; the response body goes to **stdout** — safe to pipe into `jq` or another agent step without noise:

```bash
stellar-agent-pay https://api.example.com/weather | jq .temp
```

Exit codes: `0` success, `1` config error (missing URL/secret/malformed flag), `2` payment or HTTP error (including "every offer exceeded --max-price").

## Safety: `--max-price`

x402 lets a server name its price per-request. For an unattended agent, that's a blank check unless something caps it. `--max-price` registers an [x402 client policy](https://github.com/x402-foundation/x402) that filters out any payment option above the cap *before* a payment is ever built — if nothing survives the filter, the request fails closed instead of silently paying whatever was asked.

## Demo: pair it with `stellar-x402-paywall-kit`

```bash
# Terminal 1 — gate a route (see stellar-x402-paywall-kit/examples/express-app)
cd stellar-x402-paywall-kit/examples/express-app && npm start

# Terminal 2 — pay it
stellar-agent-pay http://localhost:3001/weather
```

## MCP tool (bonus)

For MCP-aware agents (Claude Code, etc.), the same logic is exposed as two MCP tools — `peek_paywall` (inspect without paying) and `pay_url` (pay and return the resource) — instead of shelling out to the CLI:

```bash
npm install stellar-agent-pay-cli @modelcontextprotocol/sdk zod
```

```json
{
  "mcpServers": {
    "stellar-agent-pay": {
      "command": "stellar-agent-pay-mcp",
      "env": { "STELLAR_NETWORK": "stellar:testnet", "STELLAR_SECRET_KEY": "S..." }
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

## License

MIT
