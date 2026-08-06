import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logPaymentEvent } from "../src/eventLog.js";

const CLI = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

// No facilitator and no funded account involved: everything here is either arg
// parsing or a --dry-run against a local server, which never signs a payment.
function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("--help prints usage and exits 0", async () => {
  const { code, stdout } = await run(["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /stellar-agent-pay <url> \[options\]/);
});

test("no URL prints usage and exits 1", async () => {
  const { code, stdout } = await run([]);
  assert.equal(code, 1);
  assert.match(stdout, /stellar-agent-pay <url>/);
});

test("a malformed --header is a config error, exit 1", async () => {
  const { code, stderr } = await run(["http://127.0.0.1:1/x", "--header", "NoColonHere"]);
  assert.equal(code, 1);
  assert.match(stderr, /Config error: Invalid --header/);
});

test("--dry-run on a 402 shows the price without paying", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepts: [{ amount: "10000", network: "stellar:testnet", payTo: "GAAA" }] }));
    },
    async (base) => {
      // No STELLAR_SECRET_KEY on purpose: a dry run must not need one.
      const { code, stdout, stderr } = await run([`${base}/paid`, "--dry-run"], {
        STELLAR_SECRET_KEY: "",
      });
      assert.equal(code, 0);
      assert.match(stdout, /"amount": "10000"/);
      assert.match(stderr, /Would cost \$0\.001 on stellar:testnet to GAAA/);
    }
  );
});

test("--dry-run on a free resource says so and exits 0", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"free":true}');
    },
    async (base) => {
      const { code, stderr } = await run([`${base}/free`, "--dry-run"]);
      assert.equal(code, 0);
      assert.match(stderr, /No payment required/);
    }
  );
});

test("a missing secret key is a config error, not a crash", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end("{}");
    },
    async (base) => {
      const { code, stderr } = await run([`${base}/paid`], { STELLAR_SECRET_KEY: "" });
      assert.equal(code, 1);
      assert.match(stderr, /STELLAR_SECRET_KEY is required/);
    }
  );
});

// Regression: --log-file used to throw ENOENT if the directory did not exist, and
// the README's own suggested path (~/.stellar-agent-pay/payments.jsonl) is exactly
// that case. It is called after settlement, so the throw lost the caller a response
// body for a payment that had already cost money.
test("--log-file creates its directory instead of throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pay-log-"));
  const target = path.join(dir, "nested", "deeper", "payments.jsonl");

  const wrote = logPaymentEvent(target, { url: "http://x.test/paid", paid: true });

  assert.equal(wrote, true);
  const lines = fs.readFileSync(target, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.url, "http://x.test/paid");
  assert.ok(event.timestamp, "should stamp a timestamp");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("logging appends rather than overwriting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pay-log-"));
  const target = path.join(dir, "payments.jsonl");

  logPaymentEvent(target, { url: "a" });
  logPaymentEvent(target, { url: "b" });

  const lines = fs.readFileSync(target, "utf8").trim().split("\n");
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).url),
    ["a", "b"]
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unwritable log path warns instead of throwing", () => {
  // A path whose parent is a file, not a directory: mkdir cannot fix this, so it
  // exercises the branch where logging fails but must not take the caller down.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pay-log-"));
  const blocker = path.join(dir, "not-a-dir");
  fs.writeFileSync(blocker, "");

  assert.equal(logPaymentEvent(path.join(blocker, "payments.jsonl"), { url: "x" }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no log file configured is a silent no-op", () => {
  assert.equal(logPaymentEvent(undefined, { url: "x" }), false);
});
