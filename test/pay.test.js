import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaidFetch, buildMaxPricePolicy, buildRecipientPolicy, amountOf } from "../src/pay.js";
import { AgentPayConfigError } from "../src/errors.js";
import { usdToBaseUnits } from "../src/money.js";

test("createPaidFetch throws a clear error without STELLAR_SECRET_KEY", () => {
  const prev = process.env.STELLAR_SECRET_KEY;
  delete process.env.STELLAR_SECRET_KEY;
  try {
    assert.throws(() => createPaidFetch({}), AgentPayConfigError);
    assert.throws(() => createPaidFetch({}), /STELLAR_SECRET_KEY is required/);
  } finally {
    if (prev !== undefined) process.env.STELLAR_SECRET_KEY = prev;
  }
});

test("createPaidFetch accepts a valid secretKey + network and returns a fetch function", async () => {
  // A real (but unfunded) keypair is enough to build the signer;
  // no network call happens until the fetch is actually invoked.
  const { Keypair } = await import("@stellar/stellar-sdk");
  const fetchWithPayment = createPaidFetch({
    secretKey: Keypair.random().secret(),
    network: "stellar:testnet",
  });
  assert.equal(typeof fetchWithPayment, "function");
});

// Regression test: an earlier version read `r.maxAmountRequired`, which does not
// exist on the real wire-format PaymentRequirements (confirmed live against OZ
// Channels testnet — the field is `amount`). That bug made --max-price silently
// reject every payment option, even ones well under the cap.
test("amountOf reads the real wire-format `amount` field, not `maxAmountRequired`", () => {
  assert.equal(amountOf({ amount: "10000" }), "10000");
  // legacy/defensive fallback, in case a future SDK version renames it back
  assert.equal(amountOf({ maxAmountRequired: "10000" }), "10000");
  assert.equal(amountOf({}), undefined);
});

test("buildMaxPricePolicy keeps offers at/under the cap and drops ones over it", () => {
  const policy = buildMaxPricePolicy("0.01"); // 100000 base units
  const requirements = [
    { amount: "50000" }, // $0.005 - under cap, kept
    { amount: "100000" }, // $0.01 - exactly at cap, kept
    { amount: "150000" }, // $0.015 - over cap, dropped
  ];
  const kept = policy(2, requirements);
  assert.deepEqual(
    kept.map((r) => r.amount),
    ["50000", "100000"]
  );
});

test("buildMaxPricePolicy drops requirements with a garbage/missing amount instead of throwing", () => {
  const policy = buildMaxPricePolicy("0.01");
  const kept = policy(2, [{ amount: "not-a-number" }, {}]);
  assert.deepEqual(kept, []);
});

test("buildMaxPricePolicy cap matches usdToBaseUnits exactly (boundary check)", () => {
  const policy = buildMaxPricePolicy("0.001");
  const atCap = usdToBaseUnits("0.001").toString();
  assert.deepEqual(policy(2, [{ amount: atCap }]).length, 1);
});

test("buildRecipientPolicy with no allow/block lists keeps everything", () => {
  const policy = buildRecipientPolicy({});
  const requirements = [{ payTo: "GAAA" }, { payTo: "GBBB" }];
  assert.deepEqual(policy(2, requirements), requirements);
});

test("buildRecipientPolicy allow-list only keeps listed recipients", () => {
  const policy = buildRecipientPolicy({ allow: ["GAAA"] });
  const kept = policy(2, [{ payTo: "GAAA" }, { payTo: "GBBB" }]);
  assert.deepEqual(
    kept.map((r) => r.payTo),
    ["GAAA"]
  );
});

test("buildRecipientPolicy block-list drops listed recipients", () => {
  const policy = buildRecipientPolicy({ block: ["GBBB"] });
  const kept = policy(2, [{ payTo: "GAAA" }, { payTo: "GBBB" }]);
  assert.deepEqual(
    kept.map((r) => r.payTo),
    ["GAAA"]
  );
});

test("buildRecipientPolicy: block always wins over allow, even for the same address", () => {
  const policy = buildRecipientPolicy({ allow: ["GAAA"], block: ["GAAA"] });
  assert.deepEqual(policy(2, [{ payTo: "GAAA" }]), []);
});
