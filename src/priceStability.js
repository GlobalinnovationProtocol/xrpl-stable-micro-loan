import { PRICE_MAX_DEVIATION } from "./params.js";

export async function requireStablePrice(provider, {
  intervalSeconds = 60, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  report = () => {}, maxPolls = 120,
} = {}) {
  let first;
  let previous;
  let sample;
  for (let observation = 1; observation <= 4; observation++) {
    for (let poll = 0; ; poll++) {
      sample = await provider();
      if (!Number.isFinite(sample.price) || sample.price <= 0 ||
          !Number.isSafeInteger(sample.closeTime)) throw new Error("Invalid live price or validated ledger time");
      if (!previous || sample.closeTime - previous.closeTime >= intervalSeconds) break;
      if (poll >= maxPolls) throw new Error("Validated ledger time did not advance for stability check");
      await sleep(1000);
    }
    first ??= sample;
    if (Math.abs(sample.price - first.price) / first.price > PRICE_MAX_DEVIATION) {
      throw new Error("Price is not stable within 0.25%; collateral/sale not authorized");
    }
    report(sample, observation);
    previous = sample;
    if (observation < 4) await sleep(intervalSeconds * 1000);
  }
  return sample;
}
