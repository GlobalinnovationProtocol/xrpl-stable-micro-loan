import test from "node:test";
import assert from "node:assert/strict";
import { buildRepaymentPayload, buildUnsignedPayloads, quote, settleDefault } from "../src/loan.js";

const LENDER = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const BORROWER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const HOUSE = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const net = {};
const move = (p) => {
  const v = Number(p.Amount.value);
  net[p.Account] = (net[p.Account] ?? 0) - v;
  net[p.Destination] = (net[p.Destination] ?? 0) + v;
};

test("repayment: every RLUSD moved is a transfer between the three parties, nothing is created", () => {
  const q = quote(2);
  const open = buildUnsignedPayloads({ lender: LENDER, borrower: BORROWER, house: HOUSE, issuanceFee: q.issuanceFee });
  const repay = buildRepaymentPayload({ lender: LENDER, borrower: BORROWER, interest: q.interest });
  [open.lenderFeeToHouse, open.lenderToBorrower, repay].forEach(move);

  assert.equal(Math.abs(Object.values(net).reduce((a, b) => a + b, 0)) < 1e-6, true);
  assert.ok(Math.abs(net[LENDER] - q.interest) < 1e-6);
  assert.ok(Math.abs(net[HOUSE] - q.issuanceFee) < 1e-6);
  assert.ok(Math.abs(net[BORROWER] + q.interest + q.issuanceFee) < 1e-6);
  for (const p of [open.lenderFeeToHouse, open.lenderToBorrower, repay]) {
    assert.equal(p.DestinationTag, undefined);
    assert.equal(p.SourceTag, undefined);
  }
  assert.equal(open.lenderToBorrower.Amount.value, "975");
  assert.equal(open.lenderFeeToHouse.Amount.value, "25");
  assert.equal(open.lenderFeeToHouse.Account, LENDER);
});

test("default: lender gets exactly principal + interest; house pays only the deficit or keeps only the excess", () => {
  const q = quote(2);
  const due = q.principal + q.interest;
  for (const price of [0.2, 1, 2, 3.5]) {
    const out = settleDefault({ collateralXrp: q.collateralXrp, xrpPrice: price });
    const proceeds = q.collateralXrp * price;
    assert.ok(Math.abs(out.lenderReceives - due) < 1e-4);
    assert.ok(Math.abs(proceeds + out.houseAbsorbs - out.houseKeepsExcess - due) < 1e-3);
    assert.equal(out.houseAbsorbs * out.houseKeepsExcess, 0);
    assert.equal(out.borrowerReceives, 0);
  }
});
