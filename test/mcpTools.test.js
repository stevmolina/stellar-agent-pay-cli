import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTools, parseAddressList, configFromEnv } from "../src/mcpTools.js";
import { SessionCapExceededError } from "../src/sessionCap.js";

// Minimal stand-in for McpServer: collects handlers so they can be called directly.
function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool: (name, _spec, handler) => tools.set(name, handler),
    call: (name, args = {}) => tools.get(name)(args),
  };
}

const okResponse = (body = '{"ok":true}', status = 200) => ({
  status,
  text: async () => body,
});

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

test("registers all three tools", () => {
  const server = fakeServer();
  registerTools(server, {});
  assert.deepEqual([...server.tools.keys()], ["peek_paywall", "pay_url", "session_status"]);
});

test("parseAddressList splits, trims and drops blanks", () => {
  assert.deepEqual(parseAddressList("GAAA, GBBB ,,GCCC"), ["GAAA", "GBBB", "GCCC"]);
  assert.deepEqual(parseAddressList(""), []);
  assert.deepEqual(parseAddressList(undefined), []);
});

test("configFromEnv reads the operator policy", () => {
  const config = configFromEnv({
    STELLAR_AGENT_PAY_SESSION_CAP_USD: "0.02",
    STELLAR_AGENT_PAY_ALLOW_RECIPIENTS: "GAAA,GBBB",
    STELLAR_AGENT_PAY_BLOCK_RECIPIENTS: "GEVIL",
  });
  assert.equal(config.sessionCapUsd, "0.02");
  assert.deepEqual(config.allowRecipients, ["GAAA", "GBBB"]);
  assert.deepEqual(config.blockRecipients, ["GEVIL"]);
});

test("peek_paywall reports a free resource without paying", async () => {
  const server = fakeServer();
  registerTools(server, { peek: async () => ({ status: 200, requirements: null }) });
  const result = await server.call("peek_paywall", { url: "http://x.test/free" });
  assert.match(result.content[0].text, /No payment required \(status 200\)/);
});

test("peek_paywall prices each offer in USD", async () => {
  const server = fakeServer();
  registerTools(server, {
    peek: async () => ({ status: 402, requirements: { accepts: [{ amount: "10000", payTo: "GAAA" }] } }),
  });
  const parsed = parseResult(await server.call("peek_paywall", { url: "http://x.test/paid" }));
  assert.equal(parsed.accepts[0].priceUsd, "$0.001");
});

// The operator's guardrails must not be reachable as tool arguments: the agent
// chooses what to buy, the operator chooses who may be paid.
test("pay_url passes the operator's recipient lists, which the agent cannot override", async () => {
  const server = fakeServer();
  let seen;
  registerTools(server, {
    allowRecipients: ["GGOOD"],
    blockRecipients: ["GEVIL"],
    pay: async (_url, opts) => {
      seen = opts;
      return { response: okResponse(), settlement: null };
    },
  });

  await server.call("pay_url", { url: "http://x.test/paid", allowRecipients: ["GEVIL"] });

  assert.deepEqual(seen.allowRecipients, ["GGOOD"]);
  assert.deepEqual(seen.blockRecipients, ["GEVIL"]);
});

test("pay_url wires the guard hooks into the payment flow", async () => {
  const server = fakeServer();
  let seen;
  registerTools(server, {
    sessionCapUsd: "0.02",
    pay: async (_url, opts) => {
      seen = opts;
      return { response: okResponse(), settlement: null };
    },
  });

  await server.call("pay_url", { url: "http://x.test/paid" });

  assert.equal(typeof seen.onBeforePayment, "function");
  assert.equal(typeof seen.onPaymentFailure, "function");
});

test("pay_url returns the unlocked body and the running total", async () => {
  const server = fakeServer();
  registerTools(server, {
    sessionCapUsd: "0.02",
    pay: async (_url, opts) => {
      await opts.onBeforePayment({ paymentRequired: {}, selectedRequirements: { amount: "10000" } });
      return { response: okResponse('{"temp":18}'), settlement: { amount: "10000" } };
    },
  });

  const parsed = parseResult(await server.call("pay_url", { url: "http://x.test/paid" }));
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body, '{"temp":18}');
  assert.equal(parsed.sessionSpentUsd, "$0.001");
  assert.equal(parsed.warning, undefined);
});

// A real PAYMENT-RESPONSE has no amount, so reporting the price has to come from the
// offer that was selected. Both callers used to print `settlement.amount`, i.e. nothing.
test("pay_url reports the price paid even though settlement omits it", async () => {
  const server = fakeServer();
  registerTools(server, {
    pay: async () => ({
      response: okResponse(),
      settlement: { success: true, transaction: "abc123", network: "stellar:testnet" },
      amountPaid: "10000",
    }),
  });

  const parsed = parseResult(await server.call("pay_url", { url: "http://x.test/paid" }));
  assert.equal(parsed.amountPaidUsd, "$0.001");
  assert.equal(parsed.settlement.amount, undefined, "confirming the source really is absent");
});

// A refusal is an expected outcome and should read as one, not as a crash. The
// x402 client rewraps hook errors, so this checks the typed message survives.
test("pay_url reports a cap refusal as a clean error, not a raw wrapped throw", async () => {
  const server = fakeServer();
  registerTools(server, {
    sessionCapUsd: "0.02",
    pay: async (_url, opts) => {
      const verdict = await opts.onBeforePayment({
        paymentRequired: {},
        selectedRequirements: { amount: "500000" }, // $0.05, over the $0.02 cap
      });
      assert.ok(verdict?.abort, "the guard should have refused this");
      throw new Error(`Failed to create payment payload: Payment creation aborted: ${verdict.reason}`);
    },
  });

  const result = await server.call("pay_url", { url: "http://x.test/expensive" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Session cap exceeded/);
  assert.doesNotMatch(result.content[0].text, /Failed to create payment payload/);
});

test("pay_url rethrows a real failure that is not a refusal", async () => {
  const server = fakeServer();
  registerTools(server, {
    pay: async () => {
      throw new Error("connection reset");
    },
  });
  await assert.rejects(() => server.call("pay_url", { url: "http://x.test/paid" }), /connection reset/);
});

test("pay_url warns when the settled amount differs from what was reserved", async () => {
  const server = fakeServer();
  registerTools(server, {
    sessionCapUsd: "1.00",
    pay: async (_url, opts) => {
      await opts.onBeforePayment({ paymentRequired: {}, selectedRequirements: { amount: "10000" } });
      return { response: okResponse(), settlement: { amount: "20000" } };
    },
  });

  const parsed = parseResult(await server.call("pay_url", { url: "http://x.test/paid" }));
  assert.match(parsed.warning, /did not match/);
  assert.equal(parsed.sessionSpentUsd, "$0.002", "the total should follow what settled");
});

test("session_status reports spend and remaining budget", async () => {
  const server = fakeServer();
  registerTools(server, {
    sessionCapUsd: "0.02",
    pay: async (_url, opts) => {
      await opts.onBeforePayment({ paymentRequired: {}, selectedRequirements: { amount: "10000" } });
      return { response: okResponse(), settlement: null };
    },
  });

  await server.call("pay_url", { url: "http://x.test/paid" });
  const parsed = parseResult(await server.call("session_status"));
  assert.equal(parsed.spentUsd, "$0.001");
  assert.equal(parsed.remainingUsd, "$0.019");
});

test("session_status reports no limit when no cap is configured", async () => {
  const server = fakeServer();
  registerTools(server, {});
  const parsed = parseResult(await server.call("session_status"));
  assert.equal(parsed.remainingUsd, null);
});

// The cap is cumulative across the whole session: that is the one thing a one-shot
// CLI invocation structurally cannot do, and it is the demo's central beat.
test("the cap accumulates across calls and eventually refuses", async () => {
  const server = fakeServer();
  registerTools(server, {
    sessionCapUsd: "0.02",
    pay: async (_url, opts) => {
      const verdict = await opts.onBeforePayment({
        paymentRequired: {},
        selectedRequirements: { amount: "50000" }, // $0.005 each
      });
      if (verdict?.abort) throw new SessionCapExceededError(verdict.reason);
      return { response: okResponse(), settlement: null };
    },
  });

  for (let i = 0; i < 4; i++) {
    const result = await server.call("pay_url", { url: `http://x.test/reports/${i}` });
    assert.notEqual(result.isError, true, `purchase ${i} should have succeeded`);
  }
  assert.equal(parseResult(await server.call("session_status")).remainingUsd, "$0");

  const refused = await server.call("pay_url", { url: "http://x.test/reports/5" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Session cap exceeded/);
});
