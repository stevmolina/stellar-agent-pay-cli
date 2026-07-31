#!/usr/bin/env node
import { parseArgs } from "node:util";
import { payUrl, peekPaymentRequirements } from "../src/pay.js";
import { AgentPayConfigError } from "../src/errors.js";
import { baseUnitsToUsd } from "../src/money.js";
import { logPaymentEvent } from "../src/eventLog.js";

const HELP = `stellar-agent-pay <url> [options]

Completes the x402 402 -> pay -> unlock loop from the terminal, so any agent
or shell workflow can settle a paywall.

Options:
  --method <verb>     HTTP method (default: GET)
  --data <json>       Request body, sent as JSON (implies Content-Type: application/json)
  --header <K: V>     Extra request header. Repeatable.
  --max-price <usd>   Refuse to pay more than this (e.g. --max-price 0.01). Fails closed.
  --dry-run           Show the payment requirements without paying.
  --network <id>      CAIP-2 network id (default: STELLAR_NETWORK env or stellar:testnet)
  --secret <S...>     Stellar secret key (default: STELLAR_SECRET_KEY env)
  --json              Wrap stdout in a JSON envelope: { status, body, settlement }
  --log-file <path>   Append a JSONL payment-event line per attempt (audit trail)
  -h, --help          Show this help

Env vars: STELLAR_NETWORK, STELLAR_SECRET_KEY

Examples:
  stellar-agent-pay https://api.example.com/weather
  stellar-agent-pay https://api.example.com/weather --dry-run
  stellar-agent-pay https://api.example.com/weather --max-price 0.01
  stellar-agent-pay https://api.example.com/report --method POST --data '{"city":"BA"}'
  stellar-agent-pay https://api.example.com/weather --log-file ~/.stellar-agent-pay/payments.jsonl
`;

function parseHeaders(headerArgs) {
  const headers = {};
  for (const h of headerArgs) {
    const idx = h.indexOf(":");
    if (idx === -1) {
      throw new AgentPayConfigError(`Invalid --header "${h}", expected "Name: value".`);
    }
    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return headers;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      method: { type: "string", default: "GET" },
      data: { type: "string" },
      header: { type: "string", multiple: true, default: [] },
      "max-price": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      network: { type: "string" },
      secret: { type: "string" },
      json: { type: "boolean", default: false },
      "log-file": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const [url] = positionals;
  const headers = parseHeaders(values.header);
  if (values.data) headers["Content-Type"] ??= "application/json";

  const requestInit = {
    method: values.method,
    headers,
    body: values.data,
  };

  if (values["dry-run"]) {
    const { status, requirements } = await peekPaymentRequirements(url, requestInit);
    if (status !== 402) {
      process.stderr.write(`No payment required — server responded ${status}.\n`);
      process.exitCode = status >= 200 && status < 300 ? 0 : 2;
      return;
    }
    process.stdout.write(JSON.stringify(requirements, null, 2) + "\n");
    const accepts = requirements?.accepts ?? [];
    for (const a of accepts) {
      if (a?.maxAmountRequired) {
        process.stderr.write(`Would cost ${baseUnitsToUsd(a.maxAmountRequired)} on ${a.network} to ${a.payTo}\n`);
      }
    }
    return;
  }

  let response, settlement;
  try {
    ({ response, settlement } = await payUrl(url, {
      ...requestInit,
      network: values.network,
      secretKey: values.secret,
      maxPriceUsd: values["max-price"],
    }));
  } catch (err) {
    logPaymentEvent(values["log-file"], { url, method: values.method, paid: false, error: err.message });
    throw err;
  }

  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON, keep as text
  }

  if (settlement) {
    const tx = settlement.transaction ?? settlement.txHash ?? settlement.tx;
    process.stderr.write(`Paid. tx=${tx ?? "?"} network=${settlement.network ?? "?"}\n`);
  }

  logPaymentEvent(values["log-file"], {
    url,
    method: values.method,
    status: response.status,
    paid: Boolean(settlement),
    amount: settlement?.amount,
    network: settlement?.network,
    transaction: settlement?.transaction ?? settlement?.txHash ?? settlement?.tx,
  });

  if (values.json) {
    process.stdout.write(JSON.stringify({ status: response.status, body, settlement }, null, 2) + "\n");
  } else {
    process.stdout.write(typeof body === "string" ? body + "\n" : JSON.stringify(body, null, 2) + "\n");
  }

  process.exitCode = response.ok ? 0 : 2;
}

main().catch((err) => {
  if (err instanceof AgentPayConfigError) {
    process.stderr.write(`Config error: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`stellar-agent-pay failed: ${err.message}\n`);
  process.exitCode = 2;
});
