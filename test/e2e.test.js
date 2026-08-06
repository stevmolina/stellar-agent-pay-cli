// Live buyer-side test: stands up a real paywall with the sibling seller kit and pays
// it through this package's own code, against the real OZ Channels testnet facilitator.
//
// This lives here, in the buyer, on purpose. The sibling repo had the only live test,
// and it built its own client out of @x402/fetch, which meant it re-implemented
// createPaidFetch instead of exercising it: nothing verified that this package could
// still complete a payment. That gap is exactly the kind of thing a restructure of the
// payment client breaks silently.
//
// Skipped automatically unless credentials AND the sibling kit are both available, so
// `npm test` stays green for anyone with neither.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createPaidFetch, payUrl } from "../src/pay.js";
import { SessionSpendCap } from "../src/sessionCap.js";
import { SessionCapGuard } from "../src/spendGuard.js";
import { usdToBaseUnits } from "../src/money.js";

const HAVE_CREDS = Boolean(
  process.env.OZ_API_KEY && process.env.STELLAR_RECIPIENT && process.env.STELLAR_SECRET_KEY
);

let stellarPaywall;
try {
  ({ stellarPaywall } = await import("stellar-x402-paywall-kit/express"));
} catch {
  stellarPaywall = null;
}

const SKIP = !HAVE_CREDS
  ? "set OZ_API_KEY, STELLAR_RECIPIENT, STELLAR_SECRET_KEY to run (see README testnet runbook)"
  : !stellarPaywall
    ? "needs the sibling stellar-x402-paywall-kit checked out alongside this repo"
    : false;

const PRICE = "$0.0001";

/** Stand up a paywalled server and hand its base URL to `fn`. */
async function withPaywall(routes, fn) {
  const app = express();
  app.use(stellarPaywall(routes, { payTo: process.env.STELLAR_RECIPIENT }));
  app.get("/cheap", (_req, res) => res.json({ ok: true, tier: "cheap" }));
  app.get("/pricey", (_req, res) => res.json({ ok: true, tier: "pricey" }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("live 402 -> pay -> unlock through createPaidFetch", { skip: SKIP }, async () => {
  await withPaywall({ "GET /cheap": { price: PRICE, description: "e2e cheap" } }, async (base) => {
    const unpaid = await fetch(`${base}/cheap`);
    assert.equal(unpaid.status, 402, "an unpaid request should be gated");

    const { response, settlement } = await payUrl(`${base}/cheap`);
    assert.equal(response.status, 200, "a paid request should unlock the resource");
    assert.deepEqual(await response.json(), { ok: true, tier: "cheap" });
    assert.ok(settlement, "settlement details should come back in PAYMENT-RESPONSE");
    assert.ok(settlement.transaction ?? settlement.txHash ?? settlement.tx, "should report a tx");
  });
});

test("live --max-price refuses an offer over the cap without paying", { skip: SKIP }, async () => {
  await withPaywall({ "GET /pricey": { price: "$0.01", description: "e2e pricey" } }, async (base) => {
    const fetchWithPayment = createPaidFetch({ maxPriceUsd: "0.0001" });
    await assert.rejects(
      () => fetchWithPayment(`${base}/pricey`),
      "a $0.01 offer must not be paid under a $0.0001 cap"
    );
  });
});

// The session cap is the one guardrail with no protocol-native equivalent, and until
// now it had no live coverage at all: it was only ever tested against a fake context.
test("live session cap refuses a second payment it cannot afford", { skip: SKIP }, async () => {
  await withPaywall({ "GET /cheap": { price: PRICE, description: "e2e cheap" } }, async (base) => {
    // Room for exactly one purchase at PRICE.
    const cap = new SessionSpendCap("0.0001");
    const guard = new SessionCapGuard(cap);
    const hooks = { onBeforePayment: guard.beforePayment, onPaymentFailure: guard.paymentFailure };

    const first = await payUrl(`${base}/cheap`, hooks);
    assert.equal(first.response.status, 200, "the first purchase should fit the budget");
    assert.equal(cap.spentUsd(), "$0.0001");
    assert.equal(cap.remainingUsd(), "$0");

    await assert.rejects(() => payUrl(`${base}/cheap`, hooks), "the second purchase must be refused");
    assert.ok(guard.lastError, "the guard should have recorded a typed refusal");
    assert.match(guard.lastError.message, /Session cap exceeded/);
    assert.equal(cap.spentUsd(), "$0.0001", "a refused payment must not be recorded as spend");
  });
});

// Proves the amount charged to the budget is the price of the offer actually selected,
// against a live facilitator's real challenge, and that it is reported back.
test("live reservation matches the price actually paid", { skip: SKIP }, async () => {
  await withPaywall({ "GET /cheap": { price: PRICE, description: "e2e cheap" } }, async (base) => {
    const cap = new SessionSpendCap("1.00");
    const guard = new SessionCapGuard(cap);

    const { response, settlement, amountPaid } = await payUrl(`${base}/cheap`, {
      onBeforePayment: guard.beforePayment,
      onPaymentFailure: guard.paymentFailure,
    });
    assert.equal(response.status, 200);
    assert.equal(cap.spentUsd(), "$0.0001", "the budget should record the real price");
    assert.equal(BigInt(amountPaid), usdToBaseUnits("0.0001"));
  });
});

// Documents the live wire format, because two callers used to report
// `settlement.amount` and it has never once existed: this is why payUrl derives the
// price from the selected offer instead.
test("live PAYMENT-RESPONSE carries no amount field", { skip: SKIP }, async () => {
  await withPaywall({ "GET /cheap": { price: PRICE, description: "e2e cheap" } }, async (base) => {
    const { settlement } = await payUrl(`${base}/cheap`);
    assert.ok(settlement, "there should be a settlement to inspect");
    assert.equal(settlement.amount, undefined, "if this starts failing, reconcile() can go live");
    assert.ok(settlement.transaction, "the tx hash is what the facilitator does return");
    assert.ok(settlement.payer);
  });
});
