import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { IpGuard } from "../src/guard.js";
import { LenderQueue, buildUnsignedPayloads, priceIsStable, quote, settleDefault } from "../src/loan.js";
import { createLoanServer } from "../src/server.js";
import { TERMS_VERSION } from "../src/terms.js";
import { STABLE_CURRENCY, STABLE_ISSUER } from "../src/params.js";
const ACCEPTED = { version: TERMS_VERSION, lender: true, borrower: true };
import { KycRegistry } from "../src/kyc.js";
import { ammExpectedProceeds, ammXrpPrice, validatedCloseTime, verifyCollateralEscrow } from "../src/xrpl.js";

const LENDER = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const BORROWER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const HOUSE = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

test("quote: 1000 principal, 2.5% fee, 25% LTV", () => {
  const q = quote(2);
  assert.equal(q.principal, 1000);
  assert.equal(q.issuanceFee, 25);
  assert.equal(q.collateralXrp, 2000);
  assert.equal(q.termDays, 42);
});

test("price stability uses 0.25% and 60 s ledger close_time gap", () => {
  assert.equal(priceIsStable({ closeTime: 0, price: 2 }, { closeTime: 60, price: 2.005 }), true);
  assert.equal(priceIsStable({ closeTime: 0, price: 2 }, { closeTime: 60, price: 2.0051 }), false);
  assert.equal(priceIsStable({ closeTime: 0, price: 2 }, { closeTime: 59, price: 2 }), false);
});

test("payloads are tagless and the lender pays the borrower directly", () => {
  const p = buildUnsignedPayloads({ lender: LENDER, borrower: BORROWER, house: HOUSE, issuanceFee: 25 });
  assert.equal(p.lenderToBorrower.Destination, BORROWER);
  assert.equal(p.lenderFeeToHouse.Destination, HOUSE);
  assert.equal(p.lenderFeeToHouse.Account, LENDER);
  assert.equal(p.lenderToBorrower.Amount.value, "975");
  for (const tx of Object.values(p)) {
    assert.equal("DestinationTag" in tx, false);
    assert.equal("SourceTag" in tx, false);
  }
});

test("default: house absorbs a shortfall", () => {
  const r = settleDefault({ collateralXrp: 1000, xrpPrice: 1 });
  assert.ok(r.houseAbsorbs > 0);
  assert.equal(r.houseKeepsExcess, 0);
  assert.equal(r.borrowerReceives, 0);
});

test("default: house keeps all excess", () => {
  const r = settleDefault({ collateralXrp: 2000, xrpPrice: 2 });
  assert.equal(r.houseAbsorbs, 0);
  assert.ok(r.houseKeepsExcess > 0);
  assert.equal(r.borrowerReceives, 0);
});

test("FIFO lender queue", () => {
  const q = new LenderQueue();
  q.add(LENDER);
  q.add(BORROWER);
  assert.equal(q.next(), LENDER);
  assert.equal(q.next(), BORROWER);
});

test("IP guard blocks 24h then sweeps", () => {
  let now = 0;
  const g = new IpGuard(() => now);
  g.markValidated("1.2.3.4");
  assert.equal(g.isBlocked("1.2.3.4"), true);
  assert.equal(g.isBlocked("5.6.7.8"), false);
  now = 24 * 60 * 60 * 1000 + 1;
  g.sweep();
  assert.equal(g.size, 0);
  assert.equal(g.isBlocked("1.2.3.4"), false);
});

function post(port, body, path = "/loan/request") {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", (error) => resolve({ error: error.code }));
    req.end(JSON.stringify(body && "lender" in body && !body.noTerms ? {
      acceptedTerms: ACCEPTED,
      lenderChecks: [{ lender: body.lender, amount: 1000, txHash: "C".repeat(64) }], ...body,
    } : body));
  });
}

test("interest is 12% annual prorated to 42 days", () => {
  assert.equal(quote(2).interest, 13.808219);
});

test("xrplcluster helpers parse validated close_time, price and escrow", async () => {
  const mk = (result) => async () => ({ json: async () => ({ result: { status: "success", ...result } }) });
  assert.equal(await validatedCloseTime(mk({ validated: true, ledger: { close_time: 845326450 } })), 845326450);
  await assert.rejects(validatedCloseTime(mk({ validated: false, ledger: { close_time: 1 } })));
  const pool = { validated: true, amm: { amount: "2000000", amount2: { currency: STABLE_CURRENCY, issuer: STABLE_ISSUER, value: "4" } } };
  assert.equal(await ammXrpPrice(mk(pool)), 2);
  await assert.rejects(ammXrpPrice(mk({ ...pool, validated: false })), /no validated/);
  await assert.rejects(ammXrpPrice(mk({ validated: true })), /no validated/);
  await assert.rejects(ammXrpPrice(mk({ validated: true, amm: { ...pool.amm, amount2: { ...pool.amm.amount2, issuer: "rWrong" } } })), /no validated/);

  const hash = "A".repeat(64);
  const expected = { borrower: LENDER, destination: HOUSE, minDrops: 1000000, condition: "DEADBEEF", finishAfter: 100, cancelAfter: 200 };
  const good = {
    validated: true, TransactionType: "EscrowCreate", Amount: "1000000", meta: { TransactionResult: "tesSUCCESS" },
    Account: LENDER, Destination: HOUSE, Condition: "DEADBEEF", Sequence: 42, ledger_index: 10, FinishAfter: 100, CancelAfter: 200,
  };
  assert.deepEqual(await verifyCollateralEscrow(hash, expected, mk(good)), { sequence: 42, ledgerIndex: 10 });
  assert.equal(await verifyCollateralEscrow(hash, expected, mk({ ...good, validated: false })), false);
  assert.equal(await verifyCollateralEscrow(hash, expected, mk({ ...good, Amount: { value: "1" } })), false);
  assert.equal(await verifyCollateralEscrow(hash, expected, mk({ ...good, Amount: "999" })), false);
  assert.equal(await verifyCollateralEscrow(hash, expected, mk({ ...good, Account: BORROWER })), false);
  assert.equal(await verifyCollateralEscrow(hash, expected, mk({ ...good, Destination: LENDER })), false);
  assert.equal(await verifyCollateralEscrow(hash, expected, mk({ ...good, Condition: "OTHER" })), false);
  assert.equal(await verifyCollateralEscrow("nope", expected, mk(good)), false);
  assert.equal(await verifyCollateralEscrow(hash, null, mk(good)), false);
});

test("server: IP limit starts only after the escrow is validated; later requests are destroyed; secrets refused", async () => {
  let t = 0;
  const priceProvider = async () => ({ closeTime: (t += 60), price: 2 });
  const server = createLoanServer({
    house: HOUSE, kyc: new KycRegistry([LENDER, BORROWER]), priceProvider,
    verifyEscrow: async (h) => (h === "A".repeat(64) ? { sequence: 1 } : false),
    verifyLenderCheck: async () => ({ checkId: "D".repeat(64), ledgerIndex: 10, transactionIndex: 0 }),
    getLenderBalance: async () => 1000,
    sleep: async () => {},
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    assert.equal((await post(port, { lender: LENDER, borrower: BORROWER, seed: "x" })).status, 400);

    const first = await post(port, { lender: LENDER, borrower: BORROWER });
    assert.equal(first.status, 200);
    const firstBody = JSON.parse(first.data);
    assert.equal(firstBody.terms.principal, 1000);
    assert.ok(firstBody.loanId);
    assert.ok(firstBody.unsigned.collateralEscrow);
    assert.equal((await post(port, { lender: LENDER, borrower: BORROWER })).status, 409, "same Check cannot be reserved twice");

    assert.equal((await post(port, { loanId: "nope", txHash: "B".repeat(64) }, "/loan/confirm")).status, 409);
    assert.equal((await post(port, { loanId: firstBody.loanId, sessionToken: firstBody.sessionToken, txHash: "B".repeat(64) }, "/loan/confirm")).status, 409);
    assert.equal((await post(port, { loanId: firstBody.loanId, sessionToken: firstBody.sessionToken, txHash: "A".repeat(64) }, "/loan/confirm")).status, 200);

    const again = await post(port, { lender: LENDER, borrower: BORROWER });
    assert.ok(again.error, "request after validated escrow must be destroyed, not answered");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("ammExpectedProceeds accounts for the trading fee and price impact", () => {
  const pool = { xrp: 1000000, rlusd: 2000000, feeRate: 0.00205 };
  const out = ammExpectedProceeds(pool, 3000);
  assert.ok(out < 3000 * 2 && out > 3000 * 2 * 0.99);
  assert.ok(out < 3000 * 2 * (1 - 0.0025), "fee plus impact exceeds the 0.25% stability band");
});
