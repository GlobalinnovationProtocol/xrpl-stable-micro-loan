import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { KycRegistry } from "../src/kyc.js";
import { LenderQueue } from "../src/loan.js";
import { createLoanServer } from "../src/server.js";
import { TERMS_VERSION } from "../src/terms.js";
const ACCEPTED = { version: TERMS_VERSION, lender: true, borrower: true };

const LENDER = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const BORROWER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const OTHER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const HOUSE = "rsA2LpzuawewSBQXkiju3YQTMzW13pAAdW";

const post = (port, body) =>
  new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/loan/request", method: "POST" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", (e) => resolve({ error: e.code }));
    req.end(JSON.stringify(body && "lender" in body ? {
      acceptedTerms: ACCEPTED, lenderChecks: [{ lender: body.lender, amount: 1000, txHash: "C".repeat(64) }], ...body,
    } : body));
  });

test("KYC registry keeps only valid addresses and ignores comments", () => {
  const kyc = new KycRegistry([LENDER, "not-an-address"]);
  assert.equal(kyc.size, 1);
  assert.equal(kyc.isApproved(LENDER), true);
  assert.equal(kyc.isApproved(BORROWER), false);
});

test("FIFO queue refuses a lender that is not KYC-approved, and stays FIFO for approved ones", () => {
  const q = new LenderQueue(new KycRegistry([LENDER, BORROWER]));
  q.add(LENDER);
  q.add(BORROWER);
  assert.throws(() => q.add(OTHER), /KYC/);
  assert.equal(q.next(), LENDER);
  assert.equal(q.next(), BORROWER);
});

test("server: KYC required for both lender and borrower (403), approved pair gets a quote", async () => {
  let t = 0;
  const server = createLoanServer({
    house: HOUSE,
    kyc: new KycRegistry([LENDER, BORROWER]),
    priceProvider: async () => ({ closeTime: (t += 60), price: 2 }),
    sleep: async () => {},
    verifyLenderCheck: async () => ({ checkId: "D".repeat(64), ledgerIndex: 10, transactionIndex: 0 }),
    getLenderBalance: async () => 1000,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    assert.equal((await post(port, { lender: OTHER, borrower: BORROWER })).status, 403);
    assert.equal((await post(port, { lender: LENDER, borrower: OTHER })).status, 403);
    assert.equal((await post(port, { lender: LENDER, borrower: BORROWER })).status, 200);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("server refuses to start without a KYC registry", () => {
  assert.throws(() => createLoanServer({ house: HOUSE }), /KYC/);
});
