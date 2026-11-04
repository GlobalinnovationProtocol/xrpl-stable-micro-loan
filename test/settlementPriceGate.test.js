import test from "node:test";
import assert from "node:assert/strict";
import { runSettlement } from "../src/settlement/settle.js";

test("mainnet default does not release or sell collateral on unstable price", async () => {
  let calls = 0;
  let submitted = 0;
  const session = { status: "loan_active", principal: 1000, lender: "lender", borrower: "borrower",
    house: "house", destination: "sale", minDrops: 1000000 };
  await assert.rejects(runSettlement(session, {
    client: { submitAndWait: async () => { submitted++; } },
    feeWallet: { address: "sale" },
    priceProvider: async () => ({ price: ++calls === 4 ? 3 : 2, closeTime: calls * 60 }),
    stabilitySleep: async () => {},
    fetchImpl: async () => ({ json: async () => ({ result: { status: "success", transactions: [] } }) }),
  }), /not stable/);
  assert.equal(submitted, 0);
  assert.equal(session.status, "loan_active");
});
