// The three MCP tool handlers, kept separate from the stdio transport wiring in
// mcp.js so they can be unit-tested. Importing mcp.js used to open a connection as
// a side effect of the import, which meant the session-cap logic (the subtlest code
// in this package) had no tests at all.
import { z } from "zod";
import { payUrl, peekPaymentRequirements, amountOf } from "./pay.js";
import { baseUnitsToUsd } from "./money.js";
import { SessionSpendCap } from "./sessionCap.js";
import { SessionCapGuard } from "./spendGuard.js";

/**
 * Parse a comma-separated address list from an env var.
 * @param {string|undefined} env
 */
export function parseAddressList(env) {
  return env
    ? env
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/**
 * Read the operator's policy out of the environment. Recipient allow/block-lists
 * are set once when the server is launched, not passed per call, so the agent
 * decides what to buy while the operator decides who may be paid.
 * @param {Record<string, string|undefined>} [env]
 */
export function configFromEnv(env = process.env) {
  return {
    sessionCapUsd: env.STELLAR_AGENT_PAY_SESSION_CAP_USD ?? null,
    allowRecipients: parseAddressList(env.STELLAR_AGENT_PAY_ALLOW_RECIPIENTS),
    blockRecipients: parseAddressList(env.STELLAR_AGENT_PAY_BLOCK_RECIPIENTS),
  };
}

/** @param {unknown} value */
const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/** @param {string} message */
const failure = (message) => ({ content: [{ type: "text", text: message }], isError: true });

/**
 * Register peek_paywall / pay_url / session_status on an MCP server.
 *
 * @param {{registerTool: Function}} server
 * @param {object} [options]
 * @param {string|number|null} [options.sessionCapUsd]
 * @param {string[]} [options.allowRecipients]
 * @param {string[]} [options.blockRecipients]
 * @param {typeof payUrl} [options.pay] - Injectable for tests.
 * @param {typeof peekPaymentRequirements} [options.peek] - Injectable for tests.
 */
export function registerTools(server, options = {}) {
  const {
    sessionCapUsd = null,
    allowRecipients = [],
    blockRecipients = [],
    pay = payUrl,
    peek = peekPaymentRequirements,
  } = options;

  // One cap for the whole process. Unlike the CLI (a fresh process per payment),
  // an MCP server is long-lived across a conversation, so it can track cumulative
  // spend. See sessionCap.js for why this is app-level and not a chain guarantee.
  const sessionCap = new SessionSpendCap(sessionCapUsd);

  server.registerTool(
    "peek_paywall",
    {
      title: "Inspect an x402 paywall without paying",
      description:
        "GETs a URL and, if it responds 402 Payment Required, returns the price/recipient/network without paying. Use before pay_url to let the agent decide whether the price is worth it.",
      inputSchema: { url: z.string().url() },
    },
    async (/** @type {{url: string}} */ { url }) => {
      const { status, requirements } = await peek(url);
      if (status !== 402) return text(`No payment required (status ${status}).`);
      const priced = (requirements?.accepts ?? []).map((a) => {
        const amount = amountOf(a);
        return { ...a, priceUsd: amount ? baseUnitsToUsd(amount) : undefined };
      });
      return text({ ...requirements, accepts: priced });
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
        maxPriceUsd: z
          .string()
          .optional()
          .describe('Refuse to pay more than this many USD for this one call, e.g. "0.01".'),
      },
    },
    async (/** @type {{url: string, method?: string, maxPriceUsd?: string}} */ { url, method, maxPriceUsd }) => {
      // The cap is enforced inside the payment flow, at the point where the client
      // has picked its offer and before it signs. That is why there is no separate
      // price peek here any more: peeking and paying were two independent
      // negotiations that could disagree about which offer was being bought.
      const guard = new SessionCapGuard(sessionCap);

      let response, settlement, amountPaid;
      try {
        ({ response, settlement, amountPaid } = await pay(url, {
          method,
          maxPriceUsd,
          allowRecipients,
          blockRecipients,
          onBeforePayment: guard.beforePayment,
          onPaymentFailure: guard.paymentFailure,
        }));
      } catch (err) {
        // A refusal is an expected outcome, not a crash. The client rewraps hook
        // errors, so the guard's own typed error is the one worth reporting.
        if (guard.lastError) return failure(guard.lastError.message);
        throw err;
      }

      const drift = await guard.reconcile(settlement);
      const body = await response.text();

      return text({
        status: response.status,
        body,
        settlement,
        // Read off the selected offer, since a real PAYMENT-RESPONSE has no amount.
        amountPaidUsd: amountPaid ? baseUnitsToUsd(amountPaid) : undefined,
        sessionSpentUsd: sessionCap.spentUsd(),
        ...(drift
          ? {
              warning:
                `Settled amount ${drift.settledUsd} did not match the ${drift.reservedUsd} reserved before signing; ` +
                `the session total has been corrected.`,
            }
          : {}),
      });
    }
  );

  server.registerTool(
    "session_status",
    {
      title: "Check the session spend cap",
      description:
        "Reports cumulative USD spent and remaining budget for this MCP session, if STELLAR_AGENT_PAY_SESSION_CAP_USD was set.",
      inputSchema: {},
    },
    async () => text({ spentUsd: sessionCap.spentUsd(), remainingUsd: sessionCap.remainingUsd() })
  );

  return { sessionCap };
}
