import { STABLE_CURRENCY, STABLE_ISSUER, STABLE_SYMBOL } from "./params.js";
import {
  normalizeTransaction, verifyValidatedCheckCancel, verifyValidatedCheckCash,
  verifyValidatedCheckCreate, verifyValidatedCollateral, verifyValidatedFailedCheckCash,
} from "./lenderFifo.js";

export const XRPL_URL = "https://xrplcluster.com/";

async function rpc(method, params, fetchImpl = fetch) {
  const response = await fetchImpl(XRPL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
    signal: AbortSignal.timeout(10000),
  });
  const { result } = await response.json();
  if (!result || result.status !== "success") throw new Error(`xrpl ${method} failed`);
  return method === "tx" ? normalizeTransaction(result) : result;
}

export async function validatedCloseTime(fetchImpl) {
  const result = await rpc("ledger", { ledger_index: "validated" }, fetchImpl);
  if (result.validated !== true || !Number.isInteger(result.ledger.close_time)) {
    throw new Error("no validated ledger");
  }
  return result.ledger.close_time;
}

export async function ammPool(fetchImpl) {
  const result = await rpc(
    "amm_info",
    {
      asset: { currency: "XRP" },
      asset2: { currency: STABLE_CURRENCY, issuer: STABLE_ISSUER },
      ledger_index: "validated",
    },
    fetchImpl,
  );
  const amm = result.amm;
  if (result.validated === false || !amm || typeof amm.amount !== "string" ||
      amm.amount2?.currency !== STABLE_CURRENCY || amm.amount2?.issuer !== STABLE_ISSUER) {
    throw new Error(`no validated XRP/${STABLE_SYMBOL} AMM pool`);
  }
  const xrp = Number(amm.amount) / 1e6;
  const rlusd = Number(amm.amount2.value);
  const feeRate = Number(amm.trading_fee ?? 0) / 100000;
  if (!(xrp > 0) || !(rlusd > 0) || !Number.isFinite(rlusd / xrp) ||
      !(feeRate >= 0 && feeRate < 0.01)) throw new Error("invalid AMM pool");
  return { xrp, rlusd, feeRate };
}

export async function ammXrpPrice(fetchImpl) {
  const { xrp, rlusd } = await ammPool(fetchImpl);
  return rlusd / xrp;
}

export function ammExpectedProceeds({ xrp, rlusd, feeRate }, xrpIn) {
  if (!(xrpIn > 0)) throw new Error("invalid swap size");
  const effective = xrpIn * (1 - feeRate);
  return (rlusd * effective) / (xrp + effective);
}

export function makePriceProvider(fetchImpl) {
  return async () => ({
    price: await ammXrpPrice(fetchImpl),
    closeTime: await validatedCloseTime(fetchImpl),
  });
}

export const EXPLORER_TX_URL = "https://livenet.xrpl.org/transactions/";

export async function fetchTransaction(txHash, fetchImpl) {
  if (!/^[0-9A-Fa-f]{64}$/.test(txHash ?? "")) throw new Error("invalid hash");
  const tx = await rpc("tx", { transaction: txHash, binary: false }, fetchImpl);
  return {
    hash: txHash.toUpperCase(),
    type: tx.TransactionType,
    account: tx.Account,
    destination: tx.Destination,
    amount: tx.Amount,
    validated: tx.validated === true,
    result: tx.meta?.TransactionResult,
    explorer: EXPLORER_TX_URL + txHash.toUpperCase(),
  };
}

export async function verifyCollateralEscrow(txHash, expected, fetchImpl) {
  if (!/^[0-9A-Fa-f]{64}$/.test(txHash ?? "")) return false;
  if (!expected) return false;
  const tx = await rpc("tx", { transaction: txHash, binary: false }, fetchImpl);
  const proof = verifyValidatedCollateral(tx, expected);
  return proof ? { ...proof, ledgerIndex: tx.ledger_index } : false;
}

export async function verifyLenderCheck(txHash, expected, fetchImpl) {
  if (!/^[0-9A-Fa-f]{64}$/.test(txHash ?? "")) return false;
  const tx = await rpc("tx", { transaction: txHash, binary: false }, fetchImpl);
  const proof = verifyValidatedCheckCreate(tx, {
    lender: expected.lender,
    borrower: expected.borrower,
    amount: expected.amount,
    currency: STABLE_CURRENCY,
    issuer: STABLE_ISSUER,
  });
  if (!proof) return false;
  const objects = await rpc("ledger_entry", {
    index: proof.checkId, ledger_index: "validated",
  }, fetchImpl);
  const check = objects.node;
  if (!check ||
      check.LedgerEntryType !== "Check" || check.Account !== expected.lender ||
      check.Expiration !== undefined ||
      check.Destination !== expected.borrower ||
      check.SendMax?.currency !== STABLE_CURRENCY ||
      check.SendMax?.issuer !== STABLE_ISSUER ||
      Number(check.SendMax?.value) !== expected.amount) return false;
  return proof;
}

export async function issuedTokenBalance(account, fetchImpl) {
  const result = await rpc("account_lines", {
    account, peer: STABLE_ISSUER, ledger_index: "validated",
  }, fetchImpl);
  const line = (result.lines ?? []).find((entry) => entry.currency === STABLE_CURRENCY);
  return line ? Number(line.balance) : 0;
}

export async function verifyBorrowerCheckCash(txHash, expected, fetchImpl) {
  if (!/^[0-9A-Fa-f]{64}$/.test(txHash ?? "")) return false;
  const tx = await rpc("tx", { transaction: txHash, binary: false }, fetchImpl);
  return (expected.minLedgerIndex === undefined || tx.ledger_index >= expected.minLedgerIndex) && verifyValidatedCheckCash(tx, {
    borrower: expected.borrower,
    checkId: expected.checkId,
    amount: expected.amount,
    currency: STABLE_CURRENCY,
    issuer: STABLE_ISSUER,
  });
}

export async function verifyLenderCheckCancel(txHash, expected, fetchImpl) {
  if (!/^[0-9A-Fa-f]{64}$/.test(txHash ?? "")) return false;
  const tx = await rpc("tx", { transaction: txHash, binary: false }, fetchImpl);
  return verifyValidatedCheckCancel(tx, expected);
}

export async function verifyBorrowerFailedCheckCash(txHash, expected, fetchImpl) {
  if (!/^[0-9A-Fa-f]{64}$/.test(txHash ?? "")) return false;
  const tx = await rpc("tx", { transaction: txHash, binary: false }, fetchImpl);
  return verifyValidatedFailedCheckCash(tx, expected);
}

export async function verifyBorrowerPayment(txHash, expected, fetchImpl) {
  if (!/^[0-9A-Fa-f]{64}$/.test(txHash ?? "")) return false;
  const tx = await rpc("tx", { transaction: txHash, binary: false }, fetchImpl);
  const amount = tx.meta?.delivered_amount;
  return tx.validated === true &&
    tx.meta?.TransactionResult === "tesSUCCESS" &&
    tx.TransactionType === "Payment" &&
    tx.Account === expected.borrower &&
    tx.Destination === expected.house &&
    (Number(tx.Flags ?? 0) & 0x00020000) === 0 &&
    (expected.minLedgerIndex === undefined || tx.ledger_index >= expected.minLedgerIndex) &&
    (expected.loanId === undefined || (tx.Memos ?? []).some((entry) =>
      entry.Memo?.MemoData?.toUpperCase() === Buffer.from(expected.loanId).toString("hex").toUpperCase())) &&
    amount?.currency === STABLE_CURRENCY &&
    amount?.issuer === STABLE_ISSUER &&
    Number(amount?.value) === expected.amount;
}

export async function borrowerRepaid(lender, borrower, minRlusd, fetchImpl, { loanId, minLedgerIndex, finishAfter } = {}) {
  let marker;
  let total = 0;
  for (let page = 0; page < 100; page++) {
    const result = await rpc("account_tx", {
      account: lender, ledger_index_min: minLedgerIndex ?? -1, ledger_index_max: -1,
      limit: 200, forward: true, ...(marker ? { marker } : {}),
    }, fetchImpl);
    for (const entry of result.transactions ?? []) {
      const tx = entry.tx ?? entry.tx_json;
      if (!tx || entry.validated !== true || entry.meta?.TransactionResult !== "tesSUCCESS") continue;
      if (tx.TransactionType !== "Payment" || tx.Account !== borrower || tx.Destination !== lender) continue;
      if (finishAfter !== undefined && (!Number.isSafeInteger(tx.date) || tx.date > finishAfter)) continue;
      if (loanId !== undefined && !(tx.Memos ?? []).some((memo) =>
        memo.Memo?.MemoData?.toUpperCase() === Buffer.from(loanId).toString("hex").toUpperCase())) continue;
      const amount = entry.meta.delivered_amount;
      if (amount?.currency !== STABLE_CURRENCY || amount?.issuer !== STABLE_ISSUER) continue;
      const value = Number(amount.value);
      if (!Number.isFinite(value) || value <= 0) continue;
      total += value;
      if (total + 1e-6 >= minRlusd) return true;
    }
    marker = result.marker;
    if (!marker) return false;
  }
  throw new Error("Repayment history scan exceeded page limit");
}
