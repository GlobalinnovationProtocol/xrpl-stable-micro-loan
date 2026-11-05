import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export class LoanSessionStore {
  #sessions = new Map();
  #reserved = new Set();
  #filePath;
  #lockPath;
  #lockFd;
  #lockToken;
  #batching = false;

  constructor({ filePath } = {}) {
    if (!filePath) return;
    this.#filePath = filePath;
    this.#lockPath = `${filePath}.lock`;
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.#lockToken = randomUUID();
    try {
      this.#lockFd = openSync(this.#lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const ownerContents = readFileSync(this.#lockPath, "utf8");
      const owner = ownerContents.trim().split(/\s+/);
      const pid = Number(owner[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("loan session store lock is invalid");
      try {
        process.kill(pid, 0);
        throw new Error("loan session store is already open in another process");
      } catch (probeError) {
        if (probeError.code !== "ESRCH") throw probeError;
      }
      if (readFileSync(this.#lockPath, "utf8") !== ownerContents) {
        throw new Error("loan session store lock changed during stale-lock recovery");
      }
      unlinkSync(this.#lockPath);
      this.#lockFd = openSync(this.#lockPath, "wx", 0o600);
    }
    try {
      writeFileSync(this.#lockFd, `${process.pid} ${this.#lockToken}\n`);
      fsyncSync(this.#lockFd);
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, "utf8"));
        if (data?.version !== 1 || !Array.isArray(data.sessions)) {
          throw new Error("loan session store format is invalid");
        }
        for (const session of data.sessions) {
          if (!session || typeof session.loanId !== "string" ||
              !Array.isArray(session.lenderAllocations) || typeof session.status !== "string") {
            throw new Error("loan session store contains an invalid session");
          }
          this.#sessions.set(session.loanId, this.#track(session));
          if (["pending_collateral", "pending_reconciliation", "collateral_locked"].includes(session.status)) {
            for (const allocation of session.lenderAllocations.slice(session.nextCheckCash ?? 0)) {
              this.#reserved.add(allocation.checkId);
            }
          }
        }
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #track(session) {
    return new Proxy(session, {
      set: (target, property, value) => {
        const previous = target[property];
        target[property] = value;
        if (this.#batching) return true;
        try {
          this.#persist();
        } catch (error) {
          target[property] = previous;
          throw error;
        }
        return true;
      },
    });
  }

  #persist() {
    if (!this.#filePath) return;
    const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, sessions: [...this.#sessions.values()] }));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.#filePath);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      }
      throw new Error(`failed to persist loan session store: ${error.message}`, { cause: error });
    }
  }

  close() {
    if (this.#lockFd === undefined) return;
    closeSync(this.#lockFd);
    this.#lockFd = undefined;
    const owner = existsSync(this.#lockPath) ? readFileSync(this.#lockPath, "utf8").trim() : "";
    if (owner === `${process.pid} ${this.#lockToken}`) unlinkSync(this.#lockPath);
  }

  create({
    lender, borrower, destination, minDrops, condition, fulfillment, finishAfter, cancelAfter,
    principal, issuanceFee, lenderAllocations = [], standbyOffers = [], requester, house,
  }) {
    if (lenderAllocations.some((a) => this.#reserved.has(a.checkId))) throw new Error("FIFO Check already reserved");
    const loanId = randomUUID();
    for (const allocation of lenderAllocations) this.#reserved.add(allocation.checkId);
    this.#sessions.set(loanId, this.#track({
      loanId, lender, borrower, destination, minDrops, condition, fulfillment,
      finishAfter, cancelAfter, principal, issuanceFee, lenderAllocations, standbyOffers, droppedAllocations: [],
      requester, house, sessionToken: randomUUID(),
      nextCheckCash: 0, feePaid: false, verifyingCheckCash: false, verifyingEscrow: false,
      status: "pending_collateral", createdAt: Date.now(),
    }));
    try {
      this.#persist();
    } catch (error) {
      this.#sessions.delete(loanId);
      for (const allocation of lenderAllocations) this.#reserved.delete(allocation.checkId);
      throw error;
    }
    return loanId;
  }

  isReserved(checkId) {
    return this.#reserved.has(checkId);
  }

  // Swap the not-yet-cashed tail of a session's allocations (lender left, Check cancelled, balance
  // gone) for replacements. Cashed allocations are never touched; reservations follow the change.
  replaceAllocations(loanId, { allocations, standbyOffers, dropped = [] }) {
    const session = this.#sessions.get(loanId);
    if (!session) return false;
    const cashed = session.lenderAllocations.slice(0, session.nextCheckCash);
    if (allocations.slice(0, cashed.length).some((a, i) => a.checkId !== cashed[i].checkId)) {
      throw new Error("cashed FIFO allocations cannot be replaced");
    }
    const previous = new Set(session.lenderAllocations.slice(session.nextCheckCash).map((a) => a.checkId));
    const next = new Set(allocations.slice(session.nextCheckCash).map((a) => a.checkId));
    for (const id of next) if (!previous.has(id) && this.#reserved.has(id)) throw new Error("FIFO Check already reserved");
    const ok = this.update(loanId, {
      lenderAllocations: allocations,
      standbyOffers,
      droppedAllocations: [...(session.droppedAllocations ?? []), ...dropped],
    });
    if (!ok) return false;
    for (const id of previous) if (!next.has(id)) this.#reserved.delete(id);
    for (const id of next) this.#reserved.add(id);
    return true;
  }

  reservedBalance(lender) {
    return [...this.#sessions.values()]
      .filter((s) => ["pending_collateral", "pending_reconciliation", "collateral_locked"].includes(s.status))
      .flatMap((s) => s.lenderAllocations.slice(s.nextCheckCash))
      .filter((a) => a.lender === lender)
      .reduce((sum, a) => sum + a.amount, 0);
  }

  get(loanId) {
    return typeof loanId === "string" ? this.#sessions.get(loanId) : undefined;
  }

  update(loanId, changes) {
    const session = this.#sessions.get(loanId);
    if (!session || !changes || typeof changes !== "object" || Array.isArray(changes)) return false;
    const previous = {};
    this.#batching = true;
    try {
      for (const [key, value] of Object.entries(changes)) {
        previous[key] = session[key];
        session[key] = value;
      }
    } finally {
      this.#batching = false;
    }
    try {
      this.#persist();
    } catch (error) {
      this.#batching = true;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete session[key];
        else session[key] = value;
      }
      this.#batching = false;
      throw error;
    }
    return true;
  }

  hasTransactionHash(hash) {
    const normalized = typeof hash === "string" ? hash.toUpperCase() : "";
    return [...this.#sessions.values()].some((session) =>
      [session.collateralHash, session.feeHash, session.fundingHash, session.checkCancelHash, session.deficitHash]
        .includes(normalized));
  }

  findByDeficitPayload(uuid) {
    return [...this.#sessions.values()].find((session) => session.deficitPayloadUuid === uuid);
  }

  markLocked(loanId, escrow = {}) {
    const session = this.#sessions.get(loanId);
    if (!session) return;
    this.update(loanId, { escrowSequence: escrow.sequence, status: "collateral_locked" });
  }

  confirmCollateral(loanId, { sequence, txHash, ledgerIndex }) {
    return this.update(loanId, {
      escrowSequence: sequence,
      collateralHash: txHash.toUpperCase(),
      minLedgerIndex: ledgerIndex,
      status: "collateral_locked",
    });
  }

  markFunded(loanId) {
    const session = this.#sessions.get(loanId);
    if (!session || session.status !== "collateral_locked" ||
        session.nextCheckCash !== session.lenderAllocations.length || !session.feePaid) return false;
    this.update(loanId, { status: "loan_active" });
    for (const allocation of session.lenderAllocations) this.#reserved.delete(allocation.checkId);
    return true;
  }

  markSettled(loanId) {
    const session = this.#sessions.get(loanId);
    if (session) {
      this.update(loanId, { status: "settled" });
      for (const allocation of session.lenderAllocations) this.#reserved.delete(allocation.checkId);
    }
  }

  due(nowRippleSeconds) {
    return [...this.#sessions.values()].filter(
      (s) => (s.status === "loan_active" && nowRippleSeconds >= s.finishAfter) ||
        s.status === "collateral_released" ||
        (s.status === "repaid_waiting_cancel" && nowRippleSeconds > s.cancelAfter),
    );
  }

  inFlightCount() {
    let count = 0;
    for (const session of this.#sessions.values()) {
      if (session.status === "pending_collateral" || session.status === "collateral_locked") count++;
    }
    return count;
  }

  sweep(maxAgeMs, now = Date.now()) {
    for (const session of this.#sessions.values()) {
      if (session.status === "pending_collateral" && now - session.createdAt > maxAgeMs) {
        session.status = "expired";
        for (const allocation of session.lenderAllocations ?? []) this.#reserved.delete(allocation.checkId);
      }
    }
  }

  get size() {
    return this.#sessions.size;
  }
}
