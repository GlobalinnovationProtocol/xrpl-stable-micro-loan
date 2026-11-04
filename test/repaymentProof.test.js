import test from "node:test";
import assert from "node:assert/strict";
import { borrowerRepaid } from "../src/xrpl.js";
import { runSettlement } from "../src/settlement/settle.js";
import { STABLE_CURRENCY, STABLE_ISSUER } from "../src/params.js";

const entry = (value, memo = "loan", date = 900) => ({
  validated: true,
  tx_json: { TransactionType: "Payment", Account: "borrower", Destination: "lender", date,
    Memos: [{ Memo: { MemoData: Buffer.from(memo).toString("hex") } }] },
  meta: { TransactionResult: "tesSUCCESS", delivered_amount: {
    currency: STABLE_CURRENCY, issuer: STABLE_ISSUER, value: String(value),
  } },
});
const fetchPage = (transactions) => async () => ({ json: async () => ({
  result: { status: "success", transactions },
}) });

test("repayment is matched to loan memo, deadline and delivered amounts across pages", async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    const { params: [params] } = JSON.parse(options.body);
    assert.equal(params.ledger_index_min, 10);
    calls++;
    return { json: async () => ({ result: {
      status: "success", transactions: calls === 1 ? [entry(400), entry(9999, "another-loan")] : [entry(613.808219)],
      ...(calls === 1 ? { marker: "next" } : {}),
    } }) };
  };
  const expected = { loanId: "loan", minLedgerIndex: 10, finishAfter: 1000 };
  assert.equal(await borrowerRepaid("lender", "borrower", 1013.808219, fetchImpl, expected), true);
  assert.equal(calls, 2);
  assert.equal(await borrowerRepaid("lender", "borrower", 1013.808219, fetchPage([entry(1013.808219, "loan", 1001)]), expected), false);
  assert.equal(await borrowerRepaid("lender", "borrower", 1013.808219, fetchPage([entry(1013.808219, "another-loan")]), expected), false);
});

test("validated repayment waits until CancelAfter, then proves exact collateral return", async () => {
  const session = { loanId: "loan", status: "loan_active", lender: "lender", borrower: "borrower",
    principal: 1000, destination: "settlement", minDrops: 1000000, escrowSequence: 7,
    minLedgerIndex: 10, finishAfter: 1000, cancelAfter: 1200 };
  let now = 1100;
  let submissions = 0;
  const client = {
    request: async () => ({ result: { validated: true, ledger: { close_time: now } } }),
    submitAndWait: async (tx) => {
      submissions++;
      assert.equal(tx.TransactionType, "EscrowCancel");
      assert.equal(tx.OfferSequence, 7);
      return { result: { ...tx, hash: "A".repeat(64), validated: true, meta: {
        TransactionResult: "tesSUCCESS", AffectedNodes: [{ DeletedNode: {
          LedgerEntryType: "Escrow", FinalFields: { Account: "borrower", Destination: "settlement", Amount: "1000000" },
        } }],
      } } };
    },
  };
  const options = { client, feeWallet: { address: "network-wallet", wallet: {} },
    fetchImpl: fetchPage([entry(1013.808219)]) };
  assert.equal((await runSettlement(session, options)).outcome, "repaid_waiting_cancel");
  assert.equal(submissions, 0);
  now = 1201;
  const result = await runSettlement(session, options);
  assert.equal(result.outcome, "repaid_on_time");
  assert.equal(result.collateralReturnHash, "A".repeat(64));
  assert.equal(submissions, 1);
});
