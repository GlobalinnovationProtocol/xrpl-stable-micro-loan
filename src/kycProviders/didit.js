import { createHmac, timingSafeEqual } from "node:crypto";
import { isAddress } from "../loan.js";

export class DiditKycRegistry {
  #approved = new Set();

  approve(address) {
    if (isAddress(address)) this.#approved.add(address);
  }

  revoke(address) {
    this.#approved.delete(address);
  }

  isApproved(address) {
    return this.#approved.has(address);
  }

  get size() {
    return this.#approved.size;
  }
}

export function verifyDiditWebhookSignature(rawBody, signatureHeader, secret) {
  if (typeof signatureHeader !== "string" || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signatureHeader, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function applyDiditWebhook(kyc, payload) {
  if (!payload || typeof payload !== "object") return;
  const { address, status } = payload;
  if (!isAddress(address)) return;
  if (status === "approved") kyc.approve(address);
  else if (status === "revoked" || status === "declined") kyc.revoke(address);
}
