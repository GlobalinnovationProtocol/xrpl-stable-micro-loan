import test from "node:test";
import assert from "node:assert/strict";
import { ammXrpPrice, fetchTransaction, validatedCloseTime } from "../src/xrpl.js";

test("live: validated ledger close_time is recent", async () => {
  const closeTime = await validatedCloseTime();
  const rippleNow = Math.floor(Date.now() / 1000) - 946684800;
  assert.ok(Math.abs(rippleNow - closeTime) < 120, "ledger close_time should be within 2 minutes of now");
});

test("live: XRP/RLUSD price is positive", async () => {
  assert.ok((await ammXrpPrice()) > 0);
});

test("live: an unknown transaction hash is rejected by the node", async () => {
  await assert.rejects(fetchTransaction("0".repeat(64)));
});
