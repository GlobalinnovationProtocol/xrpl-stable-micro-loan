import { createHmac, randomBytes } from "node:crypto";
import { IP_WINDOW_MS, DAILY_LOAN_CAP, MAX_INVALID_ATTEMPTS } from "./params.js";

const MAX_TRACKED_IDENTITIES = 10000;

export class IpGuard {
  #key = randomBytes(32);
  #validated = new Map();
  #loans = [];
  #invalidAttempts = new Map();
  #blacklisted = new Map();
  #tracked = new Map();
  #now;

  constructor(now = Date.now) {
    this.#now = now;
  }

  #fingerprint(ip) {
    return createHmac("sha256", this.#key).update(String(ip)).digest("hex");
  }

  identity(ip) {
    return this.#fingerprint(ip);
  }

  #track(fp) {
    const now = this.#now();
    const expiresAt = this.#tracked.get(fp);
    if (expiresAt !== undefined && expiresAt <= now) {
      this.#tracked.delete(fp);
    }
    if (!this.#tracked.has(fp) && this.#tracked.size >= MAX_TRACKED_IDENTITIES) return false;
    this.#tracked.set(fp, now + IP_WINDOW_MS);
    return true;
  }

  isBlacklisted(ip) {
    const fp = this.#fingerprint(ip);
    const blockedUntil = this.#blacklisted.get(fp);
    if (blockedUntil !== undefined && blockedUntil > this.#now()) return true;
    if (blockedUntil !== undefined) this.#blacklisted.delete(fp);
    return !this.#track(fp);
  }

  isBlocked(ip) {
    const fp = this.#fingerprint(ip);
    if (!this.#track(fp)) return true;
    if ((this.#blacklisted.get(fp) ?? 0) > this.#now()) return true;
    const until = this.#validated.get(fp);
    return until !== undefined && until > this.#now();
  }

  recordInvalidAttempt(ip) {
    const fp = this.#fingerprint(ip);
    if (!this.#track(fp) || (this.#blacklisted.get(fp) ?? 0) > this.#now()) return;
    const count = (this.#invalidAttempts.get(fp)?.count ?? 0) + 1;
    if (count >= MAX_INVALID_ATTEMPTS) {
      this.#invalidAttempts.delete(fp);
      this.#blacklisted.set(fp, this.#now() + IP_WINDOW_MS);
    } else {
      this.#invalidAttempts.set(fp, { count, expiresAt: this.#now() + IP_WINDOW_MS });
    }
  }

  markLoanProcessed() {
    this.#loans.push(this.#now());
  }

  markValidated(ip, { countLoan = true } = {}) {
    this.#validated.set(this.#fingerprint(ip), this.#now() + IP_WINDOW_MS);
    if (countLoan) this.#loans.push(this.#now());
  }

  dailyCapReached(inFlight = 0) {
    const cutoff = this.#now() - IP_WINDOW_MS;
    while (this.#loans.length && this.#loans[0] <= cutoff) this.#loans.shift();
    return this.#loans.length + inFlight >= DAILY_LOAN_CAP;
  }

  sweep() {
    const now = this.#now();
    for (const [key, until] of this.#validated) {
      if (until <= now) this.#validated.delete(key);
    }
    for (const [key, value] of this.#invalidAttempts) {
      if (value.expiresAt <= now) this.#invalidAttempts.delete(key);
    }
    for (const [key, until] of this.#blacklisted) {
      if (until <= now) this.#blacklisted.delete(key);
    }
    for (const [key, until] of this.#tracked) {
      if (until <= now) this.#tracked.delete(key);
    }
    if (typeof globalThis.gc === "function") globalThis.gc();
  }

  get size() {
    return this.#validated.size;
  }
}
