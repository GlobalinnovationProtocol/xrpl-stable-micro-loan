import test from "node:test";
import assert from "node:assert/strict";
import { createCollateralCondition } from "../src/escrow.js";
import { LoanSessionStore } from "../src/loanSession.js";
import { sellCollateralOnAmm } from "../src/settlement/ammSale.js";
import { runSettlement } from "../src/settlement/settle.js";
import { STABLE_CURRENCY, STABLE_ISSUER } from "../src/params.js";

const LENDER = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const BORROWER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const DESTINATION = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const stableProvider = () => {
  let time = 0;
  return async () => ({ price: 2, closeTime: time += 60 });
};
const releaseNodes = (session) => [{ DeletedNode: {
  LedgerEntryType: "Escrow", FinalFields: {
    Account: session.borrower, Destination: session.destination, Amount: String(session.minDrops),
  },
} }];

test("createCollateralCondition: fulfillment hashes to the condition, PREIMAGE-SHA-256 shape", () => {
  const { condition, fulfillment } = createCollateralCondition();
  assert.match(condition, /^A0258020[0-9A-F]{64}810120$/);
  assert.match(fulfillment, /^A0228020[0-9A-F]{64}$/);
  const again = createCollateralCondition();
  assert.notEqual(again.condition, condition);
});

test("sellCollateralOnAmm: rejects an inverted or non-positive price floor before submitting anything", async () => {
  let submitted = false;
  const client = { submitAndWait: async () => (submitted = true) };
  const feeWallet = { address: DESTINATION, wallet: {} };
  await assert.rejects(
    sellCollateralOnAmm({ client, feeWallet, collateralDrops: "1000000", ceilingRlusd: 10, floorRlusd: 20 }),
  );
  await assert.rejects(
    sellCollateralOnAmm({ client, feeWallet, collateralDrops: "1000000", ceilingRlusd: 10, floorRlusd: 0 }),
  );
  assert.equal(submitted, false);
});

test("sellCollateralOnAmm: Amount is the ceiling and DeliverMin is the discounted floor, never swapped", async () => {
  let tx;
  const client = { submitAndWait: async (t) => ((tx = t), { result: { meta: { TransactionResult: "tesSUCCESS" } } }) };
  const feeWallet = { address: DESTINATION, wallet: {} };
  await sellCollateralOnAmm({ client, feeWallet, collateralDrops: "1000000", ceilingRlusd: 100, floorRlusd: 99.75 });
  assert.equal(tx.Account, DESTINATION);
  assert.equal(tx.Destination, DESTINATION);
  assert.equal(tx.SendMax, "1000000");
  assert.equal(tx.Amount.value, "100");
  assert.equal(tx.DeliverMin.value, "99.75");
  assert.equal(tx.Amount.currency, STABLE_CURRENCY);
  assert.equal(tx.Amount.issuer, STABLE_ISSUER);
  assert.ok(Number(tx.Flags) > 0, "tfPartialPayment must be set");
});

test("LoanSessionStore: create/get/markLocked/due/sweep lifecycle", () => {
  const sessions = new LoanSessionStore();
  const loanId = sessions.create({
    lender: LENDER, borrower: BORROWER, destination: DESTINATION, minDrops: 1000000,
    condition: "C", fulfillment: "F", finishAfter: 1000, cancelAfter: 2000,
  });
  assert.equal(sessions.size, 1);
  assert.equal(sessions.get(loanId).status, "pending_collateral");
  assert.equal(sessions.get("missing"), undefined);
  assert.equal(sessions.due(1000).length, 0, "not due before collateral is locked");

  sessions.markLocked(loanId, { sequence: 7 });
  assert.equal(sessions.get(loanId).status, "collateral_locked");
  assert.equal(sessions.get(loanId).escrowSequence, 7);
  assert.equal(sessions.due(999).length, 0, "not due before finishAfter");
  assert.equal(sessions.due(1000).length, 0, "unfunded collateral must not be liquidated");
  sessions.get(loanId).feePaid = true;
  assert.equal(sessions.markFunded(loanId), true);
  assert.equal(sessions.due(1000).length, 1, "funded loan is due at finishAfter");

  sessions.markSettled(loanId);
  assert.equal(sessions.due(2000).length, 0, "settled sessions are never due again");

  const other = sessions.create({
    lender: LENDER, borrower: BORROWER, destination: DESTINATION, minDrops: 1,
    condition: "C", fulfillment: "F", finishAfter: 1, cancelAfter: 2,
  });
  sessions.sweep(0, Date.now() + 1);
  assert.equal(sessions.get(other).status, "expired", "stale unconfirmed session expires");
  assert.equal(sessions.inFlightCount(), 0, "expired and settled sessions do not count as in flight");
  assert.equal(sessions.get(loanId).status, "settled", "settled sessions survive sweep");
});

function makeSession(overrides = {}) {
  return {
    lender: LENDER, borrower: BORROWER, destination: DESTINATION, minDrops: 1000000,
    condition: "C", fulfillment: "F", finishAfter: 1000, cancelAfter: 2000,
    escrowSequence: 1, status: "collateral_locked",
    ...overrides,
  };
}

test("runSettlement: on-time repayment is detected and skips EscrowFinish/AMM sale entirely", async () => {
  const session = makeSession();
  let escrowFinishSubmitted = false;
  const client = {
    submitAndWait: async (tx) => {
      if (tx.TransactionType === "EscrowFinish") escrowFinishSubmitted = true;
      return { result: { meta: { TransactionResult: "tesSUCCESS" } } };
    },
  };
  const fetchImpl = async () => ({
    json: async () => ({
      result: {
        status: "success",
        transactions: [
          {
            validated: true,
            tx: { TransactionType: "Payment", Account: BORROWER, Destination: LENDER },
            meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: STABLE_CURRENCY, issuer: STABLE_ISSUER, value: "1013.808219" } },
          },
        ],
      },
    }),
  });

  const result = await runSettlement(session, { client, feeWallet: { address: DESTINATION, wallet: {} }, priceProvider: async () => ({ price: 2 }), fetchImpl });
  assert.equal(result.outcome, "repaid_on_time");
  assert.equal(session.status, "repaid_on_time");
  assert.equal(escrowFinishSubmitted, false);
});

test("runSettlement: a deficit pays only actual proceeds and requests the exact shortfall from house", async () => {
  const session = makeSession({ minDrops: 100, house: BORROWER, loanId: "loan-1" });
  const payments = [];
  const client = { submitAndWait: async (tx) => {
    payments.push(tx);
    return { result: { ...tx, validated: true, ...(tx.DeliverMin ? { ledger_index: 20 } : {}),
      meta: { TransactionResult: "tesSUCCESS",
      AffectedNodes: releaseNodes(session),
      delivered_amount: tx.Amount ?? { currency: STABLE_CURRENCY, issuer: STABLE_ISSUER, value: "0" } } } };
  } };
  const fetchImpl = async () => ({ json: async () => ({ result: { status: "success", transactions: [] } }) });
  let requested;
  const requestApproval = async (args) => (requested = args);

  const result = await runSettlement(session, {
    client, feeWallet: { address: DESTINATION, wallet: {} }, priceProvider: stableProvider(),
    stabilitySleep: async () => {}, fetchImpl, requestApproval,
  });
  assert.equal(result.outcome, "deficit_pending_approval");
  assert.equal(session.status, "deficit_pending_approval");
  assert.equal(Number(requested.txjson.Amount.value), 1013.808019);
  assert.equal(requested.txjson.Account, BORROWER);
  assert.equal(Number(payments.find((tx) => tx.Destination === LENDER).Amount.value), 0.0002);
});

test("runSettlement: excess uses actual delivered proceeds and pays lender before house", async () => {
  const session = makeSession({ minDrops: 1000000000, house: BORROWER });
  const payments = [];
  const client = { submitAndWait: async (tx) => {
    payments.push(tx);
    return { result: { ...tx, validated: true, ...(tx.DeliverMin ? { ledger_index: 20 } : {}),
      meta: { TransactionResult: "tesSUCCESS",
      AffectedNodes: releaseNodes(session),
      delivered_amount: tx.DeliverMin
        ? { currency: STABLE_CURRENCY, issuer: STABLE_ISSUER, value: "1998" }
        : tx.Amount } } };
  } };
  const fetchImpl = async () => ({ json: async () => ({ result: { status: "success", transactions: [] } }) });
  const result = await runSettlement(session, {
    client, feeWallet: { address: DESTINATION, wallet: {} },
    priceProvider: stableProvider(), stabilitySleep: async () => {}, fetchImpl,
  });
  assert.equal(result.lenderReceives, 1013.808219);
  assert.equal(result.houseKeepsExcess, 984.191781);
  assert.equal(session.status, "settled");
  assert.deepEqual(payments.slice(-2).map((tx) => tx.Destination), [LENDER, BORROWER]);
});

test("runSettlement: failed release stops before sale/payout and cannot be blindly retried", async () => {
  const session = makeSession({ house: BORROWER });
  let submissions = 0;
  const client = { submitAndWait: async () => {
    submissions++;
    return { result: { validated: true, meta: { TransactionResult: "tecNO_TARGET" } } };
  } };
  const fetchImpl = async () => ({ json: async () => ({ result: { status: "success", transactions: [] } }) });
  const options = { client, feeWallet: { address: DESTINATION, wallet: {} }, priceProvider: stableProvider(), stabilitySleep: async () => {}, fetchImpl };
  await assert.rejects(runSettlement(session, options), /not validated/);
  assert.equal(session.status, "reconciliation_required");
  await assert.rejects(runSettlement(session, options), /not ready/);
  assert.equal(submissions, 1);
});

test("abandoned unconfirmed session releases its FIFO Check; lender is reusable after settlement", () => {
  const sessions = new LoanSessionStore();
  const alloc = { lender: LENDER, checkId: "A".repeat(64), amount: 1000, ledgerIndex: 1, transactionIndex: 0 };
  const base = { lender: LENDER, borrower: BORROWER, destination: DESTINATION, minDrops: 1,
    condition: "C", fulfillment: "F", finishAfter: 1, cancelAfter: 2, lenderAllocations: [alloc] };
  const first = sessions.create(base);
  assert.equal(sessions.inFlightCount(), 1);
  assert.throws(() => sessions.create(base), /already reserved/);
  sessions.sweep(0, Date.now() + 1);
  assert.equal(sessions.get(first).status, "expired");
  assert.equal(sessions.inFlightCount(), 0);
  const second = sessions.create(base);
  sessions.markLocked(second, { sequence: 1 });
  sessions.get(second).feePaid = true;
  sessions.get(second).nextCheckCash = 1;
  assert.equal(sessions.markFunded(second), true);
  assert.equal(sessions.inFlightCount(), 0, "funded loans are no longer in flight");
  sessions.markSettled(second);
  assert.ok(sessions.create(base), "Check id is reservable again once the loan is settled");
});

test("runSettlement: price unstable after release keeps the loan retryable and swaps once stable, without a second EscrowFinish", async () => {
  const session = makeSession({ minDrops: 1000000, house: BORROWER, loanId: "loan-r", principal: 1000, status: "loan_active" });
  const submitted = [];
  const client = { submitAndWait: async (tx) => {
    submitted.push(tx.TransactionType);
    return { result: { ...tx, validated: true, ledger_index: 20,
      meta: { TransactionResult: "tesSUCCESS", AffectedNodes: releaseNodes(session),
        delivered_amount: tx.Amount ?? { currency: STABLE_CURRENCY, issuer: STABLE_ISSUER, value: "0" } } } };
  } };
  const fetchImpl = async () => ({ json: async () => ({ result: { status: "success", transactions: [] } }) });
  let calls = 0;
  let unstable = false;
  const priceProvider = async () => {
    calls++;
    return { price: unstable && calls % 4 === 0 ? 5 : 2, closeTime: calls * 60 };
  };
  const common = { client, feeWallet: { address: DESTINATION, wallet: {} }, priceProvider, stabilitySleep: async () => {},
    fetchImpl, houseAddress: BORROWER, poolProvider: async () => ({ xrp: 1e6, rlusd: 2e6, feeRate: 0.00205 }),
    requestApproval: async () => ({ uuid: "u", url: "x" }) };
  const afterRelease = async () => { unstable = true; calls = 4; };
  const first = runSettlement(session, { ...common, priceProvider: async () => {
    const r = await priceProvider();
    if (session.status === "collateral_released") return { price: 99, closeTime: r.closeTime };
    return r;
  } });
  await assert.rejects(first, /stable|changed/);
  assert.equal(session.status, "collateral_released");
  assert.deepEqual(submitted, ["EscrowFinish"]);
  await afterRelease();
  unstable = false;
  const result = await runSettlement(session, common);
  assert.ok(["settled", "deficit_pending_approval"].includes(result.outcome));
  assert.equal(submitted.filter((t) => t === "EscrowFinish").length, 1, "collateral is released only once");
  assert.ok(submitted.includes("Payment"));
});
