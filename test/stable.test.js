import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { STABLECOINS } from "../src/params.js";

// params.js validates the selected stablecoin at import time, so each case runs in a child process.
function loadParams(symbol) {
  const env = { ...process.env };
  delete env.STABLE_SYMBOL;
  if (symbol !== undefined) env.STABLE_SYMBOL = symbol;
  const r = spawnSync(process.execPath, [
    "--input-type=module", "-e",
    "import('./src/params.js').then((p) => console.log(JSON.stringify({ s: p.STABLE_SYMBOL, c: p.STABLE_CURRENCY, i: p.STABLE_ISSUER })))",
  ], { env, encoding: "utf8", cwd: process.cwd() });
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr };
}

test("default stablecoin is RLUSD with Ripple's official issuer", () => {
  const r = loadParams(undefined);
  assert.ok(r.ok, r.err);
  assert.deepEqual(JSON.parse(r.out), {
    s: "RLUSD", c: "524C555344000000000000000000000000000000", i: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
  });
});

test("allowlisted stablecoins without a verified official issuer refuse to start", () => {
  for (const symbol of ["USDC", "USDT", "wDAI"]) {
    assert.equal(STABLECOINS[symbol].issuer, "", `${symbol} must stay disabled until an official issuer is verified`);
    const r = loadParams(symbol);
    assert.equal(r.ok, false, `${symbol} should refuse to start`);
    assert.match(r.err, /no verified official issuer/);
  }
});

test("unknown or free-form stablecoin values are rejected", () => {
  for (const symbol of ["FOO", "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", "524C555344000000000000000000000000000000"]) {
    const r = loadParams(symbol);
    assert.equal(r.ok, false);
    assert.match(r.err, /not an allowed stablecoin/);
  }
});

test("currency codes are the standard 40-hex XRPL codes for 4-letter symbols", () => {
  const hex = (sym) => Buffer.from(sym, "ascii").toString("hex").toUpperCase().padEnd(40, "0");
  assert.equal(STABLECOINS.RLUSD.currency, hex("RLUSD"));
  assert.equal(STABLECOINS.USDC.currency, hex("USDC"));
  assert.equal(STABLECOINS.USDT.currency, hex("USDT"));
  assert.equal(STABLECOINS.wDAI.currency, "DAI");
});
