import test from "node:test";
import assert from "node:assert/strict";
import { requireStablePrice } from "../src/priceStability.js";
import { IpGuard } from "../src/guard.js";
import { verifyCollateralRelease } from "../src/lenderFifo.js";

test("four fresh minute-spaced stable observations are required", async () => {
  let calls = 0;
  const result = await requireStablePrice(async () => ({ price: 2, closeTime: ++calls * 60 }), { sleep: async () => {} });
  assert.equal(calls, 4);
  assert.equal(result.closeTime, 240);
});

test("unstable, invalid or stale observations stop collateral and sale authorization", async () => {
  let calls = 0;
  await assert.rejects(requireStablePrice(async () => ({ price: ++calls === 4 ? 3 : 2, closeTime: calls * 60 }),
    { sleep: async () => {} }), /not stable/);
  await assert.rejects(requireStablePrice(async () => ({ price: NaN, closeTime: 1 })), /Invalid/);
  await assert.rejects(requireStablePrice(async () => ({ price: 2, closeTime: 1 }),
    { maxPolls: 1, sleep: async () => {} }), /did not advance/);
});

test("anti-abuse blacklists repeated invalid attempts and limits confirmed sessions", () => {
  const guard = new IpGuard();
  for (let n = 0; n < 3; n++) guard.recordInvalidAttempt("attacker");
  assert.equal(guard.isBlacklisted("attacker"), true);
  guard.markValidated("borrower");
  assert.equal(guard.isBlocked("borrower"), true);
  assert.equal(guard.isBlocked("other"), false);
});

test("collateral proof requires the exact deleted escrow, not merely successful transaction", () => {
  const expected = { borrower: "borrower", destination: "settlement", sequence: 7, minDrops: 40000000 };
  const tx = { validated: true, TransactionType: "EscrowCancel", Owner: "borrower", OfferSequence: 7,
    meta: { TransactionResult: "tesSUCCESS", AffectedNodes: [{ DeletedNode: {
      LedgerEntryType: "Escrow", FinalFields: { Account: "borrower", Destination: "settlement", Amount: "40000000" },
    } }] } };
  assert.equal(verifyCollateralRelease(tx, expected, "EscrowCancel"), true);
  assert.equal(verifyCollateralRelease({ ...tx, OfferSequence: 8 }, expected, "EscrowCancel"), false);
  assert.equal(verifyCollateralRelease({ ...tx, meta: { TransactionResult: "tesSUCCESS" } }, expected, "EscrowCancel"), false);
});
