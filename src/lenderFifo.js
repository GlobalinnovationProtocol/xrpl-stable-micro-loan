import { STABLE_SYMBOL } from "./params.js";
export const LOAN_UNIT = 1000;
export const MAX_LENDER_OFFER = 1_000_000;

export function validateLenderOffer(amount) {
  validateLoanAmount(amount);
  if (amount > MAX_LENDER_OFFER) throw new Error(`FIFO lender offer must not exceed 1000000 ${STABLE_SYMBOL}`);
  return amount;
}

export function validateLoanAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount < LOAN_UNIT || amount % LOAN_UNIT !== 0) {
    throw new Error(`loan amount must be a positive multiple of ${LOAN_UNIT}`);
  }
  return amount;
}

export function allocateFifoChecks(amount, offers, isApproved = () => true) {
  validateLoanAmount(amount);
  const ordered = [...offers].sort((a, b) =>
    a.ledgerIndex - b.ledgerIndex || a.transactionIndex - b.transactionIndex,
  );
  let remaining = amount;
  const usedChecks = new Set();
  const remainingBalance = new Map();
  const allocations = [];
  for (const offer of ordered) {
    if (!isApproved(offer.lender)) continue;
    if (offer.status !== "validated_available") continue;
    const authorized = Number(offer.amount);
    const balance = Number(offer.balance);
    if (authorized !== LOAN_UNIT || !Number.isFinite(balance) || balance < LOAN_UNIT ||
        !/^[0-9A-F]{64}$/.test(offer.checkId ?? "") || usedChecks.has(offer.checkId) ||
        !Number.isSafeInteger(offer.ledgerIndex) || offer.ledgerIndex < 1 ||
        !Number.isSafeInteger(offer.transactionIndex) || offer.transactionIndex < 0) continue;
    if (!remainingBalance.has(offer.lender)) remainingBalance.set(offer.lender, balance);
    const available = remainingBalance.get(offer.lender);
    if (available < LOAN_UNIT) continue;
    const allocated = LOAN_UNIT;
    allocations.push({
      lender: offer.lender,
      checkId: offer.checkId,
      amount: allocated,
      ledgerIndex: offer.ledgerIndex,
      transactionIndex: offer.transactionIndex,
    });
    usedChecks.add(offer.checkId);
    remainingBalance.set(offer.lender, available - allocated);
    remaining -= allocated;
    if (remaining === 0) return allocations;
  }
  throw new Error("insufficient KYC-approved, validated FIFO Check liquidity");
}

export function buildCheckCreate({ lender, borrower, amount, currency, issuer }) {
  validateLoanAmount(amount);
  if (amount !== LOAN_UNIT) throw new Error(`each XRPL Check must authorize exactly ${LOAN_UNIT}; create one Check per loan unit`);
  if (!lender || !borrower || lender === borrower || !currency || !issuer) {
    throw new Error("lender, borrower, currency and issuer are required");
  }
  return {
    TransactionType: "CheckCreate",
    Account: lender,
    Destination: borrower,
    SendMax: { currency, issuer, value: String(amount) },
  };
}

export function buildCheckCash({ borrower, checkId, amount, currency, issuer }) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("positive CheckCash amount required");
  if (!borrower || !/^[0-9A-Fa-f]{64}$/.test(checkId ?? "") || !currency || !issuer) {
    throw new Error("borrower, valid CheckID, currency and issuer are required");
  }
  return {
    TransactionType: "CheckCash",
    Account: borrower,
    CheckID: checkId.toUpperCase(),
    Amount: { currency, issuer, value: String(amount) },
  };
}

export function verifyValidatedCheckCreate(tx, expected) {
  tx = normalizeTransaction(tx);
  if (
    tx?.validated !== true ||
    tx?.meta?.TransactionResult !== "tesSUCCESS" ||
    tx?.TransactionType !== "CheckCreate" ||
    tx.Account !== expected.lender ||
    tx.Destination !== expected.borrower ||
    tx.SendMax?.currency !== expected.currency ||
    tx.SendMax?.issuer !== expected.issuer ||
    Number(tx.SendMax?.value) !== expected.amount ||
    !Number.isSafeInteger(tx.ledger_index) || tx.ledger_index < 1 ||
    !Number.isSafeInteger(tx.meta?.TransactionIndex) || tx.meta.TransactionIndex < 0 ||
    tx.Expiration !== undefined
  ) return false;
  const created = (tx.meta.AffectedNodes ?? []).find((node) =>
    node.CreatedNode?.LedgerEntryType === "Check",
  )?.CreatedNode;
  if (!/^[0-9A-Fa-f]{64}$/.test(created?.LedgerIndex ?? "")) return false;
  return {
    checkId: created.LedgerIndex.toUpperCase(),
    ledgerIndex: tx.ledger_index,
    transactionIndex: tx.meta.TransactionIndex ?? 0,
    amount: Number(tx.SendMax.value),
  };
}

export function verifyValidatedCheckCash(tx, expected) {
  tx = normalizeTransaction(tx);
  return tx?.validated === true &&
    tx?.meta?.TransactionResult === "tesSUCCESS" &&
    tx?.TransactionType === "CheckCash" &&
    tx.Account === expected.borrower &&
    tx.CheckID?.toUpperCase() === expected.checkId?.toUpperCase() &&
    tx.Amount?.currency === expected.currency &&
    tx.Amount?.issuer === expected.issuer &&
    Number(tx.Amount?.value) === expected.amount &&
    (tx.meta.AffectedNodes ?? []).some((node) =>
      node.DeletedNode?.LedgerEntryType === "Check" &&
      node.DeletedNode.LedgerIndex?.toUpperCase() === expected.checkId?.toUpperCase(),
    );
}

export function verifyValidatedCheckCancel(tx, expected) {
  tx = normalizeTransaction(tx);
  return tx?.validated === true &&
    tx?.meta?.TransactionResult === "tesSUCCESS" &&
    tx?.TransactionType === "CheckCancel" &&
    tx.Account === expected.lender &&
    tx.CheckID?.toUpperCase() === expected.checkId?.toUpperCase() &&
    (tx.meta.AffectedNodes ?? []).some((node) =>
      node.DeletedNode?.LedgerEntryType === "Check" &&
      node.DeletedNode.LedgerIndex?.toUpperCase() === expected.checkId?.toUpperCase(),
    );
}

export function buildCheckCancel({ lender, checkId }) {
  if (!lender || !/^[0-9A-Fa-f]{64}$/.test(checkId ?? "")) {
    throw new Error("lender and valid CheckID are required");
  }
  return { TransactionType: "CheckCancel", Account: lender, CheckID: checkId.toUpperCase() };
}

export function normalizeTransaction(result) {
  const tx = { ...result, ...(result?.tx_json ?? result?.tx ?? {}) };
  if (tx.Amount === undefined && tx.DeliverMax !== undefined) tx.Amount = tx.DeliverMax;
  return tx;
}

export function verifyValidatedCollateral(result, expected) {
  const tx = normalizeTransaction(result);
  return tx.validated === true && tx.meta?.TransactionResult === "tesSUCCESS" &&
    tx.TransactionType === "EscrowCreate" && tx.Account === expected.borrower &&
    tx.Destination === expected.destination && typeof tx.Amount === "string" &&
    tx.Amount === String(expected.minDrops) && tx.Condition === expected.condition &&
    tx.FinishAfter === expected.finishAfter && tx.CancelAfter === expected.cancelAfter &&
    Number.isSafeInteger(tx.Sequence) && tx.Sequence > 0
    ? { sequence: tx.Sequence } : false;
}

export function verifyCollateralRelease(result, expected, type) {
  const tx = normalizeTransaction(result);
  return tx.validated === true && tx.meta?.TransactionResult === "tesSUCCESS" &&
    tx.TransactionType === type && tx.Owner === expected.borrower &&
    tx.OfferSequence === expected.sequence &&
    (tx.meta.AffectedNodes ?? []).some(({ DeletedNode: node }) =>
      node?.LedgerEntryType === "Escrow" &&
      node.FinalFields?.Account === expected.borrower &&
      node.FinalFields?.Destination === expected.destination &&
      node.FinalFields?.Amount === String(expected.minDrops),
    );
}

export function buildFifoCommitmentMemo({ amount, currency, issuer, position }) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || !currency || !issuer ||
      !Number.isSafeInteger(position) || position < 1) {
    throw new Error("valid offer amount, token identity and FIFO position are required");
  }
  return {
    type: `${currency.toLowerCase()}_fifo_offer`,
    amount,
    currency,
    issuer,
    position,
  };
}
