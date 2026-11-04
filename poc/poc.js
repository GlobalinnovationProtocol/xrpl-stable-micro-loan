import assert from "node:assert/strict";
import { quote, settleDefault, settleRepaid, priceIsStable, buildUnsignedPayloads, buildRepaymentPayload } from "../src/loan.js";

const price = 2;
const q = quote(price);
console.log("Quote:", q);
assert.equal(q.borrowerReceives, 975);
assert.equal(q.loanFee, 25);
assert.equal(q.totalDebt, 1013.808219);
console.log("Stable (60 s, 0.1%):", priceIsStable({ closeTime: 0, price }, { closeTime: 60, price: 2.002 }));
console.log(
  "Unsigned payloads:",
  JSON.stringify(
    buildUnsignedPayloads({
      lender: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH",
      borrower: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      house: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
      issuanceFee: q.issuanceFee,
    }),
    null,
    2,
  ),
);
console.log("Default, price -80%:", settleDefault({ collateralXrp: q.collateralXrp, xrpPrice: price * 0.2 }));
console.log("Default, price +10%:", settleDefault({ collateralXrp: q.collateralXrp, xrpPrice: price * 1.1 }));
console.log("Repayment:", buildRepaymentPayload({
  lender: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH", borrower: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", interest: q.interest,
}));
console.log("Repaid:", settleRepaid({ collateralXrp: q.collateralXrp, xrpPrice: price }));
