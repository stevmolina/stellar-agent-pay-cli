#!/usr/bin/env node
// Optional bonus: expose the same 402 -> pay -> unlock loop as an MCP tool, so an
// MCP-aware agent (Claude Code, etc.) can pay a paywall directly instead of shelling
// out to the CLI. Same core (src/pay.js) as bin/cli.js — this is just a second transport.
//
// Requires @modelcontextprotocol/sdk + zod (optionalDependencies) — install them to use this entry point.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { payUrl, peekPaymentRequirements, amountOf } from "./pay.js";
import { baseUnitsToUsd } from "./money.js";
import { SessionSpendCap, SessionCapExceededError } from "./sessionCap.js";

const server = new McpServer({ name: "stellar-agent-pay", version: "0.1.0" });

// Unlike the CLI (one process per payment), an MCP server is long-lived across
// many pay_url calls in one conversation — so it can track *cumulative* spend,
// not just cap each call individually. Set once at process start from the env;
// see sessionCap.js for why this is app-level, not a protocol guarantee.
const sessionCap = new SessionSpendCap(process.env.STELLAR_AGENT_PAY_SESSION_CAP_USD ?? null);

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
    const priced = (requirements?.accepts ?? []).map((a) => {
      const amount = amountOf(a);
      return { ...a, priceUsd: amount ? baseUnitsToUsd(amount) : undefined };
    });
    return { content: [{ type: "text", text: JSON.stringify({ ...requirements, accepts: priced }, null, 2) }] };
  }
);

server.registerTool(
  "pay_url",
  {
    title: "Pay an x402-gated URL",
    description:
      "Completes the x402 402 -> pay -> unlock loop on Stellar for the given URL and returns the unlocked response body. Requires STELLAR_SECRET_KEY in the environment. Set maxPriceUsd as a per-call safety cap; the process-wide session cap (STELLAR_AGENT_PAY_SESSION_CAP_USD) applies on top of that across all calls in this session.",
    inputSchema: {
      url: z.string().url(),
      method: z.string().optional(),
      maxPriceUsd: z.string().optional().describe("Refuse to pay more than this many USD for this one call, e.g. \"0.01\"."),
    },
  },
  async ({ url, method, maxPriceUsd }) => {
    // Peek the price first so we can check it against the session budget
    // *before* signing and submitting a payment, not after.
    const { status, requirements } = await peekPaymentRequirements(url, { method });
    let reserved = null;
    if (status === 402) {
      const cheapestOffer = (requirements?.accepts ?? [])[0];
      const offerAmount = cheapestOffer && amountOf(cheapestOffer);
      if (offerAmount) {
        reserved = BigInt(offerAmount);
        try {
          await sessionCap.reserve(reserved);
        } catch (err) {
          if (err instanceof SessionCapExceededError) {
            return { content: [{ type: "text", text: err.message }], isError: true };
          }
          throw err;
        }
      }
    }

    try {
      const { response, settlement } = await payUrl(url, { method, maxPriceUsd });
      const text = await response.text();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: response.status, body: text, settlement, sessionSpentUsd: sessionCap.spentUsd() },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      if (reserved != null) await sessionCap.release(reserved);
      throw err;
    }
  }
);

server.registerTool(
  "session_status",
  {
    title: "Check the session spend cap",
    description: "Reports cumulative USD spent and remaining budget for this MCP session, if STELLAR_AGENT_PAY_SESSION_CAP_USD was set.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { spentUsd: sessionCap.spentUsd(), remainingUsd: sessionCap.remainingUsd() },
          null,
          2
        ),
      },
    ],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
