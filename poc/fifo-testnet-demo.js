import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stdin, stdout } from "node:process";
import { Client, Wallet } from "xrpl";
import { STABLE_CURRENCY as currency } from "../src/params.js";
import { TERMS_TEXT, TERMS_VERSION } from "../src/terms.js";
import { quote } from "../src/loan.js";
import { createCollateralCondition } from "../src/escrow.js";
import { normalizeTransaction, verifyValidatedCollateral, verifyCollateralRelease } from "../src/lenderFifo.js";
import { allocateDemoFifo, validateDemoAmount, verifyDemoPayment } from "../src/demoPolicy.js";
import { makePriceProvider } from "../src/xrpl.js";
import { requireStablePrice } from "../src/priceStability.js";
import { IpGuard } from "../src/guard.js";

const WS = "wss://s.altnet.rippletest.net:51233";
const EXPLORER = "https://testnet.xrpl.org";
const DEFAULT_STATE = join(dirname(fileURLToPath(import.meta.url)), ".fifo-demo-v2.json");
const token = (issuer, value) => ({ currency, issuer, value: String(value) });
const hex = (value) => Buffer.from(JSON.stringify(value)).toString("hex").toUpperCase();

async function reconcileFailedCollateral(client, state, save) {
  for (const loan of state.loans) {
    if (loan.status !== "submitting_collateral") continue;
    if (!Array.isArray(loan.allocations) || loan.allocations.length === 0 ||
        loan.allocations.some((allocation) => allocation.feeHash || allocation.netHash)) {
      throw new Error("Incomplete collateral journal has funding evidence; manual reconciliation required");
    }

    const attempts = [];
    let marker;
    let pages = 0;
    const markers = new Set();
    do {
      if (++pages > 100) throw new Error("Collateral reconciliation exceeded the borrower history page limit");
      const request = {
        command: "account_tx",
        account: loan.borrower,
        ledger_index_min: -1,
        ledger_index_max: -1,
        limit: 200,
        forward: true,
        ...(marker === undefined ? {} : { marker }),
      };
      const { result } = await client.request(request);
      if (result.validated !== true || !Array.isArray(result.transactions)) {
        throw new Error("Validated borrower transaction history is required to reconcile collateral");
      }
      for (const entry of result.transactions) {
        const tx = normalizeTransaction(entry);
        if (tx.TransactionType === "EscrowCreate" && tx.Account === loan.borrower &&
            tx.Destination === loan.destination && tx.Amount === String(loan.minDrops) &&
            tx.Condition === loan.condition && tx.FinishAfter === loan.finishAfter &&
            tx.CancelAfter === loan.cancelAfter && entry.validated === true) {
          attempts.push({ entry, tx });
        }
      }
      marker = result.marker;
      if (marker !== undefined && marker !== null) {
        const key = JSON.stringify(marker);
        if (markers.has(key)) throw new Error("Collateral reconciliation received a repeated history marker");
        markers.add(key);
      }
    } while (marker !== undefined && marker !== null);

    if (attempts.some(({ tx }) => tx.meta?.TransactionResult === "tesSUCCESS")) {
      throw new Error("Matching collateral succeeded on Testnet; preserve the journal for loan reconciliation");
    }

    const { result: objects } = await client.request({
      command: "account_objects", account: loan.borrower, type: "escrow", ledger_index: "validated",
    });
    if (objects.validated !== true || !Array.isArray(objects.account_objects)) {
      throw new Error("Validated borrower escrow objects are required to reconcile collateral");
    }
    const activeEscrow = objects.account_objects.some((object) =>
      object.LedgerEntryType === "Escrow" && object.Account === loan.borrower &&
      object.Destination === loan.destination && object.Amount === String(loan.minDrops) &&
      object.Condition === loan.condition && object.FinishAfter === loan.finishAfter &&
      object.CancelAfter === loan.cancelAfter,
    );
    if (activeEscrow) throw new Error("Matching collateral escrow is active; preserve the journal for loan reconciliation");

    const failedAttempt = attempts.find(({ tx }) =>
      typeof tx.meta?.TransactionResult === "string" &&
      tx.meta.TransactionResult.startsWith("tec"),
    );
    if (attempts.length > 0 && !failedAttempt) {
      throw new Error("Collateral attempt has an ambiguous validated result; manual reconciliation required");
    }

    for (const allocation of loan.allocations) {
      const offer = state.queue.find((entry) => entry.offerTxHash === allocation.offerTxHash);
      if (!offer || !Number.isFinite(offer.matched) || offer.matched < allocation.gross) {
        throw new Error("Collateral failure cannot safely release its FIFO reservation");
      }
      offer.matched = Math.round((offer.matched - allocation.gross) * 1e6) / 1e6;
    }
    loan.status = failedAttempt ? "collateral_failed" : "collateral_not_submitted";
    if (failedAttempt) {
      loan.collateralFailureHash = failedAttempt.entry.hash ?? failedAttempt.tx.hash;
      loan.collateralFailureResult = failedAttempt.tx.meta.TransactionResult;
      loan.collateralFailureLedgerIndex = failedAttempt.entry.ledger_index ?? failedAttempt.tx.ledger_index;
    }
    save(state);
    console.log(
      `[RECONCILED] Collateral attempt ${failedAttempt ? loan.collateralFailureResult : "not found"}; ` +
      "FIFO reservation released after validated-ledger checks. No transaction retried.",
    );
  }
}

export async function main({
  client: suppliedClient, stateFile = DEFAULT_STATE, answers = process.env,
  priceProvider = makePriceProvider(), stabilitySleep,
} = {}) {
  const STATE = answers.DEMO_STATE_FILE || stateFile;
  const rl = createInterface({ input: stdin, output: stdout });
  const client = suppliedClient ?? new Client(WS, { connectionTimeout: 20000, timeout: 20000 });
  let lock;
  const guard = new IpGuard();
  const identity = "local-demo-session";
  const stablePrice = (label) => requireStablePrice(priceProvider, {
    intervalSeconds: 1, sleep: stabilitySleep,
    report: (sample, number) => console.log(`[PRICE ${number}/4] ${label}: ${sample.price} RLUSD/XRP; validated close_time ${sample.closeTime}`),
  });
  const ask = async (prompt, name) => {
    const preset = name && answers[name];
    if (preset !== undefined && preset !== "") {
      console.log(`${prompt} ${preset}`);
      return preset.trim();
    }
    return (await rl.question(`${prompt} `)).trim();
  };
  const yes = async (prompt, name) => {
    for (;;) {
      const answer = (await ask(`${prompt} (y/n):`, name)).toLowerCase();
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      if (name && answers[name]) throw new Error(`Invalid yes/no value for ${name}`);
      console.log("Enter yes or no.");
    }
  };
  const askAmount = async (borrower = false) => {
    const name = borrower ? "DEMO_LOAN_AMOUNT" : "DEMO_LENDER_AMOUNT";
    for (;;) {
      const value = await ask(borrower
        ? "Gross demo loan amount (40-45 RLUSD):"
        : "RLUSD to make available in FIFO (1000, 2000, ... up to 1000000):", name);
      try { return validateDemoAmount(value, borrower); }
      catch (error) {
        if (answers[name]) throw error;
        console.log(error.message);
      }
    }
  };
  const save = (state) => {
    mkdirSync(dirname(STATE), { recursive: true, mode: 0o700 });
    writeFileSync(`${STATE}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(`${STATE}.tmp`, STATE);
  };
  const send = async (label, tx, wallet) => {
    const submitted = await client.submitAndWait(tx, { wallet, autofill: true });
    const hash = submitted.result.hash ?? submitted.result.tx_json?.hash;
    if (!/^[A-Fa-f0-9]{64}$/.test(hash ?? "")) throw new Error(`${label}: missing transaction hash`);
    const { result } = await client.request({ command: "tx", transaction: hash, binary: false });
    const checked = normalizeTransaction(result);
    if (checked.validated !== true || checked.meta?.TransactionResult !== "tesSUCCESS") {
      throw new Error(`${label}: ${checked.meta?.TransactionResult ?? "not validated"}; ${EXPLORER}/transactions/${hash}`);
    }
    console.log(`[VALIDATED tesSUCCESS] ${label}\n  Explorer: ${EXPLORER}/transactions/${hash}`);
    return { ...checked, hash };
  };
  const pay = async (label, wallet, destination, issuer, value) => {
    const tx = await send(label, {
      TransactionType: "Payment", Account: wallet.address, Destination: destination, Amount: token(issuer, value),
    }, wallet);
    if (!verifyDemoPayment(tx, { account: wallet.address, destination, issuer, currency, value })) {
      throw new Error(`${label}: exact delivered amount mismatch; stop for reconciliation`);
    }
    return tx;
  };
  const trust = (wallet, issuer) => send("Create demo RLUSD trust line", {
    TransactionType: "TrustSet", Account: wallet.address, LimitAmount: token(issuer, 1000000000),
  }, wallet);
  const balance = async (address, issuer) => {
    const { result } = await client.request({
      command: "account_lines", account: address, peer: issuer, ledger_index: "validated",
    });
    const line = result.lines.find((l) => l.currency === currency);
    const value = Number(line?.balance ?? 0);
    if (!Number.isFinite(value) || line?.freeze || line?.freeze_peer) throw new Error("Unavailable or frozen demo token balance");
    return value;
  };
  const terms = async (role) => {
    console.log(`\n${role} DISCLAIMER - version ${TERMS_VERSION}\n${TERMS_TEXT}`);
    return yes("Accept the disclaimer before proceeding to KYC?", "DEMO_ACCEPT_TERMS");
  };
  const verifyOffer = async (entry, issuer) => {
    const { result } = await client.request({ command: "tx", transaction: entry.offerTxHash, binary: false });
    const tx = normalizeTransaction(result);
    const memoData = tx.Memos?.[0]?.Memo?.MemoData;
    const memo = memoData ? JSON.parse(Buffer.from(memoData, "hex").toString("utf8")) : null;
    if (tx.validated !== true || tx.meta?.TransactionResult !== "tesSUCCESS" ||
        tx.TransactionType !== "AccountSet" || tx.Account !== entry.address ||
        memo?.type !== "rlusd_fifo_offer_v2" || memo.currency !== currency ||
        memo.issuer !== issuer || memo.amount !== entry.offered ||
        typeof memo.termsVersion !== "string" || memo.kycApproved !== true ||
        entry.status !== "validated_available" || entry.kycApproved !== true ||
        !Number.isFinite(entry.matched) || entry.matched < 0 || entry.matched > entry.offered) {
      throw new Error(`FIFO offer ${entry.offerTxHash} failed exact ledger verification`);
    }
    return {
      ...entry, available: Math.max(0, Math.min(entry.offered - entry.matched, await balance(entry.address, issuer))),
      ledgerIndex: tx.ledger_index, transactionIndex: tx.meta.TransactionIndex,
    };
  };
  const newWallet = async () => (await client.fundWallet()).wallet;
  try {
    console.log("RLUSD FIFO DEMO - XRPL Testnet");
    console.log("1. Borrow 40-45 demo RLUSD\n2. Make 1000-1000000 demo RLUSD available as a lender");
    let role;
    while (!role) {
      const value = await ask("1 = borrower, 2 = lender:", "DEMO_ROLE");
      if (value === "1" || /^borrower$/i.test(value)) role = "BORROWER";
      else if (value === "2" || /^lender$/i.test(value)) role = "LENDER";
      else if (answers.DEMO_ROLE) throw new Error("Invalid DEMO_ROLE");
    }
    const selectedAmount = await askAmount(role === "BORROWER");
    if (!(await terms(role))) return;
    if (!(await yes(`${role}: passed simulated KYC/AML?`, "DEMO_KYC"))) {
      guard.recordInvalidAttempt(identity);
      return;
    }
    console.log(`${role} KYC confirmed. Loading the saved FIFO offers and checking validated RLUSD balances.`);
    if (role === "LENDER" && !(await yes(`Preauthorize ${selectedAmount} RLUSD for FIFO lending?`, "DEMO_PREAUTHORIZE"))) return;
    mkdirSync(dirname(STATE), { recursive: true, mode: 0o700 });
    try { lock = openSync(`${STATE}.lock`, "wx", 0o600); }
    catch (error) { throw new Error(`Cannot exclusively lock demo state; another run may be active: ${error.message}`); }
    const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) :
      { version: 2, currency, queue: [], loans: [] };
    if (state.version !== 2 || state.currency !== currency || !Array.isArray(state.queue) || !Array.isArray(state.loans)) {
      throw new Error("Invalid demo state; do not overwrite it");
    }
    console.log("Connecting to XRPL Testnet...");
    await client.connect();
    await reconcileFailedCollateral(client, state, save);
    const incomplete = state.loans
      .map((loan, index) => ({ loan, index: index + 1 }))
      .filter(({ loan }) => ![
        "funded", "repaid", "settled_excess", "settled_shortfall",
        "collateral_failed", "collateral_not_submitted",
      ].includes(loan.status));
    if (incomplete.length) {
      const details = incomplete.map(({ loan, index }) =>
        `#${index} ${loan.status}, gross ${loan.gross} RLUSD, collateral hash ${loan.escrowHash ?? "not recorded"}`,
      ).join("; ");
      throw new Error(`Demo has unresolved loan state requiring manual reconciliation: ${details}`);
    }
    const lenderFlow = async () => {
      const offered = selectedAmount;
      const lender = await newWallet();
      const issuer = state.issuerSeed ? Wallet.fromSeed(state.issuerSeed) : await newWallet();
      if (!state.issuerSeed) {
        await send("Issuer enables demo transfers", { TransactionType: "AccountSet", Account: issuer.address, SetFlag: 8 }, issuer);
        state.issuerSeed = issuer.seed;
        save(state);
      }
      await trust(lender, issuer.address);
      await pay("Mint Testnet-only RLUSD to lender", issuer, lender.address, issuer.address, offered);
      const memo = { type: "rlusd_fifo_offer_v2", amount: offered, currency, issuer: issuer.address, termsVersion: TERMS_VERSION, kycApproved: true };
      const offer = await send(`Publish FIFO preauthorization for ${offered} RLUSD`, {
        TransactionType: "AccountSet", Account: lender.address, Memos: [{ Memo: { MemoData: hex(memo) } }],
      }, lender);
      state.queue.push({
        address: lender.address, seed: lender.seed, offered, matched: 0, offerTxHash: offer.hash,
        status: "validated_available", kycApproved: true,
      });
      save(state);
      console.log(`FIFO position #${state.queue.length}: ${offered} RLUSD available.`);
      console.log(`Validated offer: ${EXPLORER}/transactions/${offer.hash}`);
      console.log(`Lender: ${EXPLORER}/accounts/${lender.address}`);
    };
    if (role === "LENDER") {
      await lenderFlow();
      if (!(await yes("Continue as borrower?", "DEMO_CONTINUE"))) return;
      if (!(await terms("BORROWER")) || !(await yes("BORROWER: passed simulated KYC/AML?", "DEMO_BORROWER_KYC"))) return;
    }
    if (!state.issuerSeed || !state.queue.length) {
      throw new Error("FIFO queue is empty. First run as lender and publish an offer, then choose borrower.");
    }
    const issuer = Wallet.fromSeed(state.issuerSeed);
    const verified = [];
    for (const entry of state.queue) {
      const offer = await verifyOffer(entry, issuer.address);
      verified.push(offer);
      console.log(`[VALIDATED FIFO] ${offer.available} RLUSD available\n  Explorer: ${EXPLORER}/transactions/${offer.offerTxHash}`);
    }
    const requested = role === "BORROWER" ? selectedAmount : await askAmount(true);
    const allocations = allocateDemoFifo(requested, verified);
    const proposalPrice = await stablePrice("before collateral proposal");
    const q = quote(proposalPrice.price, requested);
    console.log(`Gross ${requested}; loan fee ${q.loanFee}; borrower receives ${q.borrowerReceives}; repays ${q.totalDebt}.`);
    if (!(await yes(`Accept ${q.collateralXrp} XRP collateral and ${q.loanFee} RLUSD loan-fee deduction?`, "DEMO_COLLATERAL"))) return;
    const refreshed = [];
    for (const entry of allocations) refreshed.push(await verifyOffer(entry, issuer.address));
    const finalAllocations = allocateDemoFifo(requested, refreshed);
    const borrower = await newWallet();
    const house = await newWallet();
    const settlement = await newWallet();
    await trust(borrower, issuer.address);
    await trust(house, issuer.address);
    const collateralPrice = await stablePrice("before collateral submission");
    if (Math.abs(collateralPrice.price - proposalPrice.price) / proposalPrice.price > 0.0025) {
      throw new Error("Price changed since borrower consent; request a new collateral quote");
    }
    const borrowerInfo = await client.request({
      command: "account_info", account: borrower.address, ledger_index: "validated",
    });
    const issuerInfo = await client.request({
      command: "account_info", account: issuer.address, ledger_index: "validated",
    });
    const serverInfo = await client.request({ command: "server_info" });
    if (borrowerInfo.result.validated !== true || issuerInfo.result.validated !== true) {
      throw new Error("Validated XRP balances are required before collateral submission");
    }
    const validatedLedger = serverInfo.result.info?.validated_ledger;
    const reserveBase = Number(validatedLedger?.reserve_base_xrp);
    const reserveIncrement = Number(validatedLedger?.reserve_inc_xrp);
    const borrowerData = borrowerInfo.result.account_data;
    const issuerData = issuerInfo.result.account_data;
    if (!Number.isFinite(reserveBase) || reserveBase < 0 ||
        !Number.isFinite(reserveIncrement) || reserveIncrement < 0 ||
        !Number.isSafeInteger(borrowerData?.OwnerCount) ||
        !Number.isSafeInteger(issuerData?.OwnerCount) ||
        !/^\d+$/.test(borrowerData?.Balance ?? "") ||
        !/^\d+$/.test(issuerData?.Balance ?? "")) {
      throw new Error("Validated XRP reserve and account data are required before collateral submission");
    }
    const toDrops = (xrp) => BigInt(Math.ceil(xrp * 1e6));
    const borrowerBalance = BigInt(borrowerData.Balance);
    const issuerBalance = BigInt(issuerData.Balance);
    const borrowerReserve = toDrops(reserveBase + reserveIncrement * (borrowerData.OwnerCount + 1) + 1);
    const collateralDrops = BigInt(Math.round(q.collateralXrp * 1e6));
    const requiredBorrowerBalance = collateralDrops + borrowerReserve;
    if (borrowerBalance < requiredBorrowerBalance) {
      const topUpDrops = requiredBorrowerBalance - borrowerBalance;
      const issuerReserve = toDrops(reserveBase + reserveIncrement * issuerData.OwnerCount + 1);
      if (issuerBalance - topUpDrops < issuerReserve) {
        throw new Error("Testnet issuer XRP balance cannot fund collateral and retain its validated reserve");
      }
      const topUp = await send("Fund borrower Testnet XRP collateral and reserve", {
        TransactionType: "Payment",
        Account: issuer.address,
        Destination: borrower.address,
        Amount: topUpDrops.toString(),
      }, issuer);
      if (topUp.TransactionType !== "Payment" || topUp.Account !== issuer.address ||
          topUp.Destination !== borrower.address || topUp.Amount !== topUpDrops.toString()) {
        throw new Error("Testnet collateral XRP top-up did not deliver the exact validated amount");
      }
      const fundedBorrower = await client.request({
        command: "account_info", account: borrower.address, ledger_index: "validated",
      });
      const fundedBalance = fundedBorrower.result.account_data?.Balance;
      if (fundedBorrower.result.validated !== true || !/^\d+$/.test(fundedBalance ?? "") ||
          BigInt(fundedBalance) - borrowerBalance !== topUpDrops) {
        throw new Error("Testnet collateral XRP top-up did not deliver the exact validated amount");
      }
      console.log(`[VALIDATED] Borrower Testnet XRP top-up: ${Number(topUpDrops) / 1e6} XRP.`);
    }
    if (guard.isBlocked(identity) || guard.dailyCapReached()) throw new Error("Anti-abuse loan limit reached");
    const { condition, fulfillment } = createCollateralCondition();
    const ledger = await client.request({ command: "ledger", ledger_index: "validated" });
    if (ledger.result.validated !== true) throw new Error("No validated ledger for collateral times");
    const finishAfter = ledger.result.ledger.close_time + 20;
    const cancelAfter = finishAfter + 150;
    const expected = {
      borrower: borrower.address, destination: settlement.address, minDrops: Math.round(q.collateralXrp * 1e6),
      condition, finishAfter, cancelAfter,
    };
    const loan = {
      borrower: borrower.address, borrowerSeed: borrower.seed, house: house.address,
      gross: requested, terms: q, fulfillment, settlementSeed: settlement.seed, houseSeed: house.seed,
      status: "submitting_collateral", allocations: finalAllocations.map((a) => ({
        lender: a.address, offerTxHash: a.offerTxHash, gross: a.gross, fee: a.fee, net: a.net,
      })),
      ...expected,
    };
    state.loans.push(loan);
    for (const allocation of finalAllocations) {
      state.queue.find((e) => e.offerTxHash === allocation.offerTxHash).matched += allocation.gross;
    }
    save(state);
    const escrow = await send("Borrower locks XRP collateral FIRST", {
      TransactionType: "EscrowCreate", Account: borrower.address, Destination: settlement.address,
      Amount: String(expected.minDrops), Condition: condition, FinishAfter: finishAfter, CancelAfter: cancelAfter,
    }, borrower);
    if (!verifyValidatedCollateral(escrow, expected)) throw new Error("Collateral does not exactly match agreed terms");
    guard.markValidated(identity);
    console.log("[ANTI-ABUSE] Exclusive FIFO state lock; allocation reserved; validated collateral starts the 24-hour session limit.");
    loan.escrowHash = escrow.hash;
    loan.escrowSequence = escrow.Sequence;
    loan.status = "collateral_locked";
    save(state);
    for (const [index, allocation] of finalAllocations.entries()) {
      const lender = Wallet.fromSeed(allocation.seed);
      if (lender.address !== allocation.address) throw new Error("Demo lender key does not match verified account");
      if (await balance(lender.address, issuer.address) < allocation.gross) throw new Error("Lender balance changed; stop for reconciliation");
      const fee = await pay("Deduct loan fee: lender directly to house FIRST", lender, house.address, issuer.address, allocation.fee);
      loan.allocations[index].feeHash = fee.hash;
      loan.status = "fee_paid_net_pending";
      save(state);
      const net = await pay("Net loan: lender directly to borrower", lender, borrower.address, issuer.address, allocation.net);
      loan.allocations[index].netHash = net.hash;
      save(state);
    }
    loan.status = "funded";
    save(state);
    const received = await balance(borrower.address, issuer.address);
    const houseReceived = await balance(house.address, issuer.address);
    if (Math.abs(received - q.borrowerReceives) > 1e-6 || Math.abs(houseReceived - q.loanFee) > 1e-6) {
      loan.status = "balance_mismatch";
      save(state);
      throw new Error("Final net funding/fee balance mismatch; reconciliation required");
    }
    console.log(`VERIFIED: borrower ${received}, house loan fee ${houseReceived}; debt ${q.totalDebt}. No second loan fee.`);
    console.log(`Borrower: ${EXPLORER}/accounts/${borrower.address}\nHouse: ${EXPLORER}/accounts/${house.address}`);
    console.log("\n1. Repay principal + interest\n2. Default with excess: house keeps excess\n3. Default with shortfall: house covers shortfall");
    let choice;
    while (!choice) {
      const answer = await ask("Choose outcome (1, 2 or 3):", "DEMO_CHOICE");
      if (["1", "2", "3"].includes(answer)) choice = answer;
      else if (answers.DEMO_CHOICE) throw new Error("DEMO_CHOICE must be 1, 2 or 3");
    }
    loan.choice = choice;
    loan.status = "settling";
    save(state);
    const lenderStarts = new Map();
    for (const allocation of finalAllocations) {
      lenderStarts.set(allocation.address, await balance(allocation.address, issuer.address));
    }
    const waitLedger = async (target) => {
      for (;;) {
        const { result } = await client.request({ command: "ledger", ledger_index: "validated" });
        if (result.validated !== true) throw new Error("Ledger time is not validated");
        if (result.ledger.close_time > target) return;
        console.log(`Waiting for validated ledger: ${target - result.ledger.close_time + 1}s`);
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    };
    const lenderDues = finalAllocations.map((a) => ({ ...a, due: quote(collateralPrice.price, a.gross).totalDebt }));
    let expectedHouse = q.loanFee;
    if (choice === "1") {
      const topUp = Math.round((q.totalDebt - received) * 1e6) / 1e6;
      await pay("Demo external repayment funding to borrower", issuer, borrower.address, issuer.address, topUp);
      for (const allocation of lenderDues) {
        const repayment = await pay("Borrower repays gross principal + interest to lender", borrower, allocation.address, issuer.address, allocation.due);
        loan.allocations.find((a) => a.offerTxHash === allocation.offerTxHash).repaymentHash = repayment.hash;
        save(state);
      }
      await waitLedger(cancelAfter);
      const cancelled = await send("Return XRP collateral to repaid borrower", {
        TransactionType: "EscrowCancel", Account: borrower.address, Owner: borrower.address, OfferSequence: escrow.Sequence,
      }, borrower);
      if (!verifyCollateralRelease(cancelled, { ...expected, sequence: escrow.Sequence }, "EscrowCancel")) {
        throw new Error("Collateral return proof missing matching deleted escrow");
      }
      console.log(`[VERIFIED COLLATERAL RETURN] ${q.collateralXrp} XRP returned to borrower after validated total-debt repayment\n  ${EXPLORER}/transactions/${cancelled.hash}`);
      loan.collateralReturnHash = cancelled.hash;
      loan.status = "repaid";
    } else {
      await trust(settlement, issuer.address);
      const due = Math.round(lenderDues.reduce((sum, a) => sum + a.due, 0) * 1e6) / 1e6;
      const proceeds = Math.round(due * (choice === "2" ? 1.2 : 0.8) * 1e6) / 1e6;
      await pay("Fund simulated collateral-sale proceeds", issuer, settlement.address, issuer.address, proceeds);
      await waitLedger(finishAfter);
      const salePrice = await stablePrice("before default collateral release and settlement");
      const released = await send("Release defaulted XRP collateral", {
        TransactionType: "EscrowFinish", Account: settlement.address, Owner: borrower.address,
        OfferSequence: escrow.Sequence, Condition: condition, Fulfillment: fulfillment,
      }, settlement);
      if (!verifyCollateralRelease(released, { ...expected, sequence: escrow.Sequence }, "EscrowFinish")) {
        throw new Error("Default release proof missing matching deleted escrow");
      }
      console.log(`[VERIFIED COLLATERAL RELEASE] ${q.collateralXrp} XRP to settlement\n  ${EXPLORER}/transactions/${released.hash}`);
      loan.stableSalePrice = salePrice.price;
      loan.collateralReleaseHash = released.hash;
      let remainingProceeds = proceeds;
      let totalShortfall = 0;
      for (const allocation of lenderDues) {
        const fromSale = Math.min(remainingProceeds, allocation.due);
        if (fromSale > 0) await pay("Sale proceeds directly to lender", settlement, allocation.address, issuer.address, fromSale);
        remainingProceeds = Math.round((remainingProceeds - fromSale) * 1e6) / 1e6;
        const shortfall = Math.round((allocation.due - fromSale) * 1e6) / 1e6;
        if (shortfall > 0) {
          await pay("Fund house demo shortfall reserve", issuer, house.address, issuer.address, shortfall);
          await pay("House covers lender shortfall", house, allocation.address, issuer.address, shortfall);
          totalShortfall += shortfall;
        }
      }
      if (remainingProceeds > 0) {
        await pay("Excess collateral-sale proceeds to house", settlement, house.address, issuer.address, remainingProceeds);
        expectedHouse += remainingProceeds;
      }
      console.log(`Sale proceeds ${proceeds}; house excess ${remainingProceeds}; house shortfall covered ${totalShortfall.toFixed(6)} RLUSD.`);
      loan.status = choice === "2" ? "settled_excess" : "settled_shortfall";
    }
    for (const allocation of lenderDues) {
      const increase = await balance(allocation.address, issuer.address) - lenderStarts.get(allocation.address);
      if (Math.abs(increase - allocation.due) > 1e-6) throw new Error("Final lender principal + interest verification failed");
      console.log(`[VERIFIED] Lender received ${allocation.due} RLUSD\n  ${EXPLORER}/accounts/${allocation.address}`);
    }
    const finalHouse = await balance(house.address, issuer.address);
    if (Math.abs(finalHouse - expectedHouse) > 1e-6) throw new Error("Final house balance verification failed");
    save(state);
    console.log(`[VERIFIED] Outcome ${loan.status}; house balance ${finalHouse} RLUSD; loan fee charged once.`);
  } finally {
    if (client.isConnected()) await client.disconnect();
    rl.close();
    if (lock !== undefined) { closeSync(lock); unlinkSync(`${STATE}.lock`); }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error("Demo stopped:", error.message);
    console.error("If collateral or funding was submitted, inspect the journal and explorer before retrying. No automatic retry.");
    process.exitCode = 1;
  });
}
