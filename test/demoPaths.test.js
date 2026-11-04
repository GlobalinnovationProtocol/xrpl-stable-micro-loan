import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "xrpl";
import { main } from "../poc/fifo-testnet-demo.js";
import { validateDemoAmount } from "../src/demoPolicy.js";

class Ledger {
  connected = false;
  transactions = new Map();
  balances = new Map();
  nativeBalances = new Map();
  ownerCounts = new Map();
  accountHistory = [];
  time = 1000;
  escrow;
  connect = async () => { this.connected = true; };
  disconnect = async () => { this.connected = false; };
  isConnected = () => this.connected;
  fundWallet = async () => ({ wallet: Wallet.generate() });
  async submitAndWait(tx) {
    const hash = (this.transactions.size + 1).toString(16).padStart(64, "0").toUpperCase();
    const meta = { TransactionResult: "tesSUCCESS", TransactionIndex: 0 };
    if (tx.TransactionType === "TrustSet") {
      this.ownerCounts.set(tx.Account, (this.ownerCounts.get(tx.Account) ?? 0) + 1);
    }
    if (tx.TransactionType === "EscrowCreate") {
      const balance = this.nativeBalances.get(tx.Account) ?? 100000000n;
      const reserve = BigInt(Math.ceil((10 + 2 * ((this.ownerCounts.get(tx.Account) ?? 0) + 1)) * 1e6));
      const amount = BigInt(tx.Amount);
      if (balance < amount + reserve) {
        meta.TransactionResult = "tecUNFUNDED";
      } else {
        this.escrow = tx;
        this.nativeBalances.set(tx.Account, balance - amount);
        this.ownerCounts.set(tx.Account, (this.ownerCounts.get(tx.Account) ?? 0) + 1);
      }
    }
    if (["EscrowCancel", "EscrowFinish"].includes(tx.TransactionType)) {
      meta.AffectedNodes = [{ DeletedNode: { LedgerEntryType: "Escrow", FinalFields: this.escrow } }];
      const amount = BigInt(this.escrow.Amount);
      if (tx.TransactionType === "EscrowCancel") {
        this.nativeBalances.set(tx.Owner, (this.nativeBalances.get(tx.Owner) ?? 100000000n) + amount);
        this.ownerCounts.set(tx.Owner, Math.max(0, (this.ownerCounts.get(tx.Owner) ?? 1) - 1));
      } else {
        this.nativeBalances.set(tx.Account, (this.nativeBalances.get(tx.Account) ?? 100000000n) + amount);
      }
    }
    if (tx.TransactionType === "Payment") {
      if (typeof tx.Amount === "string") {
        const value = BigInt(tx.Amount);
        const prior = this.nativeBalances.get(tx.Account) ?? 100000000n;
        assert.ok(prior >= value, "no account may pay more native XRP than it holds");
        this.nativeBalances.set(tx.Account, prior - value);
        this.nativeBalances.set(tx.Destination, (this.nativeBalances.get(tx.Destination) ?? 100000000n) + value);
        meta.delivered_amount = tx.Amount;
      } else {
        const value = Number(tx.Amount.value);
        if (tx.Account !== tx.Amount.issuer) {
          const prior = this.balances.get(tx.Account) ?? 0;
          assert.ok(prior + 1e-8 >= value, "no account may pay more demo RLUSD than it holds");
          this.balances.set(tx.Account, prior - value);
        }
        this.balances.set(tx.Destination, (this.balances.get(tx.Destination) ?? 0) + value);
        meta.delivered_amount = tx.Amount;
      }
    }
    const result = { ...tx, hash, Sequence: this.transactions.size + 1,
      validated: true, ledger_index: this.transactions.size + 1, meta };
    this.transactions.set(hash, result);
    return { result };
  }
  async request(request) {
    if (request.command === "tx") return { result: this.transactions.get(request.transaction) };
    if (request.command === "ledger") return { result: { validated: true, ledger: { close_time: this.time += 200 } } };
    if (request.command === "account_tx") return { result: { validated: true, transactions: this.accountHistory } };
    if (request.command === "account_objects") return { result: { validated: true, account_objects: [] } };
    if (request.command === "account_info") {
      return { result: { validated: true, account_data: {
        Balance: String(this.nativeBalances.get(request.account) ?? 100000000n),
        OwnerCount: this.ownerCounts.get(request.account) ?? 0,
      } } };
    }
    if (request.command === "server_info") {
      return { result: { info: { validated_ledger: { reserve_base_xrp: 10, reserve_inc_xrp: 2 } } } };
    }
    if (request.command === "account_lines") {
      const currency = "524C555344000000000000000000000000000000";
      return { result: { lines: [{ currency, balance: String(this.balances.get(request.account) ?? 0) }] } };
    }
    throw new Error(`Unexpected request ${request.command}`);
  }
}

test("lender offers are 1000-unit multiples capped at one million; borrower demo stays 40-45", () => {
  for (const value of [1000, 2000, 1000000]) assert.equal(validateDemoAmount(value), value);
  for (const value of [0, 45, 999, 1001, 1000001, 1001000, Infinity, NaN]) assert.throws(() => validateDemoAmount(value));
  for (const value of [40, 45]) assert.equal(validateDemoAmount(value, true), value);
  for (const value of [39, 46, 40.5]) assert.throws(() => validateDemoAmount(value, true));
});

for (const [choice, status] of [["1", "repaid"], ["2", "settled_excess"], ["3", "settled_shortfall"]]) {
  test(`complete demo path ${choice}: ${status}, fee first, gross repayment, collateral release`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "h-demo-path-"));
    const stateFile = join(directory, "state.json");
    const client = new Ledger();
    try {
      let time = 0;
      await main({ client, stateFile,
        priceProvider: async () => ({ price: 4, closeTime: time += 60 }),
        stabilitySleep: async () => {}, answers: {
        DEMO_ROLE: "2", DEMO_LENDER_AMOUNT: "1000", DEMO_ACCEPT_TERMS: "y",
        DEMO_KYC: "y", DEMO_PREAUTHORIZE: "y", DEMO_CONTINUE: "y",
        DEMO_BORROWER_KYC: "y", DEMO_LOAN_AMOUNT: "40", DEMO_COLLATERAL: "y", DEMO_CHOICE: choice,
      } });
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      const loan = state.loans[0];
      assert.equal(loan.status, status);
      assert.equal(loan.terms.loanFee, 1);
      assert.equal(loan.terms.borrowerReceives, 39);
      assert.equal(loan.terms.totalDebt, 40.552329);
      const txs = [...client.transactions.values()];
      const escrow = txs.findIndex((tx) => tx.TransactionType === "EscrowCreate");
      const fee = txs.findIndex((tx) => tx.hash === loan.allocations[0].feeHash);
      const net = txs.findIndex((tx) => tx.hash === loan.allocations[0].netHash);
      assert.ok(escrow < fee && fee < net);
      assert.equal(txs[fee].Account, txs[net].Account);
      assert.equal(txs[fee].Destination, loan.house);
      assert.equal(txs[net].Destination, loan.borrower);
      assert.ok(txs.some((tx) => tx.TransactionType === (choice === "1" ? "EscrowCancel" : "EscrowFinish")));
      assert.equal(client.connected, false);
    } finally { rmSync(directory, { recursive: true }); }
  });
}

test("borrower choice loads saved FIFO after KYC and continues into the loan flow", async () => {
  const directory = mkdtempSync(join(tmpdir(), "h-demo-borrower-"));
  const stateFile = join(directory, "state.json");
  const client = new Ledger();
  let time = 0;
  const priceProvider = async () => ({ price: 4, closeTime: time += 60 });
  try {
    await main({ client, stateFile, priceProvider, stabilitySleep: async () => {}, answers: {
      DEMO_ROLE: "2", DEMO_LENDER_AMOUNT: "1000", DEMO_ACCEPT_TERMS: "y",
      DEMO_KYC: "y", DEMO_PREAUTHORIZE: "y", DEMO_CONTINUE: "n",
    } });
    await main({ client, stateFile, priceProvider, stabilitySleep: async () => {}, answers: {
      DEMO_ROLE: "1", DEMO_LOAN_AMOUNT: "40", DEMO_ACCEPT_TERMS: "y",
      DEMO_KYC: "y", DEMO_COLLATERAL: "y", DEMO_CHOICE: "1",
    } });
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.loans.length, 1);
    assert.equal(state.loans[0].status, "repaid");
  } finally {
    if (client.connected) await client.disconnect();
    rmSync(directory, { recursive: true });
  }
});

test("validated collateral failure is reconciled, FIFO is released, and borrower flow continues", async () => {
  const directory = mkdtempSync(join(tmpdir(), "h-demo-reconcile-"));
  const stateFile = join(directory, "state.json");
  const client = new Ledger();
  let time = 0;
  const priceProvider = async () => ({ price: 1, closeTime: time += 60 });
  try {
    await main({ client, stateFile, priceProvider, stabilitySleep: async () => {}, answers: {
      DEMO_ROLE: "2", DEMO_LENDER_AMOUNT: "1000", DEMO_ACCEPT_TERMS: "y",
      DEMO_KYC: "y", DEMO_PREAUTHORIZE: "y", DEMO_CONTINUE: "n",
    } });
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const offer = state.queue[0];
    offer.matched = 42;
    const borrower = Wallet.generate().address;
    const destination = Wallet.generate().address;
    const condition = "A0258020" + "1".repeat(64) + "810120";
    const failedLoan = {
      status: "submitting_collateral", gross: 42, borrower, destination,
      minDrops: 129711472, condition, finishAfter: 2000, cancelAfter: 2150,
      allocations: [{ offerTxHash: offer.offerTxHash, gross: 42, fee: 1.05, net: 40.95 }],
    };
    state.loans.push(failedLoan);
    writeFileSync(stateFile, JSON.stringify(state));
    client.accountHistory = [{
      hash: "A".repeat(64), validated: true, ledger_index: 30,
      meta: { TransactionResult: "tecUNFUNDED", TransactionIndex: 0 },
      tx_json: {
        TransactionType: "EscrowCreate", Account: borrower, Destination: destination,
        Amount: String(failedLoan.minDrops), Condition: condition,
        FinishAfter: failedLoan.finishAfter, CancelAfter: failedLoan.cancelAfter, Sequence: 29,
      },
    }];
    await main({ client, stateFile, priceProvider, stabilitySleep: async () => {}, answers: {
      DEMO_ROLE: "1", DEMO_LOAN_AMOUNT: "40", DEMO_ACCEPT_TERMS: "y",
      DEMO_KYC: "y", DEMO_COLLATERAL: "y", DEMO_CHOICE: "1",
    } });

    const result = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(result.loans[0].status, "collateral_failed");
    assert.equal(result.loans[0].collateralFailureHash, "A".repeat(64));
    assert.equal(result.loans[0].collateralFailureResult, "tecUNFUNDED");
    assert.equal(result.queue[0].matched, 40);
    assert.equal(result.loans[1].status, "repaid");
    assert.ok([...client.transactions.values()].some((tx) =>
      tx.TransactionType === "Payment" && typeof tx.Amount === "string",
    ));
    assert.equal([...client.transactions.values()].filter((tx) =>
      tx.TransactionType === "EscrowCreate",
    ).length, 1);
  } finally {
    if (client.connected) await client.disconnect();
    rmSync(directory, { recursive: true });
  }
});

test("incomplete collateral journal without FIFO allocation is preserved for reconciliation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "h-demo-recovery-"));
  const stateFile = join(directory, "state.json");
  const client = new Ledger();
  const state = {
    version: 2,
    currency: "524C555344000000000000000000000000000000",
    queue: [],
    loans: [{ status: "submitting_collateral", gross: 42 }],
  };
  writeFileSync(stateFile, JSON.stringify(state));
  try {
    await assert.rejects(
      main({ client, stateFile, answers: {
        DEMO_ROLE: "1", DEMO_LOAN_AMOUNT: "40", DEMO_ACCEPT_TERMS: "y", DEMO_KYC: "y",
      } }),
      /Incomplete collateral journal has funding evidence; manual reconciliation required/,
    );
    assert.equal(client.connected, false);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), state);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("DEMO_STATE_FILE selects an independent journal without overwriting the default journal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "h-demo-state-"));
  const defaultFile = join(directory, "default.json");
  const selectedFile = join(directory, "selected.json");
  const state = {
    version: 2, currency: "524C555344000000000000000000000000000000",
    queue: [], loans: [{ status: "submitting_collateral", gross: 42 }],
  };
  writeFileSync(defaultFile, JSON.stringify(state));
  const client = new Ledger();
  try {
    await assert.rejects(
      main({ client, stateFile: defaultFile, answers: {
        DEMO_STATE_FILE: selectedFile, DEMO_ROLE: "1", DEMO_LOAN_AMOUNT: "40",
        DEMO_ACCEPT_TERMS: "y", DEMO_KYC: "y",
      } }),
      /FIFO queue is empty/,
    );
    assert.deepEqual(JSON.parse(readFileSync(defaultFile, "utf8")), state);
    assert.equal(existsSync(selectedFile), false);
    assert.equal(client.connected, false);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
