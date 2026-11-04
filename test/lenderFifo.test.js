import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateFifoChecks, buildCheckCash, buildCheckCreate, buildFifoCommitmentMemo,
  normalizeTransaction, validateLoanAmount, verifyValidatedCheckCash, verifyValidatedCheckCreate,
} from "../src/lenderFifo.js";

const LENDER_A = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const LENDER_B = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const BORROWER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const CURRENCY = "524C555344000000000000000000000000000000";

test("production loan amount is an exact positive 1000-unit multiple", () => {
  assert.equal(validateLoanAmount(1000), 1000);
  assert.equal(validateLoanAmount(5000), 5000);
  for (const amount of [0, 999, 1001, 1500, -1000, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateLoanAmount(amount), /multiple of 1000/);
  }
});

test("allocates only KYC-approved validated Checks in FIFO order and skips stale balance", () => {
  const offers = [
    { lender: LENDER_B, checkId: "B".repeat(64), amount: 1000, balance: 2000, status: "validated_available", ledgerIndex: 20, transactionIndex: 0 },
    { lender: LENDER_A, checkId: "A".repeat(64), amount: 1000, balance: 1000, status: "validated_available", ledgerIndex: 10, transactionIndex: 2 },
  ];
  assert.deepEqual(
    allocateFifoChecks(2000, offers, (address) => address === LENDER_A || address === LENDER_B)
      .map(({ lender, amount }) => ({ lender, amount })),
    [{ lender: LENDER_A, amount: 1000 }, { lender: LENDER_B, amount: 1000 }],
  );
  assert.throws(() => allocateFifoChecks(2000, offers, (address) => address === LENDER_A), /insufficient/);
});

test("does not count unvalidated, cancelled, unapproved or sub-unit capacity", () => {
  const offers = [
    { lender: LENDER_A, checkId: "a", amount: 2000, balance: 2000, status: "pending", ledgerIndex: 1, transactionIndex: 0 },
    { lender: LENDER_B, checkId: "b", amount: 2000, balance: 900, status: "validated_available", ledgerIndex: 2, transactionIndex: 0 },
  ];
  assert.throws(() => allocateFifoChecks(1000, offers, () => true), /insufficient/);
});

test("builds exact borrower-bound CheckCreate and CheckCash payloads", () => {
  assert.deepEqual(buildCheckCreate({
    lender: LENDER_A, borrower: BORROWER, amount: 1000, currency: CURRENCY, issuer: ISSUER,
  }), {
    TransactionType: "CheckCreate", Account: LENDER_A, Destination: BORROWER,
    SendMax: { currency: CURRENCY, issuer: ISSUER, value: "1000" },
  });
  assert.deepEqual(buildCheckCash({
    borrower: BORROWER, checkId: "a".repeat(64), amount: 1000, currency: CURRENCY, issuer: ISSUER,
  }), {
    TransactionType: "CheckCash", Account: BORROWER, CheckID: "A".repeat(64),
    Amount: { currency: CURRENCY, issuer: ISSUER, value: "1000" },
  });
  assert.throws(() => buildCheckCreate({
    lender: LENDER_A, borrower: BORROWER, amount: 1001, currency: CURRENCY, issuer: ISSUER,
  }), /multiple of 1000/);
});

test("requires validated successful exact lender CheckCreate and CheckCash evidence", () => {
  const create = {
    validated: true, ledger_index: 10, TransactionType: "CheckCreate", Account: LENDER_A,
    Destination: BORROWER, SendMax: { currency: CURRENCY, issuer: ISSUER, value: "2000" },
    meta: { TransactionResult: "tesSUCCESS", TransactionIndex: 1, AffectedNodes: [
      { CreatedNode: { LedgerEntryType: "Check", LedgerIndex: "A".repeat(64) } },
    ] },
  };
  const expected = { lender: LENDER_A, borrower: BORROWER, amount: 2000, currency: CURRENCY, issuer: ISSUER };
  assert.deepEqual(verifyValidatedCheckCreate(create, expected), {
    checkId: "A".repeat(64), ledgerIndex: 10, transactionIndex: 1, amount: 2000,
  });
  assert.equal(verifyValidatedCheckCreate({ ...create, validated: false }, expected), false);
  assert.equal(verifyValidatedCheckCreate({ ...create, Destination: LENDER_B }, expected), false);
  const cash = {
    validated: true, meta: { TransactionResult: "tesSUCCESS", AffectedNodes: [
      { DeletedNode: { LedgerEntryType: "Check", LedgerIndex: "A".repeat(64) } },
    ] }, TransactionType: "CheckCash",
    Account: BORROWER, CheckID: "A".repeat(64),
    Amount: { currency: CURRENCY, issuer: ISSUER, value: "1000" },
  };
  assert.equal(verifyValidatedCheckCash(cash, {
    borrower: BORROWER, checkId: "A".repeat(64), amount: 1000, currency: CURRENCY, issuer: ISSUER,
  }), true);
  assert.equal(verifyValidatedCheckCash({ ...cash, Account: LENDER_A }, {
    borrower: BORROWER, checkId: "A".repeat(64), amount: 1000, currency: CURRENCY, issuer: ISSUER,
  }), false);
});

test("normalizes XRPL API v2 DeliverMax into the conventional payment Amount field", () => {
  const tx = normalizeTransaction({
    tx_json: {
      TransactionType: "Payment",
      Account: LENDER_A,
      Destination: BORROWER,
      DeliverMax: "25856007",
    },
  });
  assert.equal(tx.Amount, "25856007");
  assert.equal(tx.DeliverMax, "25856007");
});

test("builds public FIFO offer memo without implying that CheckCreate locks funds", () => {
  assert.deepEqual(buildFifoCommitmentMemo({
    amount: 2000, currency: CURRENCY, issuer: ISSUER, position: 1,
  }), {
    type: `${CURRENCY.toLowerCase()}_fifo_offer`,
    amount: 2000, currency: CURRENCY, issuer: ISSUER, position: 1,
  });
});
