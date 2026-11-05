import test from "node:test";
import assert from "node:assert/strict";
import { createLoanServer } from "../src/server.js";
import { LoanSessionStore } from "../src/loanSession.js";
import { KycRegistry } from "../src/kyc.js";
import { TERMS_VERSION } from "../src/terms.js";
import { verifyValidatedFailedCheckCash } from "../src/lenderFifo.js";

// Lenders A, B, C each created a 1000 Check to the borrower. A is first in FIFO order.
const A = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const B = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const C = "rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh";
const borrower = "rUCzEr6jrEyMpjhs4wSdQdz4g8Y382NxfM";
const house = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const hash = (letter) => letter.repeat(64);
const CHECK = { [A]: hash("1"), [B]: hash("2"), [C]: hash("3") };   // CheckCreate tx hash per lender
const CHECK_ID = { [A]: hash("A"), [B]: hash("B"), [C]: hash("C") };
const ORDER = { [A]: 10, [B]: 11, [C]: 12 };                        // ledger index = FIFO order

function world() {
  // mutable on-ledger picture the mocks read from
  const state = { balance: { [A]: 1000, [B]: 1000, [C]: 1000 }, cancelled: new Set(), failedCash: new Set() };
  let time = 0;
  const sessions = new LoanSessionStore();
  const server = createLoanServer({
    house, sessions, kyc: new KycRegistry([A, B, C, borrower]),
    priceProvider: async () => ({ price: 2, closeTime: time += 60 }), sleep: async () => {},
    verifyLenderCheck: async (txHash, expected) => {
      const lender = Object.keys(CHECK).find((l) => CHECK[l] === txHash);
      if (!lender || lender !== expected.lender || state.cancelled.has(lender)) return false;
      return { checkId: CHECK_ID[lender], ledgerIndex: ORDER[lender], transactionIndex: 0 };
    },
    getLenderBalance: async (lender) => state.balance[lender] ?? 0,
    verifyEscrow: async (value) => value === hash("E") ? { sequence: 7, ledgerIndex: 100 } : false,
    verifyLoanFee: async (value, expected) => value === hash("F") && expected.amount === 25,
    verifyCheckCash: async (value, expected) => value === hash("9") && expected.amount === 975,
    verifyFailedCheckCash: async (value, expected) => value === hash("8") && state.failedCash.has(expected.checkId),
  });
  return { state, sessions, server };
}

async function start(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return async (route, body) => {
    const res = await fetch(url + route, { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
}
const terms = { version: TERMS_VERSION, lender: true, borrower: true };
const checks = (...lenders) => lenders.map((l) => ({ lender: l, amount: 1000, txHash: CHECK[l] }));

test("request: a lender who cancelled their Check or moved stablecoins out is skipped, the next FIFO lender serves the loan", async () => {
  const { state, server } = world();
  state.cancelled.add(A);          // A withdrew their FIFO approval (CheckCancel)
  state.balance[B] = 500;          // B still has a Check but moved 500 out
  const post = await start(server);
  try {
    const r = await post("/loan/request", { borrower, acceptedTerms: terms, lenderChecks: checks(A, B, C) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.lenderAllocations[0].lender, C);
    assert.deepEqual(r.body.skippedLenders.map((s) => s.lender).sort(), [A, B].sort());
    assert.match(r.body.skippedLenders.find((s) => s.lender === B).reason, /insufficient/);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test("confirm: lender leaves after the XRP escrow is locked -> standby lender takes over before any fee is asked", async () => {
  const { state, sessions, server } = world();
  const post = await start(server);
  try {
    const q = await post("/loan/request", { borrower, acceptedTerms: terms, lenderChecks: checks(A, B) });
    assert.equal(q.status, 200);
    assert.equal(q.body.lenderAllocations[0].lender, A);
    assert.deepEqual(q.body.standbyLenders, [B]);
    const auth = { loanId: q.body.loanId, sessionToken: q.body.sessionToken };
    state.balance[A] = 0;          // A empties the account while the borrower signs the escrow
    const c = await post("/loan/confirm", { ...auth, txHash: hash("E") });
    assert.equal(c.status, 200);
    assert.equal(c.body.nextLenderLoanFee.Account, B, "fee is now requested from B, not from the lender who left");
    const session = sessions.get(auth.loanId);
    assert.equal(session.lenderAllocations[0].lender, B);
    assert.equal(session.droppedAllocations[0].lender, A);
    assert.equal(sessions.isReserved(CHECK_ID[A]), false, "A's Check reservation released");
    assert.equal(sessions.isReserved(CHECK_ID[B]), true);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test("confirm: every lender left and no standby -> escrow is locked but the server reports the shortfall and accepts new Checks via /loan/funding/add", async () => {
  const { state, server } = world();
  const post = await start(server);
  try {
    const q = await post("/loan/request", { borrower, acceptedTerms: terms, lenderChecks: checks(A) });
    const auth = { loanId: q.body.loanId, sessionToken: q.body.sessionToken };
    state.cancelled.add(A);
    const c = await post("/loan/confirm", { ...auth, txHash: hash("E") });
    assert.equal(c.status, 200);
    assert.equal(c.body.fundingShortfall, 1000);
    assert.equal(c.body.nextLenderLoanFee, undefined);
    const added = await post("/loan/funding/add", { ...auth, lenderChecks: checks(B) });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.nextLenderLoanFee.Account, B);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test("retry: the ledger rejects the CheckCash (lender unfunded) -> proof accepted, lender dropped, next lender's Check offered", async () => {
  const { state, sessions, server } = world();
  const post = await start(server);
  try {
    const q = await post("/loan/request", { borrower, acceptedTerms: terms, lenderChecks: checks(A, B) });
    const auth = { loanId: q.body.loanId, sessionToken: q.body.sessionToken };
    assert.equal((await post("/loan/confirm", { ...auth, txHash: hash("E") })).status, 200);
    const fee = await post("/loan/fee/confirm", { ...auth, txHash: hash("F") });
    assert.equal(fee.status, 200);
    assert.equal(fee.body.nextLenderCheckCash.CheckID, CHECK_ID[A]);
    // A's CheckCash fails on-ledger with tecUNFUNDED; the client reports the failed hash
    state.failedCash.add(CHECK_ID[A]); state.balance[A] = 0;
    const bogus = await post("/loan/funding/retry", { ...auth, txHash: hash("7") });
    assert.equal(bogus.status, 409, "an unproven failure is refused");
    const retry = await post("/loan/funding/retry", { ...auth, txHash: hash("8") });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.nextLenderCheckCash.CheckID, CHECK_ID[B]);
    assert.equal(retry.body.droppedLenders[0].lender, A);
    const session = sessions.get(auth.loanId);
    assert.deepEqual(session.feeRefundDue, { lender: A, amount: 25 }, "A paid the fee then could not fund: refund recorded for the house");
    const funded = await post("/loan/disbursement/confirm", { ...auth, txHash: hash("9") });
    assert.equal(funded.status, 200);
    assert.equal(funded.body.funded, true);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test("verifyValidatedFailedCheckCash accepts only a validated tec* CheckCash by this borrower for this Check", () => {
  const base = { validated: true, TransactionType: "CheckCash", Account: borrower, CheckID: CHECK_ID[A], meta: { TransactionResult: "tecUNFUNDED" } };
  const expected = { borrower, checkId: CHECK_ID[A] };
  assert.equal(verifyValidatedFailedCheckCash(base, expected), true);
  assert.equal(verifyValidatedFailedCheckCash({ ...base, meta: { TransactionResult: "tesSUCCESS" } }, expected), false, "a success is not a failure proof");
  assert.equal(verifyValidatedFailedCheckCash({ ...base, validated: false }, expected), false);
  assert.equal(verifyValidatedFailedCheckCash({ ...base, Account: A }, expected), false);
  assert.equal(verifyValidatedFailedCheckCash({ ...base, CheckID: CHECK_ID[B] }, expected), false);
});
