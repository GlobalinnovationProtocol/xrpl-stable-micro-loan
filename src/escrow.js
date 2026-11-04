import { createHash, randomBytes } from "node:crypto";

export function createCollateralCondition() {
  const preimage = randomBytes(32);
  const condition = ("A0258020" + createHash("sha256").update(preimage).digest("hex") + "810120").toUpperCase();
  const fulfillment = ("A0228020" + preimage.toString("hex")).toUpperCase();
  return { condition, fulfillment };
}
