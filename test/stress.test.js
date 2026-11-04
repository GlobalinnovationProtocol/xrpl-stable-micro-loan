import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { IpGuard } from "../src/guard.js";
import { DAILY_LOAN_CAP } from "../src/params.js";
import { quote, settleDefault, settleRepaid } from "../src/loan.js";
import { createLoanServer } from "../src/server.js";
import { TERMS_VERSION } from "../src/terms.js";
import { KycRegistry } from "../src/kyc.js";

const LENDER = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const BORROWER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const HOUSE = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const HASH = "A".repeat(64);

function send(port, { method = "POST", path = "/loan/request", body, raw, headers = {} }) {
  return new Promise((resolve) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body && typeof body === "object" && "lender" in body ? {
      acceptedTerms: { version: TERMS_VERSION, lender: true, borrower: true },
      lenderChecks: [{ lender: body.lender, amount: 1000, txHash: "C".repeat(64) }], ...body,
    } : body));
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", (error) => resolve({ error: error.code }));
    req.end(payload);
  });
}

async function startServer(overrides = {}) {
  let t = 0;
  const server = createLoanServer({
    kyc: new KycRegistry([LENDER, BORROWER]),
    house: HOUSE,
    priceProvider: async () => ({ closeTime: (t += 60), price: 2 }),
    verifyEscrow: async (h) => h === HASH ? { sequence: 1 } : false,
    verifyLenderCheck: async () => ({ checkId: "D".repeat(64), ledgerIndex: 10, transactionIndex: 0 }),
    getLenderBalance: async () => 1000,
    sleep: async () => {},
    ...overrides,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}
const stop = (server) => {
  server.closeAllConnections();
  server.close();
};

test("three patterns x 300 loans: lender is always made whole, house result is correct", () => {
  for (let i = 0; i < DAILY_LOAN_CAP; i++) {
    const price = 0.5 + (i % 50) * 0.1;
    const q = quote(price);
    const due = q.principal + q.interest;

    const repaid = settleRepaid({ collateralXrp: q.collateralXrp, xrpPrice: price });
    assert.ok(Math.abs(repaid.lenderReceives - due) < 1e-4);
    assert.equal(repaid.houseReceivesFee, 25);
    assert.equal(repaid.collateralReturnedXrp, q.collateralXrp);

    const excess = settleDefault({ collateralXrp: q.collateralXrp, xrpPrice: price * 1.1 });
    assert.equal(excess.houseAbsorbs, 0);
    assert.ok(excess.houseKeepsExcess > 0);
    assert.equal(excess.borrowerReceives, 0);
    assert.ok(Math.abs(excess.lenderReceives - due) < 1e-4);

    const deficit = settleDefault({ collateralXrp: q.collateralXrp, xrpPrice: price * 0.2 });
    assert.ok(deficit.houseAbsorbs > 0);
    assert.equal(deficit.houseKeepsExcess, 0);
    assert.equal(deficit.borrowerReceives, 0);
    const proceeds = q.collateralXrp * price * 0.2;
    assert.ok(Math.abs(proceeds + deficit.houseAbsorbs - deficit.lenderReceives) < 1e-3);
  }
});

test("daily cap: the 301st loan in 24 h is refused, then capacity returns", () => {
  let now = 0;
  const guard = new IpGuard(() => now);
  for (let i = 0; i < DAILY_LOAN_CAP; i++) {
    assert.equal(guard.dailyCapReached(), false);
    guard.markValidated(`10.0.${Math.floor(i / 250)}.${i % 250}`);
  }
  assert.equal(guard.dailyCapReached(), true);
  now = 24 * 60 * 60 * 1000 + 1;
  assert.equal(guard.dailyCapReached(), false);
});

test("daily cap over HTTP returns 503 when full", async () => {
  const guard = new IpGuard();
  for (let i = 0; i < DAILY_LOAN_CAP; i++) guard.markValidated(`10.1.${Math.floor(i / 250)}.${i % 250}`);
  const { server, port } = await startServer({ guard });
  try {
    const r = await send(port, { body: { lender: LENDER, borrower: BORROWER } });
    assert.equal(r.status, 503);
  } finally {
    stop(server);
  }
});

test("malformed and abusive requests are rejected and the server stays up", async () => {
  const { server, port } = await startServer();
  try {
    const cases = [
      { raw: "{not json", expect: 400 },
      { raw: "", expect: 400 },
      { raw: "null", expect: 400 },
      { raw: "[]", expect: 400 },
      { body: { lender: LENDER }, expect: 400 },
      { body: { lender: LENDER, borrower: LENDER }, expect: 400 },
      { body: { lender: 123, borrower: BORROWER }, expect: 400 },
      { body: { lender: "rbad", borrower: BORROWER }, expect: 400 },
      { body: { lender: LENDER, borrower: BORROWER, seed: "x" }, expect: 400 },
      { body: { lender: LENDER, borrower: BORROWER, note: "sEdTM1uX8pu2do5XvTnutH6HsouMaM2" }, expect: 400 },
      { body: { lender: LENDER, borrower: BORROWER, k: "ab".repeat(32) }, expect: 400 },
      { body: { lender: LENDER, borrower: BORROWER, x: "private key" }, expect: 400 },
      { path: "/loan/confirm", body: {}, expect: 409 },
      { path: "/loan/confirm", body: { txHash: "short" }, expect: 409 },
      { path: "/loan/confirm", body: { txHash: "B".repeat(64) }, expect: 409 },
      { path: "/loan/confirm", body: { txHash: HASH, seed: "x" }, expect: 400 },
      { path: "/nope", body: {}, expect: 404 },
      { method: "GET", path: "/loan/request", expect: 404 },
      { method: "PUT", body: {}, expect: 404 },
    ];
    for (const c of cases) {
      const r = await send(port, c);
      assert.equal(r.status, c.expect, JSON.stringify(c));
    }
    const health = await send(port, { method: "GET", path: "/health" });
    assert.equal(health.status, 200);
  } finally {
    stop(server);
  }
});

test("oversized body is cut without a reply", async () => {
  const { server, port } = await startServer();
  try {
    const r = await send(port, { raw: JSON.stringify({ lender: LENDER, borrower: BORROWER, pad: "x".repeat(10000) }) });
    assert.ok(r.error, "oversized request must be destroyed");
    assert.equal((await send(port, { method: "GET", path: "/health" })).status, 200);
  } finally {
    stop(server);
  }
});

test("IP rejection blocks new loans but allows authenticated continuation", async () => {
  const { server, port } = await startServer();
  try {
    const quoteRes = await send(port, { body: { lender: LENDER, borrower: BORROWER } });
    const { loanId, sessionToken } = JSON.parse(quoteRes.data);
    assert.equal((await send(port, { path: "/loan/confirm", body: { loanId, sessionToken, txHash: HASH } })).status, 200);
    for (const c of [
      { body: { lender: LENDER, borrower: BORROWER } },
      { raw: "garbage" },
    ]) {
      assert.ok((await send(port, c)).error, "blocked IP must be cut");
    }
    assert.equal((await send(port, { path: "/loan/confirm", body: { loanId, sessionToken, txHash: HASH } })).status, 200);
    assert.equal((await send(port, { method: "GET", path: "/health" })).status, 200);
  } finally {
    stop(server);
  }
});

test("stress: 400 mixed requests in waves of 100 concurrent, no crash, bounded memory", async () => {
  const { server, port } = await startServer();
  try {
    const before = process.memoryUsage().heapUsed;
    const results = [];
    for (let wave = 0; wave < 4; wave++) {
      const jobs = [];
      for (let i = 0; i < 100; i++) {
        const kind = i % 4;
        jobs.push(
          kind === 0
            ? send(port, { body: { lender: LENDER, borrower: BORROWER } })
            : kind === 1
              ? send(port, { raw: "{broken" })
              : kind === 2
                ? send(port, { body: { lender: LENDER, borrower: BORROWER, seed: "x" } })
                : send(port, { method: "GET", path: "/health" }),
        );
      }
      results.push(...(await Promise.all(jobs)));
    }
    const counts = {};
    for (const r of results) counts[r.status ?? r.error] = (counts[r.status ?? r.error] ?? 0) + 1;
    const ok = results.filter((r) => r.status === 200).length;
    assert.ok(ok >= 100, `quotes and health checks must succeed: ${JSON.stringify(counts)}`);
    assert.ok(results.every((r) => [200, 400, 409, 429].includes(r.status)), JSON.stringify(counts));
    assert.equal((await send(port, { method: "GET", path: "/health" })).status, 200);
    assert.ok(process.memoryUsage().heapUsed - before < 100 * 1024 * 1024, "heap growth under 100 MB");
  } finally {
    stop(server);
  }
});
