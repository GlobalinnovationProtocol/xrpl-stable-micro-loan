export const PRINCIPAL_STABLE = 1000;
export const ISSUANCE_FEE_RATE = 0.025;
export const LTV = 0.25;
export const TERM_DAYS = 42;
export const ANNUAL_INTEREST_RATE = 0.12;
export const PRICE_MAX_DEVIATION = 0.0025;
export const PRICE_MIN_INTERVAL_SECONDS = 60;
export const IP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DAILY_LOAN_CAP = 300;
export const MAX_INVALID_ATTEMPTS = 3;
export const CLEANUP_INTERVAL_MS = 300000;
export const MAX_BODY_BYTES = 4096;
export const RIPPLE_EPOCH_OFFSET = 946684800;

// Lent stablecoin allowlist. Collateral is always XRP (native escrow); only the issued currency the
// loan is denominated in is configurable, and ONLY from this hard-coded list -- never from a free
// address. An entry with an empty issuer is a known currency code with no verified official issuer
// on XRPL mainnet yet (Circle does not issue USDC on XRPL; Tether does not issue USDT; DAI only
// exists as third-party wraps): selecting it refuses to start. Enabling one later is a one-line
// change here (verified issuer address), not a new code path.
export const STABLECOINS = {
  RLUSD: { currency: "524C555344000000000000000000000000000000", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", official: "Ripple USD (Standard Custody & Trust Co.)" },
  USDC: { currency: "5553444300000000000000000000000000000000", issuer: "", official: null },
  USDT: { currency: "5553445400000000000000000000000000000000", issuer: "", official: null },
  wDAI: { currency: "DAI", issuer: "", official: null },
};

export const STABLE_SYMBOL = process.env.STABLE_SYMBOL?.trim() || "RLUSD";
const selected = STABLECOINS[STABLE_SYMBOL];
if (!selected) {
  throw new Error(`STABLE_SYMBOL "${STABLE_SYMBOL}" is not an allowed stablecoin (${Object.keys(STABLECOINS).join(", ")})`);
}
if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(selected.issuer)) {
  throw new Error(`${STABLE_SYMBOL} has no verified official issuer on XRPL mainnet: not enabled`);
}
export const STABLE_CURRENCY = selected.currency;
export const STABLE_ISSUER = selected.issuer;

export const LOAN_REQUEST_TTL_MS = 60 * 60 * 1000;
export const ESCROW_GRACE_SECONDS = 3 * 24 * 60 * 60;
export const XAMAN_DEFICIT_TTL_MINUTES = 24 * 60;
