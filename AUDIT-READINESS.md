# H-kyc-audit: audit readiness (2026-10-20)

Status: **not mainnet-ready, not audit-cleared.** The code can be handed to an external
security firm as code under review, provided the items below are disclosed to them.
No live mainnet transaction has ever been sent. This is an internal read-through, not an audit.

## Scope

- XRPL application in Node.js (ESM, `xrpl` ^5.3.0). No Solidity, no Hooks, no on-chain contract:
  all logic is in off-chain JavaScript that builds, verifies and signs XRPL transactions.
- Mainnet entry point: `src/server.js` (`main()`); settlement: `src/settlement/*`;
  FIFO Check allocation and proofs: `src/lenderFifo.js`; durable journal: `src/loanSession.js`;
  abuse limits: `src/guard.js`; ledger reads: `src/xrpl.js`; deployment: `deploy/h-kyc.service`.
- Out of scope / testnet only: `poc/`.

## Test status

`node --test` (Node v24.20.0, Windows, 2026-10-20): **61 of 61 pass** after the changes below.
The first run that day had 5 failures; an earlier recorded run
(`.tsupgrader/runtime-validation/standalone-result.json`) also shows `tests-pass` failed and predates these changes.
The `live` test queries the XRP Ledger (read-only); everything else uses local fixtures.

Changes made to reach green:

- `src/server.js`: invalid JSON (`{not json`, empty body) now returns 400. It previously returned 503
  because `JSON.parse` sat inside the generic error handler. Invalid JSON is not counted as an
  invalid attempt by the IP guard (open question for the firm).
- `test/settlement.test.js`: the deficit-settlement fixture now has a `loanId`; stale-session test updated for the expiry change below.
- `test/stress.test.js`: a repeated authenticated `/loan/confirm` from a blocked IP is now expected
  to return 200 (idempotent re-fetch of the fee payload), matching the documented design.

Behaviour changes made after the first read-through (operator requirements):

- **Price source is the official XRP/RLUSD AMM pool only** (`ammXrpPrice`/`ammPool` in `src/xrpl.js`,
  `amm_info` on the validated ledger, pool asset identity checked). The order-book `bestXrpPrice`
  (ask side, `limit: 1`) is removed. The existing check still applies: 4 observations at least 60 s of
  validated-ledger time apart, within 0.25%.
- **Swap, not market sale.** Collateral is swapped XRP -> RLUSD through the AMM to repay the lender.
  The `DeliverMin` floor is now derived from the pool's constant-product output after trading fee and
  price impact (`ammExpectedProceeds`), minus the 0.25% tolerance. Before this, a floor at spot minus 0.25%
  would have been below the AMM fee plus impact for the collateral size and the swap would have failed.
- **Unstable price waits and retries.** Before release: nothing is submitted and the loan stays `loan_active`.
  After release: the loan moves to `collateral_released` (retried by the sweep; `EscrowFinish` is never
  repeated) until a stable price allows the swap. A ledger-rejected swap (`tec*`) is also retried.
  Ambiguous failures (no validated result, payout failure, proof mismatch) still go to
  `reconciliation_required`.
- **Payouts only from validated proceeds.** The lender receives `min(proceeds, due)` after the swap is validated;
  excess goes to the house; any shortfall is a Xaman approval from the house account.
- **Daily cap counts confirmed, funded loans only** (`guard.markLoanProcessed` on the funding confirmation),
  plus in-flight sessions at admission time so the cap cannot be oversold. Requests/quotes no longer count.
- **Abandoned sessions expire.** An unconfirmed `pending_collateral` session past `LOAN_REQUEST_TTL_MS`
  becomes `expired` and releases its reserved FIFO Checks. A funded loan that is settled also frees them.
  Lenders are made available in FIFO again by creating a new Check (Checks are single-use); the server keeps
  no lender queue and cannot create Checks on a lender's behalf.

Operator statement (operational, **not enforced by code**): the fee account pays out of house funds only
as collateral is swapped, and the owner can withdraw from it. The firm should treat the fee account as a
hot wallet holding house funds.

## Known risk areas to point the auditors at

1. **Hot-key custody.** The fee account's Regular Key is loaded by the server and automatically signs
   `EscrowFinish`, `EscrowCancel`, the collateral swap and settlement payments. All collateral is
   released to that account. Key compromise or a logic bug can lose all collateral.
2. **Collateral is released before the swap succeeds.** XRPL cannot swap escrowed XRP and has no atomic
   release-and-swap, so `EscrowFinish` must come first. Mitigation: stable-price gate before release,
   retryable `collateral_released` state, pool-derived floor. Residual: XRP sits in the fee account
   until a stable price allows the swap; a hard AMM failure or deep price move leaves the lender unpaid.
3. **Price source.** AMM spot (pool ratio) with the 4-observation stability check. A single pool can be moved
   within a block by large trades; the stability window and the floor limit but do not remove this.
4. **Expired sessions.** If a borrower locks an escrow after the session expired, the XRP stays in escrow
   (recoverable by EscrowCancel after CancelAfter) and no loan is created. A `collateral_locked` session
   whose Check cashing never completes still holds its reservation (no timeout).
5. **Cap accounting.** `/loan/request` is limited by confirmed loans plus in-flight sessions; unconfirmed
   requests can still occupy in-flight slots until they expire (1 h).
6. **Plaintext secrets in the journal.** Session JSON stores the escrow `fulfillment` and `sessionToken`
   (file mode 0600, single-process lock, no backup/restore procedure documented).
7. **Floating-point money.** Amounts are JS `Number` rounded to 6 decimals, with exact-equality checks on
   delivered amounts (`settle.js`, `xrpl.js`).
8. **Two ledger endpoints.** Verification reads use hard-coded `https://xrplcluster.com/` (`src/xrpl.js`);
   settlement uses `XRPL_WS_URL`. They can disagree.
9. **Legal and KYC.** Terms text is a placeholder owned by the legal team and is **out of scope** for
   this security audit (`TERMS_VERSION` is dated 2026-10-21). KYC is a static address file (`KYC_FILE`); `src/kycProviders/didit.js` is not
   referenced by `src/server.js`.
10. **Not exercised live.** Xaman payload resolution, fee Regular Key authorization, Check replay,
    journal interruption/restart and settlement exactness have only been tested against fixtures.

## Do not send to the firm

- `poc/.fifo-demo-v2.json`, `poc/.fifo-demo-state.json`: Testnet wallet signing seeds.
- `.tsupgrader/`, `node_modules/` (use `npm ci` from `package-lock.json`).
- Any mainnet seed, Xaman key or KYC list. The folder is inside OneDrive, so check what has synced.

## Before submission

- [x] Green `node --test` run (61/61).
- [x] Invalid JSON returns 400.
- [x] Legal terms: owned by the legal team, declared out of scope for the security audit.
- [ ] Give the firm a pinned commit (the folder is not a git repository) and this document.

## Stablecoin configuration (single code path, allowlisted)

Collateral is always XRP. The lent stablecoin is selected at startup with `STABLE_SYMBOL` (default `RLUSD`) from the
hard-coded allowlist `STABLECOINS` in `src/params.js`: currency code and issuer are never taken from a free value.
Entries without a verified official XRPL mainnet issuer (USDC, USDT, wDAI today) refuse to start. Every issuer/currency
check in `src/xrpl.js`, `src/settlement/*.js` and `src/loan.js` reads `STABLE_CURRENCY` / `STABLE_ISSUER`, so enabling a
second stablecoin later is a one-line allowlist change under the same audited code, not a new branch. `test/stable.test.js`
covers the default, the refusal of disabled entries and of unknown symbols.

## Lender exit and FIFO re-allocation (2026-11-05)

A lender's FIFO commitment is an XRPL Check they own: they can `CheckCancel` it or move their stablecoins out at any time;
nothing in the protocol prevents that, by design. The service therefore never trusts an offer without re-reading the
validated ledger:

- `/loan/request`: each supplied Check is verified (`ledger_entry`) and the lender's live balance read; unavailable
  lenders are **skipped** (reported in `skippedLenders`) instead of failing the request; the loan is allocated to the next
  FIFO lender (`allocateFifoChecks`). Offers not needed are kept as `standbyOffers` on the session.
- `/loan/confirm` (XRP escrow validated) and `/loan/fee/confirm`: before asking anyone to pay, `refreshFunding()` re-verifies
  every not-yet-cashed allocation and replaces lenders who left with standby offers in FIFO order. The fee is requested from
  the lender who actually funds.
- `/loan/funding/retry`: if the ledger rejects a CheckCash (validated `tec*`), the borrower submits that hash as proof
  (`verifyValidatedFailedCheckCash`); the lender is dropped and the next lender's Check is offered. If the dropped lender
  had already paid the 25 fee, `feeRefundDue` is recorded on the session for the house to refund.
- `/loan/funding/add`: additional FIFO Checks for the same borrower can be supplied to cover a shortfall at any stage.
- Cashed allocations are never replaced; reservations follow the change (`LoanSessionStore.replaceAllocations`).

Residual exposure: if no lender at all can fund after the escrow is locked, the borrower's XRP stays in escrow until
`CancelAfter` unless new Checks are added. A house-as-lender-of-last-resort policy is recommended operationally.
`test/fifoRealloc.test.js` covers skip-at-request, re-allocation at confirm, shortfall + add, and the failed-cash retry.
