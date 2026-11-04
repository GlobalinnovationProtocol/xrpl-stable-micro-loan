import { readFileSync } from "node:fs";
import { isAddress } from "./loan.js";

export class KycRegistry {
  #approved;

  constructor(addresses = []) {
    this.#approved = new Set(addresses.filter(isAddress));
  }

  static fromFile(path) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim());
    return new KycRegistry(lines.filter((l) => l && !l.startsWith("#")));
  }

  isApproved(address) {
    return this.#approved.has(address);
  }

  get size() {
    return this.#approved.size;
  }
}
