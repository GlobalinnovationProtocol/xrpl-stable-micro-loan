import {
  PRINCIPAL_STABLE, ISSUANCE_FEE_RATE, LTV, TERM_DAYS, ANNUAL_INTEREST_RATE,
  PRICE_MAX_DEVIATION, PRICE_MIN_INTERVAL_SECONDS, STABLE_CURRENCY, STABLE_ISSUER,
} from "./params.js";

const ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

export function isAddress(value) {
  return typeof value === "string" && ADDRESS.test(value);
}

export function quote(xrpPrice, principal = PRINCIPAL_STABLE) {
  if (!Number.isFinite(xrpPrice) || xrpPrice <= 0) throw new Error("invalid price");
  if (!Number.isFinite(principal) || principal <= 0) throw new Error("invalid principal");
  const loanFee = round6(principal * ISSUANCE_FEE_RATE);
  const interest = round6(principal * ANNUAL_INTEREST_RATE * (TERM_DAYS / 365));
  return {
    principal,
    issuanceFee: loanFee,
    loanFee,
    borrowerReceives: round6(principal - loanFee),
    interest,
    totalDebt: round6(principal + interest),
    termDays: TERM_DAYS,
    collateralXrp: round6(principal / (LTV * xrpPrice)),
  };
}

export function priceIsStable(first, second) {
  if (![first.price, second.price, first.closeTime, second.closeTime].every(Number.isFinite)) return false;
  const interval = second.closeTime - first.closeTime;
  if (interval < PRICE_MIN_INTERVAL_SECONDS) return false;
  if (!(first.price > 0) || !(second.price > 0)) return false;
  return Math.abs(second.price - first.price) / first.price <= PRICE_MAX_DEVIATION;
}

const rlusd = (value) => ({ currency: STABLE_CURRENCY, issuer: STABLE_ISSUER, value: String(value) });

export function buildUnsignedPayloads({ lender, borrower, house, issuanceFee, principal = PRINCIPAL_STABLE }) {
  if (!Number.isFinite(issuanceFee) || issuanceFee <= 0 || issuanceFee >= principal) throw new Error("invalid loan fee");
  return {
    lenderFeeToHouse: {
      TransactionType: "Payment", Account: lender, Destination: house, Amount: rlusd(issuanceFee),
    },
    lenderToBorrower: {
      TransactionType: "Payment", Account: lender, Destination: borrower, Amount: rlusd(round6(principal - issuanceFee)),
    },
  };
}

export function buildCollateralEscrowPayload({ borrower, destination, collateralDrops, condition, finishAfter, cancelAfter }) {
  return {
    TransactionType: "EscrowCreate", Account: borrower, Destination: destination,
    Amount: String(collateralDrops), Condition: condition, FinishAfter: finishAfter, CancelAfter: cancelAfter,
  };
}

export function buildRepaymentPayload({ lender, borrower, principal = PRINCIPAL_STABLE, interest, loanId }) {
  return {
    TransactionType: "Payment", Account: borrower, Destination: lender,
    Amount: rlusd(round6(principal + interest)),
    ...(loanId ? { Memos: [{ Memo: { MemoData: Buffer.from(loanId).toString("hex").toUpperCase() } }] } : {}),
  };
}

export function settleRepaid({ collateralXrp, xrpPrice, principal = PRINCIPAL_STABLE }) {
  const q = quote(xrpPrice, principal);
  return {
    lenderReceives: round6(q.principal + q.interest),
    houseReceivesFee: q.issuanceFee,
    collateralReturnedXrp: collateralXrp,
    houseAbsorbs: 0,
  };
}

export function settleDefault({ collateralXrp, xrpPrice, principal = PRINCIPAL_STABLE }) {
  const { interest } = quote(xrpPrice, principal);
  const due = round6(principal + interest);
  const proceeds = round6(collateralXrp * xrpPrice);
  return {
    lenderReceives: due,
    houseAbsorbs: round6(Math.max(0, due - proceeds)),
    houseKeepsExcess: round6(Math.max(0, proceeds - due)),
    borrowerReceives: 0,
  };
}

export class LenderQueue {
  #items = [];
  #kyc;
  constructor(kyc) {
    this.#kyc = kyc;
  }
  add(address) {
    if (!isAddress(address)) throw new Error("invalid address");
    if (this.#kyc && !this.#kyc.isApproved(address)) throw new Error("lender not KYC-approved");
    this.#items.push(address);
  }
  next() {
    return this.#items.shift();
  }
  get size() {
    return this.#items.length;
  }
}
