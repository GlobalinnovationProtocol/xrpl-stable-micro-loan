import { quote } from "../loan.js";
import { PRICE_MAX_DEVIATION, STABLE_CURRENCY, STABLE_ISSUER } from "../params.js";
import { ammExpectedProceeds, borrowerRepaid } from "../xrpl.js";
import { sellCollateralOnAmm } from "./ammSale.js";
import { requestDeficitApproval } from "./xaman.js";
import { requireStablePrice } from "../priceStability.js";
import { verifyCollateralRelease } from "../lenderFifo.js";

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const rlusd = (value) => ({ currency: STABLE_CURRENCY, issuer: STABLE_ISSUER, value: String(round6(value)) });

function validated(result, label) {
  const tx = result?.result ?? result;
  if (!tx || tx.validated !== true || tx.meta?.TransactionResult !== "tesSUCCESS") {
    throw new Error(`${label} not validated successfully`);
  }
  return tx;
}

async function pay(client, feeWallet, destination, amount) {
  const result = await client.submitAndWait({
    TransactionType: "Payment", Account: feeWallet.address, Destination: destination, Amount: rlusd(amount),
  }, { wallet: feeWallet.wallet });
  const tx = validated(result, "Settlement payment");
  const delivered = tx.meta.delivered_amount;
  if (delivered?.currency !== STABLE_CURRENCY || delivered?.issuer !== STABLE_ISSUER ||
      Number(delivered?.value) !== amount) throw new Error("Settlement payment delivered amount mismatch");
}

export async function runSettlement(session, {
  client, feeWallet, houseAddress = session.house, priceProvider,
  requestApproval = requestDeficitApproval, xummClient, fetchImpl, stabilitySleep, poolProvider,
} = {}) {
  if (!["loan_active", "collateral_locked", "repaid_waiting_cancel", "collateral_released"].includes(session.status)) throw new Error("Loan is not ready for settlement");
  const { lender, borrower, minDrops, condition, fulfillment } = session;
  const due = quote(1, session.principal).totalDebt;
  const released = session.status === "collateral_released";
  if (!released && (session.status === "repaid_waiting_cancel" || await borrowerRepaid(lender, borrower, due, fetchImpl, {
    loanId: session.loanId, minLedgerIndex: session.minLedgerIndex,
    finishAfter: session.loanId ? session.finishAfter : undefined,
  }))) {
    if (!session.loanId) {
      session.status = "repaid_on_time";
      return { outcome: "repaid_on_time", collateralCancelAfter: session.cancelAfter };
    }
    session.status = "repaid_waiting_cancel";
    const { result } = await client.request({ command: "ledger", ledger_index: "validated" });
    if (result.validated !== true || !Number.isSafeInteger(result.ledger?.close_time)) throw new Error("Validated ledger time required for collateral return");
    if (result.ledger.close_time <= session.cancelAfter) {
      return { outcome: "repaid_waiting_cancel", collateralCancelAfter: session.cancelAfter };
    }
    session.status = "returning_collateral";
    try {
      const cancelled = validated(await client.submitAndWait({
        TransactionType: "EscrowCancel", Account: feeWallet.address, Owner: borrower, OfferSequence: session.escrowSequence,
      }, { wallet: feeWallet.wallet }), "Collateral return");
      if (!verifyCollateralRelease(cancelled, {
        borrower, destination: session.destination, minDrops, sequence: session.escrowSequence,
      }, "EscrowCancel")) throw new Error("Collateral return proof does not match this loan");
      session.collateralReturnHash = cancelled.hash ?? cancelled.tx_json?.hash;
      session.status = "repaid_on_time";
      return { outcome: "repaid_on_time", collateralReturnHash: session.collateralReturnHash };
    } catch (error) {
      session.status = "reconciliation_required";
      throw error;
    }
  }
  if (!houseAddress || houseAddress === feeWallet.address) throw new Error("Separate house destination required for excess and shortfall");
  if (session.destination !== feeWallet.address) throw new Error("Collateral must release to the sale account");
  const retryable = async (fn) => {
    try { return await fn(); } catch (error) { error.retryable = true; throw error; }
  };
  let price;
  if (!released) {
    ({ price } = await requireStablePrice(priceProvider, { sleep: stabilitySleep }));
    if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid settlement price");
  }
  try {
    if (!released) {
      session.status = "settling";
      const release = validated(await client.submitAndWait({
        TransactionType: "EscrowFinish", Account: feeWallet.address, Owner: borrower,
        OfferSequence: session.escrowSequence, Condition: condition, Fulfillment: fulfillment,
      }, { wallet: feeWallet.wallet }), "Collateral release");
      if (!verifyCollateralRelease(release, {
        borrower, destination: session.destination, minDrops, sequence: session.escrowSequence,
      }, "EscrowFinish")) throw new Error("Collateral release proof does not match this loan");
      session.collateralReleaseHash = release.hash ?? release.tx_json?.hash;
      session.status = "collateral_released";
    }
    const salePrice = await retryable(() => requireStablePrice(priceProvider, { sleep: stabilitySleep }));
    if (price !== undefined && Math.abs(salePrice.price - price) / price > PRICE_MAX_DEVIATION) {
      const error = new Error("Sale price changed after collateral release; waiting for a stable price");
      error.retryable = true;
      throw error;
    }
    const ceiling = minDrops / 1e6 * salePrice.price;
    const expected = poolProvider
      ? ammExpectedProceeds(await retryable(() => poolProvider()), minDrops / 1e6)
      : ceiling;
    const floor = Math.min(ceiling, expected) * (1 - PRICE_MAX_DEVIATION);
    const saleResult = await sellCollateralOnAmm({
      client, feeWallet, collateralDrops: minDrops, ceilingRlusd: ceiling, floorRlusd: floor,
    });
    const saleTx = saleResult?.result ?? saleResult;
    if (saleTx?.validated === true && String(saleTx.meta?.TransactionResult ?? "").startsWith("tec")) {
      const error = new Error("Collateral swap rejected on ledger; will retry on a stable price");
      error.retryable = true;
      throw error;
    }
    const sale = validated(saleResult, "Collateral sale");
    const delivered = sale.meta.delivered_amount;
    const proceeds = Number(delivered?.value);
    if (delivered?.currency !== STABLE_CURRENCY || delivered?.issuer !== STABLE_ISSUER ||
        !Number.isFinite(proceeds) || proceeds < floor || proceeds > ceiling) {
      throw new Error("Collateral sale proceeds do not match validated bounds");
    }
    if (!Number.isSafeInteger(sale.ledger_index) || sale.ledger_index < 1) {
      throw new Error("validated sale ledger index required before settlement payments");
    }
    session.saleProceeds = proceeds;
    session.settlementLedgerIndex = sale.ledger_index;
    const fromSale = Math.min(proceeds, due);
    if (fromSale > 0) await pay(client, feeWallet, lender, fromSale);
    const deficit = round6(Math.max(0, due - proceeds));
    const excess = round6(Math.max(0, proceeds - due));
    if (deficit > 0) {
      const approval = await requestApproval({
        xummClient,
        loanId: session.loanId,
        txjson: {
          TransactionType: "Payment", Account: houseAddress, Destination: lender, Amount: rlusd(deficit),
          Memos: [{ Memo: { MemoData: Buffer.from(session.loanId).toString("hex").toUpperCase() } }],
        },
      });
      if (!approval) throw new Error("Xaman shortfall approval request failed");
      session.deficitAmount = deficit;
      session.deficitPayloadUuid = approval.uuid ?? approval.meta?.uuid ?? approval.meta?.payload_uuidv4;
      session.deficitPayloadUrl = approval.url ?? approval.next?.always;
      session.status = "deficit_pending_approval";
      return {
        outcome: "deficit_pending_approval",
        lenderReceived: fromSale,
        deficit,
        approvalUrl: session.deficitPayloadUrl,
        approvalPayloadUuid: session.deficitPayloadUuid,
      };
    }
    if (excess > 0) await pay(client, feeWallet, houseAddress, excess);
    session.status = "settled";
    return { outcome: "settled", lenderReceives: due, houseKeepsExcess: excess, houseAbsorbs: 0 };
  } catch (error) {
    if (!error.retryable) session.status = "reconciliation_required";
    throw error;
  }
}
