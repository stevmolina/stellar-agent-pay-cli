#!/usr/bin/env node
// Optional bonus: expose the same 402 -> pay -> unlock loop as an MCP tool, so an
// MCP-aware agent (Claude Code, etc.) can pay a paywall directly instead of shelling
// out to the CLI. Same core (src/pay.js) as bin/cli.js — this is just a second transport.
//
// Requires @modelcontextprotocol/sdk + zod (optionalDependencies) — install them to use this entry point.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { payUrl, peekPaymentRequirements } from "./pay.js";
import { baseUnitsToUsd } from "./money.js";

const server = new McpServer({ name: "stellar-agent-pay", version: "0.1.0" });

server.registerTool(
  "peek_paywall",
  {
    title: "Inspect an x402 paywall without paying",
    description:
      "GETs a URL and, if it responds 402 Payment Required, returns the price/recipient/network without paying. Use before pay_url to let the agent decide whether the price is worth it.",
    inputSchema: {
      url: z.string().url(),
    },
  },
  async ({ url }) => {
    const { status, requirements } = await peekPaymentRequirements(url);
    if (status !== 402) {
      return { content: [{ type: "text", text: `No payment required (status ${status}).` }] };
    }
    const priced = (requirements?.accepts ?? []).map((a) => ({
      ...a,
      priceUsd: a.maxAmountRequired ? baseUnitsToUsd(a.maxAmountRequired) : undefined,
    }));
    return { content: [{ type: "text", text: JSON.stringify({ ...requirements, accepts: priced }, null, 2) }] };
  }
);

server.registerTool(
  "pay_url",
  {
    title: "Pay an x402-gated URL",
    description:
      "Completes the x402 402 -> pay -> unlock loop on Stellar for the given URL and returns the unlocked response body. Requires STELLAR_SECRET_KEY in the environment. Set maxPriceUsd as a safety cap.",
    inputSchema: {
      url: z.string().url(),
      method: z.string().optional(),
      maxPriceUsd: z.string().optional().describe("Refuse to pay more than this many USD, e.g. \"0.01\"."),
    },
  },
  async ({ url, method, maxPriceUsd }) => {
    const { response, settlement } = await payUrl(url, { method, maxPriceUsd });
    const text = await response.text();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: response.status, body: text, settlement }, null, 2),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
