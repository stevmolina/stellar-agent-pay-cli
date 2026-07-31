import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionSpendCap, SessionCapExceededError } from "../src/sessionCap.js";
import { usdToBaseUnits } from "../src/money.js";

test("no cap when constructed without one", async () => {
  const cap = new SessionSpendCap(null);
  await cap.reserve(usdToBaseUnits("1000"));
  assert.equal(cap.remainingUsd(), null);
});

test("reserve throws once cumulative spend would exceed the cap", async () => {
  const cap = new SessionSpendCap("0.05");
  await cap.reserve(usdToBaseUnits("0.03"));
  await assert.rejects(() => cap.reserve(usdToBaseUnits("0.03")), SessionCapExceededError);
  // the failed reservation must not have been recorded
  assert.equal(cap.spentUsd(), "$0.03");
});

test("release gives back budget for a payment that failed after reserving", async () => {
  const cap = new SessionSpendCap("0.05");
  const amount = usdToBaseUnits("0.03");
  await cap.reserve(amount);
  await cap.release(amount);
  assert.equal(cap.spentUsd(), "$0");
  await cap.reserve(usdToBaseUnits("0.05")); // full budget available again
});

test("concurrent reserve() calls are serialized — total never exceeds the cap", async () => {
  const cap = new SessionSpendCap("0.10");
  const amount = usdToBaseUnits("0.03");
  // Fire 5 concurrent reservations of $0.03 against a $0.10 cap — at most 3 can fit.
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => cap.reserve(amount)));
  const fulfilled = results.filter((r) => r.status === "fulfilled").length;
  assert.equal(fulfilled, 3);
  assert.equal(cap.spentUsd(), "$0.09");
});
