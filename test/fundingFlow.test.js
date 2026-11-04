import test from "node:test";
import assert from "node:assert/strict";
import { createLoanServer } from "../src/server.js";
import { LoanSessionStore } from "../src/loanSession.js";
import { KycRegistry } from "../src/kyc.js";
import { TERMS_VERSION } from "../src/terms.js";
import { verifyBorrowerPayment } from "../src/xrpl.js";
import { STABLE_CURRENCY, STABLE_ISSUER } from "../src/params.js";

const lender = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const borrower = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const house = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const hash = (letter) => letter.repeat(64);

test("service opens only after collateral, deducted house fee, and exact 975 net funding", async () => {
  let time = 0;
  let cashCalls = 0;
  const sessions = new LoanSessionStore();
  const server = createLoanServer({
    house, sessions, kyc: new KycRegistry([lender, borrower]),
    priceProvider: async () => ({ price: 2, closeTime: time += 60 }), sleep: async () => {},
    verifyLenderCheck: async () => ({ checkId: hash("D"), ledgerIndex: 10, transactionIndex: 0 }),
    getLenderBalance: async () => 1000,
    verifyEscrow: async (value) => value === hash("A") ? { sequence: 7, ledgerIndex: 100 } : false,
    verifyLoanFee: async (value, expected) => value === hash("B") && expected.amount === 25 &&
      expected.borrower === lender && expected.house === house && expected.minLedgerIndex === 100,
    verifyCheckCash: async (value, expected) => {
      cashCalls++;
      return value === hash("C") && expected.amount === 975;
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => {
    const res = await fetch(url + route, { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const quoted = await post("/loan/request", {
      borrower, acceptedTerms: { version: TERMS_VERSION, lender: true, borrower: true },
      lenderChecks: [{ lender, amount: 1000, txHash: hash("E") }],
    });
    assert.equal(quoted.status, 200);
    assert.equal(quoted.body.terms.borrowerReceives, 975);
    assert.equal(quoted.body.terms.totalDebt, 1013.808219);
    const auth = { loanId: quoted.body.loanId, sessionToken: quoted.body.sessionToken };
    assert.equal((await post("/loan/disbursement/confirm", { ...auth, txHash: hash("C") })).status, 409);
    assert.equal((await post("/loan/confirm", { loanId: auth.loanId, txHash: hash("A") })).status, 403);
    const collateral = await post("/loan/confirm", { ...auth, txHash: hash("A") });
    assert.equal(collateral.status, 200);
    assert.equal(collateral.body.nextLenderLoanFee.Amount.value, "25");
    assert.equal(collateral.body.nextLenderLoanFee.Account, lender);
    assert.ok(collateral.body.nextLenderLoanFee.Memos);
    assert.equal((await post("/loan/disbursement/confirm", { ...auth, txHash: hash("C") })).status, 409);
    assert.equal(cashCalls, 0);
    const fee = await post("/loan/fee/confirm", { ...auth, txHash: hash("B") });
    assert.equal(fee.status, 200);
    assert.equal(fee.body.nextLenderCheckCash.Amount.value, "975");
    const funded = await post("/loan/disbursement/confirm", { ...auth, txHash: hash("C") });
    assert.equal(funded.status, 200);
    assert.equal(funded.body.loanFeeAlreadyDeducted, 25);
    assert.equal(funded.body.borrowerReceives, 975);
    assert.equal(sessions.get(auth.loanId).status, "loan_active");
    assert.equal((await post("/loan/disbursement/confirm", { ...auth, txHash: hash("C") })).status, 409);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("house fee verification binds exact delivered amount, account, loan memo and ledger", async () => {
  const loanId = "loan-id";
  const tx = { validated: true, ledger_index: 101, TransactionType: "Payment", Account: lender,
    Destination: house, Memos: [{ Memo: { MemoData: Buffer.from(loanId).toString("hex") } }],
    meta: { TransactionResult: "tesSUCCESS", delivered_amount: {
      currency: STABLE_CURRENCY, issuer: STABLE_ISSUER, value: "25",
    } } };
  const fetchTx = (value) => async () => ({ json: async () => ({ result: { status: "success", ...value } }) });
  const expected = { borrower: lender, house, amount: 25, minLedgerIndex: 100, loanId };
  assert.equal(await verifyBorrowerPayment(hash("A"), expected, fetchTx(tx)), true);
  assert.equal(await verifyBorrowerPayment(hash("A"), expected, fetchTx({ ...tx, ledger_index: 99 })), false);
  assert.equal(await verifyBorrowerPayment(hash("A"), expected, fetchTx({ ...tx, Memos: [] })), false);
  assert.equal(await verifyBorrowerPayment(hash("A"), expected, fetchTx({ ...tx, Account: borrower })), false);
  assert.equal(await verifyBorrowerPayment(hash("A"), expected, fetchTx({
    ...tx, meta: { ...tx.meta, delivered_amount: { ...tx.meta.delivered_amount, value: "24" } },
  })), false);
});
