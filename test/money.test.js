import { test } from "node:test";
import assert from "node:assert/strict";
import { usdToBaseUnits, baseUnitsToUsd } from "../src/money.js";

test("usdToBaseUnits converts human USD to 7-decimal base units", () => {
  assert.equal(usdToBaseUnits("$0.001"), 10000n);
  assert.equal(usdToBaseUnits("0.01"), 100000n);
  assert.equal(usdToBaseUnits("1"), 10000000n);
  assert.equal(usdToBaseUnits(0.5), 5000000n);
});

test("usdToBaseUnits rejects garbage input", () => {
  assert.throws(() => usdToBaseUnits("not-a-number"));
  assert.throws(() => usdToBaseUnits("$-1"));
});

test("baseUnitsToUsd round-trips with usdToBaseUnits", () => {
  assert.equal(baseUnitsToUsd(10000n), "$0.001");
  assert.equal(baseUnitsToUsd(10000000n), "$1");
  assert.equal(baseUnitsToUsd(100000n), "$0.01");
});

test("baseUnitsToUsd accepts string/number input too", () => {
  assert.equal(baseUnitsToUsd("10000"), "$0.001");
  assert.equal(baseUnitsToUsd(10000000), "$1");
});
