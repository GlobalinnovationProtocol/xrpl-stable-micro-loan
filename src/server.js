import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { Client, xrpToDrops } from "xrpl";
import { IpGuard } from "./guard.js";
import { KycRegistry } from "./kyc.js";
import { buildCollateralEscrowPayload, buildRepaymentPayload, isAddress, quote } from "./loan.js";
import {
  allocateFifoChecks, buildCheckCancel, buildCheckCash, validateLoanAmount,
} from "./lenderFifo.js";
import { createCollateralCondition } from "./escrow.js";
import { LoanSessionStore } from "./loanSession.js";
import {
  CLEANUP_INTERVAL_MS, ESCROW_GRACE_SECONDS, LOAN_REQUEST_TTL_MS, MAX_BODY_BYTES,
  PRINCIPAL_STABLE, STABLE_CURRENCY, STABLE_ISSUER, STABLE_SYMBOL, TERM_DAYS,
} from "./params.js";
import { loadFeeWallet } from "./settlement/wallets.js";
import { loadXamanClient } from "./settlement/xaman.js";
import { runSettlement as runLoanSettlement } from "./settlement/settle.js";
import {
  issuedTokenBalance, makePriceProvider, ammPool, verifyBorrowerCheckCash, verifyBorrowerPayment,
  verifyCollateralEscrow, verifyLenderCheck, verifyLenderCheckCancel,
} from "./xrpl.js";
import { TERMS_TEXT, TERMS_VERSION, termsAccepted } from "./terms.js";
import { requireStablePrice } from "./priceStability.js";

const DEFAULT_PRINCIPAL = PRINCIPAL_STABLE;
const TOKEN_CURRENCY = STABLE_CURRENCY;
const TOKEN_ISSUER = STABLE_ISSUER;

export function clientIp(req) {
  const hops = Number(process.env.TRUST_PROXY ?? 0);
  if (!(hops > 0)) return req.socket.remoteAddress;
  const header = req.headers["x-forwarded-for"];
  if (typeof header !== "string") return req.socket.remoteAddress;
  const parts = header.split(",").map((s) => s.trim()).filter(Boolean);
  const index = parts.length - hops;
  return parts[index] ?? req.socket.remoteAddress;
}

const SECRET_PATTERN_CONFIRM = /\bs[1-9A-HJ-NP-Za-km-z]{24,34}\b|secret|seed|private|mnemonic/i;

function reply(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

export function createLoanServer({
  house, kyc, guard = new IpGuard(), priceProvider, verifyEscrow, verifyLenderCheck,
  getLenderBalance, verifyCheckCash, verifyLoanFee, verifyCheckCancel,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  settlement = house, sessions = new LoanSessionStore(), runSettlement, xamanClient,
} = {}) {
  if (!isAddress(house)) throw new Error("house address required");
  if (!isAddress(settlement)) throw new Error("settlement address required");
  if (!kyc) throw new Error("KYC registry required in the KYC build");
  const pendingIps = new Set();

  const initializeSession = (session) => {
    if (!Array.isArray(session.checkCashHashes)) session.checkCashHashes = [];
    if (!Array.isArray(session.checkCashAmounts)) session.checkCashAmounts = [];
    if (!Array.isArray(session.checkCancelHashes)) session.checkCancelHashes = [];
    if (!Number.isFinite(session.fundingPaid)) session.fundingPaid = 0;
    if (!Number.isSafeInteger(session.nextCheckCash)) session.nextCheckCash = 0;
    if (!Number.isSafeInteger(session.nextCheckCancel)) session.nextCheckCancel = 0;
    return session;
  };

  const hasUsedTransaction = (session, hash) => {
    const normalized = typeof hash === "string" ? hash.toUpperCase() : "";
    return !normalized || sessions.hasTransactionHash(normalized) ||
      session.checkCashHashes.includes(normalized) ||
      session.checkCancelHashes.includes(normalized);
  };

  const fundingAction = (session) => {
    initializeSession(session);
    const target = session.principal - session.issuanceFee;
    if (session.fundingPaid < target) {
      const index = session.nextCheckCash;
      const allocation = session.lenderAllocations[index];
      if (!allocation) throw new Error("FIFO Checks do not cover the net loan amount");
      const amount = Math.min(allocation.amount, target - session.fundingPaid);
      return {
        type: "cash", index, allocation, amount,
        payloadKey: `checkCash${index + 1}`,
        transaction: buildCheckCash({
          borrower: session.borrower, checkId: allocation.checkId, amount,
          currency: TOKEN_CURRENCY, issuer: TOKEN_ISSUER,
        }),
      };
    }

    if (!session.fundingCancellationStarted) {
      const lastIndex = session.nextCheckCash - 1;
      const lastAmount = session.checkCashAmounts[lastIndex];
      const lastAllocation = session.lenderAllocations[lastIndex];
      session.nextCheckCancel = lastAllocation && lastAmount < lastAllocation.amount
        ? lastIndex
        : session.nextCheckCash;
      session.fundingCancellationStarted = true;
    }
    const index = session.nextCheckCancel;
    const allocation = session.lenderAllocations[index];
    if (allocation) {
      return {
        type: "cancel", index, allocation,
        payloadKey: `checkCancel${index + 1}`,
        transaction: buildCheckCancel({ lender: allocation.lender, checkId: allocation.checkId }),
      };
    }
    return { type: "complete" };
  };

  const markFunded = (loanId) => {
    const funded = sessions.markFunded(loanId);
    if (funded) guard.markLoanProcessed();
    return funded;
  };

  const fundingResponse = async (session) => {
    const action = fundingAction(session);
    if (action.type === "complete") {
      if (!markFunded(session.loanId)) {
        throw new Error("loan funding state is inconsistent");
      }
      return {
        funded: true,
        loanId: session.loanId,
        grossPrincipal: session.principal,
        borrowerReceives: session.principal - session.issuanceFee,
        loanFeeAlreadyDeducted: session.issuanceFee,
        repayment: buildRepaymentPayload({
          lender: session.lender, borrower: session.borrower, principal: session.principal,
          interest: quote(1, session.principal).interest, loanId: session.loanId,
        }),
      };
    }
    const signing = await createSigningPayload(
      session,
      action.payloadKey,
      action.transaction,
      action.type === "cash"
        ? `Cash FIFO loan funding ${action.index + 1} of ${session.lenderAllocations.length}`
        : `Cancel the unused remainder of FIFO Check ${action.index + 1} for loan ${session.loanId}`,
    );
    if (action.type === "cash") {
      return {
        funded: false,
        nextLenderCheckCash: action.transaction,
        checkCashIndex: action.index + 1,
        checkCashTotal: session.lenderAllocations.length,
        ...(signing ? { signing } : {}),
      };
    }
    return {
      funded: false,
      checkCancellationRequired: true,
      nextLenderCheckCancel: action.transaction,
      checkCancelIndex: action.index + 1,
      checkCancelTotal: session.lenderAllocations.length,
      ...(signing ? { signing } : {}),
    };
  };

  const createSigningPayload = async (session, key, txjson, instruction) => {
    if (!xamanClient) return undefined;
    const existingUuid = session[`${key}PayloadUuid`];
    const existingUrl = session[`${key}PayloadUrl`];
    if (existingUuid && existingUrl) return { uuid: existingUuid, url: existingUrl };
    const payload = await xamanClient.createSigningPayload(txjson, {
      identifier: `${session.loanId}:${key}`,
      instruction,
    });
    if (!payload?.uuid || !payload?.url) throw new Error("Xaman signing payload was incomplete");
    session[`${key}PayloadUuid`] = payload.uuid;
    session[`${key}PayloadUrl`] = payload.url;
    return payload;
  };

  const validatePayloadHash = async (session, key, txHash) => {
    const uuid = session[`${key}PayloadUuid`];
    if (!uuid) return !xamanClient;
    if (typeof txHash !== "string" || !/^[0-9a-f]{64}$/i.test(txHash)) return false;
    const payload = await xamanClient.getPayload(uuid);
    const response = payload?.response;
    return payload?.meta?.resolved === true && payload?.meta?.signed === true &&
      typeof response?.txid === "string" &&
      response.txid.toUpperCase() === txHash.toUpperCase();
  };

  const server = createServer((req, res) => {
    const ip = clientIp(req);
    let chunks = [];
    const wipe = () => {
      chunks = [];
    };
    res.on("close", wipe);

    if (req.method === "GET" && req.url === "/health") return reply(res, 200, { ok: true });
    if (req.method === "GET" && req.url === "/terms") return reply(res, 200, { version: TERMS_VERSION, text: TERMS_TEXT });
    const route = req.url;
    if (req.method !== "POST" || ![
      "/loan/request", "/loan/confirm", "/loan/fee/confirm",
      "/loan/disbursement/confirm", "/loan/funding/confirm", "/loan/deficit/confirm",
    ].includes(route)) {
      return reply(res, 404, { error: "not found" });
    }

    if (guard.isBlacklisted(ip) || (route === "/loan/request" && guard.isBlocked(ip))) {
      req.destroy();
      return res.destroy();
    }
    if (route === "/loan/request" && guard.dailyCapReached(sessions.inFlightCount())) {
      return reply(res, 503, { error: "daily loan capacity reached" });
    }

    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        wipe();
        req.destroy();
        return res.destroy();
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      let releaseRequest = false;
      let verificationSession;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        wipe();
        if (SECRET_PATTERN_CONFIRM.test(raw)) {
          return reply(res, 400, { error: "secrets are never accepted" });
        }
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return reply(res, 400, { error: "bad request" });
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return reply(res, 400, { error: "bad request" });
        }
        const unexpectedHash = (value, key = "") => {
          if (typeof value === "string") return /^[0-9a-f]{64}$/i.test(value) && key !== "txHash";
          return value && typeof value === "object" && Object.entries(value).some(([name, item]) => unexpectedHash(item, name));
        };
        if (unexpectedHash(body)) return reply(res, 400, { error: "unexpected secret-sized field" });
        const requester = guard.identity(ip);
        if (route !== "/loan/request") {
          const session = sessions.get(body.loanId);
          if (!session) return reply(res, 409, { error: "unknown loan session" });
          if (body.sessionToken !== session.sessionToken) {
            guard.recordInvalidAttempt(ip);
            return reply(res, 403, { error: "loan session authorization required" });
          }
          if (session.verifyingEscrow || session.verifyingCheckCash) return reply(res, 409, { error: "verification already in progress" });
          verificationSession = session;
          session.verifyingCheckCash = true;
        } else {
          if (pendingIps.has(requester)) return reply(res, 429, { error: "loan request already in progress" });
          pendingIps.add(requester);
          releaseRequest = true;
        }

        if (route === "/loan/confirm") {
          if (!verifyEscrow) return reply(res, 503, { error: "escrow verification not configured" });
          const session = sessions.get(body.loanId);
          if (!session) return reply(res, 409, { error: "escrow not validated" });
          const collateralHash = typeof body.txHash === "string" ? body.txHash.toUpperCase() : "";
          if (session.status === "pending_collateral") {
            if (!await validatePayloadHash(session, "collateral", collateralHash)) {
              return reply(res, 409, { error: "collateral transaction does not match the approved Xaman payload" });
            }
            if (sessions.hasTransactionHash(collateralHash)) return reply(res, 409, { error: "transaction proof already used" });
            if (guard.isBlocked(ip) || guard.dailyCapReached()) return reply(res, 429, { error: "loan limit reached" });
            const verified = await verifyEscrow(collateralHash, session);
            if (!verified) {
              guard.recordInvalidAttempt(ip);
              return reply(res, 409, { error: "escrow not validated" });
            }
            if (guard.isBlocked(ip) || guard.dailyCapReached()) return reply(res, 429, { error: "loan limit reached" });
            if (!sessions.confirmCollateral(body.loanId, {
              sequence: verified.sequence, txHash: collateralHash, ledgerIndex: verified.ledgerIndex,
            })) return reply(res, 409, { error: "collateral confirmation could not be persisted" });
            guard.markValidated(ip, { countLoan: false });
          } else if (session.status !== "collateral_locked" || session.collateralHash !== collateralHash) {
            return reply(res, 409, { error: "loan is not awaiting this collateral confirmation" });
          }
          const feeTransaction = {
            TransactionType: "Payment", Account: session.lender, Destination: house,
            Amount: { currency: TOKEN_CURRENCY, issuer: TOKEN_ISSUER, value: String(session.issuanceFee) },
            Memos: [{ Memo: { MemoData: Buffer.from(session.loanId).toString("hex").toUpperCase() } }],
          };
          const feeSigning = await createSigningPayload(
            session, "fee", feeTransaction, `Pay the ${session.issuanceFee} ${STABLE_SYMBOL} loan fee for loan ${session.loanId}`,
          );
          return reply(res, 200, {
            confirmed: true,
            loanId: body.loanId,
            nextLenderLoanFee: feeTransaction,
            ...(feeSigning ? { signing: feeSigning } : {}),
          });
        }

        if (route === "/loan/fee/confirm") {
          const session = sessions.get(body.loanId);
          if (!session || session.status !== "collateral_locked") return reply(res, 409, { error: "loan not awaiting fee" });
          if (!verifyLoanFee) return reply(res, 503, { error: "loan fee verification not configured" });
          const hash = typeof body.txHash === "string" ? body.txHash.toUpperCase() : "";
          if (!session.feePaid && (sessions.hasTransactionHash(hash) ||
              !await validatePayloadHash(session, "fee", hash))) {
            return reply(res, 409, { error: "loan fee proof was already used or does not match the approved Xaman payload" });
          }
          if (!session.feePaid) {
            const valid = await verifyLoanFee(hash, {
              borrower: session.lender, house, amount: session.issuanceFee, loanId: session.loanId,
              minLedgerIndex: session.minLedgerIndex,
            });
            if (!valid || sessions.hasTransactionHash(hash)) {
              guard.recordInvalidAttempt(ip);
              return reply(res, 409, { error: "loan fee not validated or already used" });
            }
            sessions.update(body.loanId, { feePaid: true, feeHash: hash });
          } else if (session.feeHash !== hash) {
            return reply(res, 409, { error: "a different fee transaction has already been accepted" });
          }
          const allocation = session.lenderAllocations[0];
          const cashTransaction = buildCheckCash({
            borrower: session.borrower, checkId: allocation.checkId,
            amount: session.principal - session.issuanceFee, currency: TOKEN_CURRENCY, issuer: TOKEN_ISSUER,
          });
          const cashSigning = await createSigningPayload(
            session, "checkCash", cashTransaction, `Cash the net loan amount for loan ${session.loanId}`,
          );
          return reply(res, 200, {
            feePaid: true, nextLenderCheckCash: cashTransaction,
            ...(cashSigning ? { signing: cashSigning } : {}),
          });
        }

        if (route === "/loan/disbursement/confirm") {
          if (!verifyCheckCash) return reply(res, 503, { error: "CheckCash verification not configured" });
          const session = sessions.get(body.loanId);
          if (!session || session.status !== "collateral_locked") {
            return reply(res, 409, { error: "validated collateral is required before CheckCash" });
          }
          if (!session.feePaid) return reply(res, 409, { error: "loan fee must validate before net disbursement" });
          const hash = typeof body.txHash === "string" ? body.txHash.toUpperCase() : "";
          if (xamanClient && session.fundingHash === hash && session.nextCheckCash > 0) {
            const allocation = session.lenderAllocations[session.nextCheckCash - 1];
            const cancelTransaction = buildCheckCancel({ lender: allocation.lender, checkId: allocation.checkId });
            const cancelSigning = await createSigningPayload(
              session, "checkCancel", cancelTransaction,
              `Cancel the unused remainder of the funded Check for loan ${session.loanId}`,
            );
            return reply(res, 200, {
              funded: false, checkCancellationRequired: true,
              nextLenderCheckCancel: cancelTransaction, signing: cancelSigning,
            });
          }
          const allocation = session.lenderAllocations[session.nextCheckCash];
          if (!allocation) return reply(res, 409, { error: "all FIFO lender Checks are already cashed" });
          if (sessions.hasTransactionHash(hash) ||
              !await validatePayloadHash(session, "checkCash", hash)) {
            return reply(res, 409, { error: "CheckCash proof was already used or does not match the approved Xaman payload" });
          }
          const verified = await verifyCheckCash(hash, {
            borrower: session.borrower,
            checkId: allocation.checkId,
            amount: session.principal - session.issuanceFee,
            minLedgerIndex: session.minLedgerIndex,
          });
          if (!verified) {
            guard.recordInvalidAttempt(ip);
            return reply(res, 409, { error: "CheckCash transaction does not match the next FIFO allocation" });
          }
          sessions.update(body.loanId, {
            nextCheckCash: session.nextCheckCash + 1,
            fundingHash: hash,
          });
          if (xamanClient) {
            const checkCashIndex = session.nextCheckCash - 1;
            const remaining = session.lenderAllocations[checkCashIndex + 1];
            if (remaining) {
              const cashTransaction = buildCheckCash({
                borrower: session.borrower, checkId: remaining.checkId, amount: remaining.amount,
                currency: TOKEN_CURRENCY, issuer: TOKEN_ISSUER,
              });
              const cashSigning = await createSigningPayload(
                session, `checkCash${checkCashIndex + 1}`, cashTransaction,
                `Cash FIFO loan funding ${checkCashIndex + 2} of ${session.lenderAllocations.length}`,
              );
              return reply(res, 200, {
                funded: false, nextLenderCheckCash: cashTransaction,
                checkCashIndex: session.nextCheckCash + 1,
                checkCashTotal: session.lenderAllocations.length,
                ...(cashSigning ? { signing: cashSigning } : {}),
              });
            }
            const allocation = session.lenderAllocations[checkCashIndex];
            const cancelTransaction = buildCheckCancel({ lender: allocation.lender, checkId: allocation.checkId });
            const cancelSigning = await createSigningPayload(
              session, "checkCancel", cancelTransaction,
              `Cancel the unused remainder of the funded Check for loan ${session.loanId}`,
            );
            return reply(res, 200, {
              funded: false, checkCancellationRequired: true,
              nextLenderCheckCancel: cancelTransaction, signing: cancelSigning,
            });
          }
          if (session.nextCheckCash < session.lenderAllocations.length) {
            const next = session.lenderAllocations[session.nextCheckCash];
            return reply(res, 200, {
              funded: false,
              nextLenderCheckCash: buildCheckCash({
                borrower: session.borrower, checkId: next.checkId, amount: next.amount,
                currency: TOKEN_CURRENCY, issuer: TOKEN_ISSUER,
              }),
              checkCashIndex: session.nextCheckCash + 1,
              checkCashTotal: session.lenderAllocations.length,
            });
          }
          if (!markFunded(body.loanId)) return reply(res, 409, { error: "loan funding state is inconsistent" });
          return reply(res, 200, {
            funded: true,
            loanId: body.loanId,
            grossPrincipal: session.principal,
            borrowerReceives: session.principal - session.issuanceFee,
            loanFeeAlreadyDeducted: session.issuanceFee,
            repayment: buildRepaymentPayload({
              lender: session.lender, borrower: session.borrower, principal: session.principal,
              interest: quote(1, session.principal).interest, loanId: session.loanId,
            }),
          });
        }

        if (route === "/loan/funding/confirm") {
          const session = sessions.get(body.loanId);
          if (!session || session.status !== "collateral_locked" ||
              session.nextCheckCash !== session.lenderAllocations.length || !session.feePaid) {
            return reply(res, 409, { error: "funding must be validated before Check cancellation" });
          }
          const allocation = session.lenderAllocations[session.nextCheckCash - 1];
          const hash = typeof body.txHash === "string" ? body.txHash.toUpperCase() : "";
          if (!allocation || !verifyCheckCancel ||
              sessions.hasTransactionHash(hash) ||
              !await validatePayloadHash(session, "checkCancel", hash) ||
              !await verifyCheckCancel(hash, { lender: allocation.lender, checkId: allocation.checkId })) {
            return reply(res, 409, { error: "Check cancellation is not validated for the funded FIFO Check" });
          }
          sessions.update(body.loanId, { checkCancelHash: hash });
          if (!markFunded(body.loanId)) return reply(res, 409, { error: "loan funding state is inconsistent" });
          return reply(res, 200, {
            funded: true,
            loanId: session.loanId,
            grossPrincipal: session.principal,
            borrowerReceives: session.principal - session.issuanceFee,
            loanFeeAlreadyDeducted: session.issuanceFee,
            repayment: buildRepaymentPayload({
              lender: session.lender, borrower: session.borrower, principal: session.principal,
              interest: quote(1, session.principal).interest, loanId: session.loanId,
            }),
          });
        }

        if (route === "/loan/deficit/confirm") {
          const session = sessions.get(body.loanId);
          if (!session || session.status !== "deficit_pending_approval" ||
              !session.deficitPayloadUuid || !verifyLoanFee) {
            return reply(res, 409, { error: "no pending Xaman house shortfall approval" });
          }
          const hash = typeof body.txHash === "string" ? body.txHash.toUpperCase() : "";
          if (!hash || sessions.hasTransactionHash(hash) ||
              !await validatePayloadHash(session, "deficit", hash)) {
            return reply(res, 409, { error: "shortfall transaction does not match the approved Xaman payload" });
          }
          const valid = await verifyLoanFee(hash, {
            borrower: session.house,
            house: session.lender,
            amount: session.deficitAmount,
            loanId: session.loanId,
            minLedgerIndex: session.settlementLedgerIndex,
          });
          if (!valid) return reply(res, 409, { error: "validated house shortfall does not match this loan" });
          sessions.update(body.loanId, { deficitHash: hash, status: "settled" });
          return reply(res, 200, {
            settled: true, loanId: session.loanId, deficitPaid: session.deficitAmount,
          });
        }

        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return reply(res, 400, { error: "bad request" });
        }
        if (!termsAccepted(body)) {
          return reply(res, 403, { error: "terms of use must be accepted by lender and borrower", termsVersion: TERMS_VERSION });
        }
        const { borrower } = body;
        const principal = body.principal ?? DEFAULT_PRINCIPAL;
        if (principal !== DEFAULT_PRINCIPAL) return reply(res, 400, { error: `mainnet loan must be exactly ${DEFAULT_PRINCIPAL} ${STABLE_SYMBOL}` });
        try {
          validateLoanAmount(principal);
        } catch (error) {
          return reply(res, 400, { error: error.message });
        }
        if (!isAddress(borrower)) return reply(res, 400, { error: "valid borrower address required" });
        if (!kyc.isApproved(borrower)) {
          guard.recordInvalidAttempt(ip);
          return reply(res, 403, { error: "KYC approval required for borrower" });
        }
        if (!Array.isArray(body.lenderChecks) || body.lenderChecks.length === 0 ||
            body.lenderChecks.length > 20) {
          return reply(res, 400, { error: "lenderChecks must contain 1 to 20 FIFO CheckCreate proofs" });
        }
        if (!verifyLenderCheck || !getLenderBalance) {
          return reply(res, 503, { error: "live lender Check and balance verification is not configured" });
        }
        const offers = [];
        for (const [index, candidate] of body.lenderChecks.entries()) {
          if (!candidate || !isAddress(candidate.lender) || candidate.lender === borrower) {
            return reply(res, 400, { error: "distinct valid lender required" });
          }
          if (!kyc.isApproved(candidate.lender)) {
            guard.recordInvalidAttempt(ip);
            return reply(res, 403, { error: "KYC approval required for every FIFO lender" });
          }
          try {
            validateLoanAmount(candidate.amount);
          } catch (error) {
            return reply(res, 400, { error: `invalid FIFO offer: ${error.message}` });
          }
          const proof = await verifyLenderCheck(candidate.txHash, {
            lender: candidate.lender, borrower, amount: candidate.amount,
          });
          if (!proof) {
            guard.recordInvalidAttempt(ip);
            return reply(res, 409, { error: "lender CheckCreate is not a validated active Check for this borrower" });
          }
          const balance = await getLenderBalance(candidate.lender);
          if (!Number.isFinite(balance) || balance < 0) {
            return reply(res, 503, { error: "unable to verify lender token balance" });
          }
          offers.push({
            lender: candidate.lender, checkId: proof.checkId, amount: candidate.amount,
            balance: balance - sessions.reservedBalance(candidate.lender), status: "validated_available",
            ledgerIndex: proof.ledgerIndex, transactionIndex: proof.transactionIndex ?? index,
          });
        }
        if (!priceProvider) return reply(res, 503, { error: "price source not configured" });
        const second = await requireStablePrice(priceProvider, { sleep });

        const terms = quote(second.price, principal);
        for (const offer of offers) {
          const candidate = body.lenderChecks.find((c) => c.lender === offer.lender);
          const proof = await verifyLenderCheck(candidate.txHash, { lender: offer.lender, borrower, amount: offer.amount });
          if (!proof || proof.checkId !== offer.checkId) return reply(res, 409, { error: "FIFO Check no longer available" });
          offer.balance = await getLenderBalance(offer.lender) - sessions.reservedBalance(offer.lender);
        }
        let lenderAllocations;
        try {
          lenderAllocations = allocateFifoChecks(principal, offers, (address) => kyc.isApproved(address));
        } catch (error) {
          return reply(res, 409, { error: error.message });
        }
        if (guard.dailyCapReached(sessions.inFlightCount())) return reply(res, 429, { error: "daily loan capacity reached" });
        const { condition, fulfillment } = createCollateralCondition();
        const collateralDrops = Number(xrpToDrops(terms.collateralXrp));
        const finishAfter = second.closeTime + TERM_DAYS * 24 * 60 * 60;
        const cancelAfter = finishAfter + ESCROW_GRACE_SECONDS;
        const loanId = sessions.create({
          lender: lenderAllocations[0].lender, borrower, destination: settlement, minDrops: collateralDrops,
          condition, fulfillment, finishAfter, cancelAfter,
          principal, issuanceFee: terms.issuanceFee, lenderAllocations, requester, house,
        });
        const collateralEscrow = buildCollateralEscrowPayload({
          borrower, destination: settlement, collateralDrops, condition, finishAfter, cancelAfter,
        });
        const collateralSigning = await createSigningPayload(
          sessions.get(loanId), "collateral", collateralEscrow,
          `Lock ${terms.collateralXrp} XRP collateral for loan ${loanId}`,
        );
        return reply(res, 200, {
          loanId,
          sessionToken: sessions.get(loanId).sessionToken,
          terms,
          lenderAllocations,
          unsigned: {
            collateralEscrow,
          },
          ...(collateralSigning ? { signing: collateralSigning } : {}),
        });
      } catch (error) {
        console.error("loan request failed:", error);
        return reply(res, 503, { error: "loan service could not complete the request" });
      } finally {
        if (releaseRequest) pendingIps.delete(guard.identity(ip));
        if (verificationSession) verificationSession.verifyingCheckCash = false;
      }
    });
  });

  server.maxConnections = 256;
  server.maxHeadersCount = 64;
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;

  let sweeping = false;
  const timer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      guard.sweep();
      sessions.sweep(LOAN_REQUEST_TTL_MS);
      if (runSettlement && priceProvider) {
        const { closeTime } = await priceProvider();
        for (const session of sessions.due(closeTime)) {
          try {
            await runSettlement(session);
          } catch (error) {
            console.error("settlement did not complete:", session.loanId, session.status, error.message);
          }
        }
      }
    } catch (error) {
      console.error("loan sweep failed:", error.message);
    } finally {
      sweeping = false;
    }
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return server;
}

export async function main() {
  const house = process.env.HOUSE_ADDRESS;
  const feeWallet = loadFeeWallet();
  if (feeWallet.wallet.address === feeWallet.address) {
    throw new Error("FEE_ADDRESS signing credential must be a Regular Key, not the master key");
  }
  const settlementUrl = process.env.XRPL_WS_URL ?? "wss://xrplcluster.com/";
  if (!settlementUrl.startsWith("wss://") || /testnet|devnet|altnet/i.test(settlementUrl)) {
    throw new Error("XRPL_WS_URL must point to XRPL mainnet over secure WebSocket");
  }
  if (!isAddress(house) || house === feeWallet.address) {
    throw new Error("distinct valid HOUSE_ADDRESS and FEE_ADDRESS are required");
  }
  const xamanClient = loadXamanClient();
  const stateDirectory = process.env.STATE_DIRECTORY ?? join(process.cwd(), "var");
  const sessions = new LoanSessionStore({
    filePath: process.env.SESSION_STORE_FILE ?? join(stateDirectory, "loan-sessions.json"),
  });
  const client = new Client(settlementUrl);
  try {
    await client.connect();
    const feeAccount = await client.request({
      command: "account_info", account: feeWallet.address, ledger_index: "validated",
    });
    const feeAccountRoot = feeAccount.result?.account_data;
    if (!feeAccount.result?.validated || feeAccountRoot?.Account !== feeWallet.address ||
        feeAccountRoot.RegularKey !== feeWallet.wallet.address) {
      throw new Error("fee signing key is not authorized for FEE_ADDRESS on the validated mainnet ledger");
    }
    const priceProvider = makePriceProvider();
    const server = createLoanServer({
      house,
      settlement: feeWallet.address,
      kyc: KycRegistry.fromFile(process.env.KYC_FILE ?? "kyc-approved.txt"),
      priceProvider,
      verifyEscrow: (hash, session) => verifyCollateralEscrow(hash, session),
      verifyLenderCheck: (hash, expected) => verifyLenderCheck(hash, expected),
      getLenderBalance: (address) => issuedTokenBalance(address),
      verifyCheckCash: (hash, expected) => verifyBorrowerCheckCash(hash, expected),
      verifyLoanFee: (hash, expected) => verifyBorrowerPayment(hash, expected),
      verifyCheckCancel: (hash, expected) => verifyLenderCheckCancel(hash, expected),
      runSettlement: (session) => runLoanSettlement(session, {
        client, feeWallet, houseAddress: house, priceProvider, poolProvider: () => ammPool(), xummClient: xamanClient,
      }),
      sessions,
      xamanClient,
    });
    const port = Number(process.env.PORT ?? 8080);
    const host = process.env.HOST ?? "127.0.0.1";
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    console.log(`mainnet loan service listening on ${host}:${port}`);
    const shutdown = () => server.close();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    server.once("close", () => {
      client.disconnect();
      sessions.close();
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    });
    return server;
  } catch (error) {
    if (client.isConnected()) client.disconnect();
    sessions.close();
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
