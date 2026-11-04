import { STABLE_SYMBOL } from "./params.js";
import { validateLenderOffer } from "./lenderFifo.js";

export function validateDemoAmount(value, borrower = false) {
  const amount = Number(value);
  if (!borrower) return validateLenderOffer(amount);
  if (!Number.isSafeInteger(amount) || amount < 40 || amount > 45) {
    throw new Error(`Demo gross loan must be an integer from 40 to 45 ${STABLE_SYMBOL}`);
  }
  return amount;
}

export function allocateDemoFifo(amount, entries) {
  validateDemoAmount(amount, true);
  const seen = new Set();
  const lenders = new Set();
  const allocations = [];
  let remaining = amount;
  for (const entry of [...entries].sort((a, b) =>
    a.ledgerIndex - b.ledgerIndex || a.transactionIndex - b.transactionIndex)) {
    if (entry.status !== "validated_available" || entry.kycApproved !== true ||
        seen.has(entry.offerTxHash) || lenders.has(entry.address) ||
        !Number.isFinite(entry.available) || entry.available <= 0 ||
        !Number.isSafeInteger(entry.ledgerIndex) || entry.ledgerIndex < 1 ||
        !Number.isSafeInteger(entry.transactionIndex) || entry.transactionIndex < 0) continue;
    seen.add(entry.offerTxHash);
    lenders.add(entry.address);
    const take = Math.min(remaining, Math.floor(entry.available));
    if (take <= 0) continue;
    const fee = Math.round(take * 0.025 * 1e6) / 1e6;
    allocations.push({ ...entry, gross: take, fee, net: Math.round((take - fee) * 1e6) / 1e6 });
    remaining -= take;
    if (remaining === 0) return allocations;
  }
  throw new Error("Insufficient validated, approved FIFO liquidity; no collateral may be submitted");
}

export function verifyDemoPayment(tx, { account, destination, currency, issuer, value }) {
  const delivered = tx.meta?.delivered_amount;
  return tx.validated === true && tx.meta?.TransactionResult === "tesSUCCESS" &&
    tx.TransactionType === "Payment" && tx.Account === account && tx.Destination === destination &&
    (Number(tx.Flags ?? 0) & 0x00020000) === 0 &&
    delivered?.currency === currency && delivered?.issuer === issuer &&
    Number(delivered?.value) === value;
}
