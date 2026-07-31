import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaidFetch } from "../src/pay.js";
import { AgentPayConfigError } from "../src/errors.js";

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
