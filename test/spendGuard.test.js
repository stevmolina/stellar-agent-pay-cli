import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionCapGuard } from "../src/spendGuard.js";
import { SessionSpendCap } from "../src/sessionCap.js";
import { usdToBaseUnits } from "../src/money.js";

// A stand-in for the context @x402/core hands a beforePaymentCreation hook.
// `paymentRequired` identity matters: the client reuses the same object if it has
// to rebuild a payload, and the guard keys its reservation on it.
function ctx(amount, challenge = {}) {
  return { paymentRequired: challenge, selectedRequirements: { amount } };
}

test("reserves the amount of the offer the client actually selected", async () => {
  const cap = new SessionSpendCap("0.05");
  const guard = new SessionCapGuard(cap);

  const result = await guard.beforePayment(ctx("100000")); // $0.01
  assert.equal(result, undefined, "should not abort");
  assert.equal(cap.spentUsd(), "$0.01");
});

// The regression this whole redesign is for: the old code reserved accepts[0]
// before the policies ran, so the amount charged to the budget could belong to an
// offer that was never paid. The hook only ever sees the selected one.
test("charges the selected offer, not the first one the server listed", async () => {
  const cap = new SessionSpendCap("0.05");
  const guard = new SessionCapGuard(cap);

  // Server listed $0.05 first, but the price policy left the $0.001 option.
  await guard.beforePayment(ctx("10000"));
  assert.equal(cap.spentUsd(), "$0.001");
  assert.equal(cap.remainingUsd(), "$0.049");
});

test("aborts with a typed error once the cap is exhausted, and records nothing", async () => {
  const cap = new SessionSpendCap("0.02");
  const guard = new SessionCapGuard(cap);

  await guard.beforePayment(ctx(usdToBaseUnits("0.016").toString(), {}));
  const result = await guard.beforePayment(ctx(usdToBaseUnits("0.05").toString(), {}));

  assert.ok(result?.abort, "should abort the payment");
  assert.match(result.reason, /Session cap exceeded/);
  assert.match(guard.lastError.message, /Session cap exceeded/);
  assert.equal(cap.spentUsd(), "$0.016", "the refused payment must not be recorded");
});

// Fails open in the old code: no parseable amount meant no reservation and the
// payment went out anyway.
test("fails closed when the selected offer has no readable amount", async () => {
  const cap = new SessionSpendCap("0.05");
  const guard = new SessionCapGuard(cap);

  const result = await guard.beforePayment(ctx("not-a-number"));
  assert.ok(result?.abort, "should refuse rather than pay an unpriceable offer");
  assert.match(result.reason, /no readable amount/);
  assert.equal(cap.spentUsd(), "$0");
});

test("missing amount is allowed through when no cap is configured", async () => {
  const cap = new SessionSpendCap(null);
  const guard = new SessionCapGuard(cap);

  const result = await guard.beforePayment(ctx(undefined));
  assert.equal(result, undefined, "nothing to enforce without a cap");
});

// createPaymentPayload runs twice for one purchase when a recovery hook replaces a
// failed payload. Reserving per call instead of per challenge double-charged.
test("one purchase is charged once even if the payload is rebuilt", async () => {
  const cap = new SessionSpendCap("0.05");
  const guard = new SessionCapGuard(cap);
  const challenge = {};

  await guard.beforePayment(ctx("100000", challenge));
  await guard.beforePayment(ctx("100000", challenge));

  assert.equal(cap.spentUsd(), "$0.01", "same challenge must not reserve twice");
});

test("separate purchases at the same price both count", async () => {
  const cap = new SessionSpendCap("0.05");
  const guard = new SessionCapGuard(cap);

  await guard.beforePayment(ctx("100000", {}));
  await guard.beforePayment(ctx("100000", {}));

  assert.equal(cap.spentUsd(), "$0.02");
});

test("a failure while signing gives the budget back", async () => {
  const cap = new SessionSpendCap("0.05");
  const guard = new SessionCapGuard(cap);
  const challenge = {};

  await guard.beforePayment(ctx("100000", challenge));
  assert.equal(cap.spentUsd(), "$0.01");

  await guard.paymentFailure({ paymentRequired: challenge, error: new Error("signing blew up") });
  assert.equal(cap.spentUsd(), "$0", "nothing was signed, so nothing was spent");
});

test("releasing an unknown challenge is a no-op", async () => {
  const cap = new SessionSpendCap("0.05");
  const guard = new SessionCapGuard(cap);

  await guard.beforePayment(ctx("100000", {}));
  await guard.paymentFailure({ paymentRequired: {}, error: new Error("different purchase") });
  assert.equal(cap.spentUsd(), "$0.01", "must not refund a reservation it never made");
});

test("reconcile corrects a settled amount that differs from the reservation", async () => {
  const cap = new SessionSpendCap("0.05");
  const guard = new SessionCapGuard(cap);

  await guard.beforePayment(ctx("100000")); // reserved $0.01
  const drift = await guard.reconcile({ amount: "120000" }); // settled $0.012

  assert.ok(drift, "should report the mismatch");
  assert.equal(drift.reservedUsd, "$0.01");
  assert.equal(drift.settledUsd, "$0.012");
  assert.equal(cap.spentUsd(), "$0.012", "budget should reflect what actually settled");
});

test("reconcile is quiet when the settled amount matches", async () => {
  const cap = new SessionSpendCap("0.05");
  const guard = new SessionCapGuard(cap);

  await guard.beforePayment(ctx("100000"));
  assert.equal(await guard.reconcile({ amount: "100000" }), null);
  assert.equal(cap.spentUsd(), "$0.01");
});

test("reconcile ignores a settlement with no usable amount", async () => {
  const cap = new SessionSpendCap("0.05");
  const guard = new SessionCapGuard(cap);

  await guard.beforePayment(ctx("100000"));
  assert.equal(await guard.reconcile(null), null);
  assert.equal(await guard.reconcile({}), null);
  assert.equal(await guard.reconcile({ amount: "junk" }), null);
  assert.equal(cap.spentUsd(), "$0.01");
});
