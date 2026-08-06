<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

## Cursor Cloud specific instructions

This is a small Node.js **ESM** project (`"type": "module"`, Node 22+; `@x402/stellar` requires `node >=22`). The startup update script runs `npm install`, which installs the `devDependencies` (`express`, `@x402/express`, `@modelcontextprotocol/sdk`, `zod`) needed to run everything below.

- **No lint or build step exists.** `main`/`bin` point straight at source `.js` files — there is no bundler, transpiler, ESLint, or Prettier config. The only check is the test suite.
- **Test:** `npm test` (`node --test`) — offline, deterministic, needs no network, no funded account, no secrets. This is the primary verification command.
- **Two entry points, one core (`src/pay.js`):** `bin/cli.js` (the `stellar-agent-pay` CLI) and `src/mcp.js` (the `stellar-agent-pay-mcp` stdio MCP server exposing `peek_paywall`, `pay_url`, `session_status`). See `README.md` for full flags/usage.
- **What runs without secrets:** CLI `--dry-run` and MCP `peek_paywall` only *inspect* a 402 challenge, so they work against any x402 endpoint with no key. The `--max-price` / `--allow-recipient` / `--block-recipient` guardrails are client-side policy filters that also run with no funds (they fail closed with exit 2 when everything is filtered out).
- **What actually paying requires (gotcha):** a real `402 → pay → unlock` settlement needs `STELLAR_SECRET_KEY` for a testnet Stellar account that is funded, has a USDC trustline, and holds USDC — and the client reaches live Stellar RPC (`soroban-testnet.stellar.org`) to build/simulate the payment. The testnet USDC faucet ([faucet.circle.com](https://faucet.circle.com/)) is web-only, so a fully-settled payment cannot be exercised in CI or without a user-provided funded secret. See the README "Testnet runbook".
- **Testing the flow locally without a facilitator:** the `@x402/express` + `express` devDependencies let you stand up a throwaway paywall that emits a base64 `PAYMENT-REQUIRED` header (`encodePaymentRequiredHeader` from `@x402/core/http`) to point the CLI/MCP at. ESM ignores `NODE_PATH`, so run such a script from inside the repo so it resolves `node_modules`.
- Runtime `*.jsonl` audit logs (from `--log-file`) and `.env` are git-ignored; never commit real payment records.
