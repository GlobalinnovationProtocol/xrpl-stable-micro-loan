# H-kyc-audit: setup and operation

## 1. Install

Install Node.js 20 or newer and npm, then check the versions:

```bash
sudo apt update
sudo apt install -y nodejs npm chrony
node --version
npm --version
```

If the distribution supplies Node older than 20, install a supported Node release
before continuing.

## 2. Open the project and install its dependencies

To replace an existing Ubuntu Desktop copy from this Windows OneDrive folder in
WSL, paste this block into the Ubuntu terminal:

```bash
set -eu
sudo apt install -y rsync
SOURCE=/mnt/c/Users/lolol/OneDrive/Bureau/H-kyc-audit
TARGET="$HOME/Desktop/H-kyc-audit"
test -d "$SOURCE"
if test -d "$TARGET"; then
  cp -a "$TARGET" "$TARGET.backup-$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$TARGET"
rsync -a --delete \
  --exclude=node_modules \
  --exclude='poc/.fifo-demo-v2.json' \
  --exclude='poc/.fifo-demo-v2.json.tmp' \
  --exclude='poc/.fifo-demo-v2.json.lock' \
  "$SOURCE/" "$TARGET/"
cd "$TARGET"
npm ci
npm test
npm run poc
```

The command checks and tests the replacement folder after making a timestamped
backup. Run it from Ubuntu under WSL while the Windows OneDrive folder is
available.

```bash
cd ~/Desktop/H-kyc-audit
npm ci
```

Use the directory where you copied the project if it differs from this example.

## 3. Run checks and the PoC

```bash
npm test
npm run poc
```

The tests named `live` query the XRP Ledger. All other tests use deterministic
local ledger fixtures. The PoC prints the fee-first direct payments, repayment,
and the three accounting outcomes without submitting transactions.

## 4. Run the interactive Testnet demo

```bash
npm run demo
```

1. Choose **2** to become a lender.
2. Enter 1000, 2000, or another multiple of 1000 up to 1000000 demo RLUSD.
3. Accept the loan disclaimer, confirm simulated KYC, and authorize the amount.
4. The demo creates a Testnet lender wallet and publishes the FIFO authorization.
   Each validated transaction prints its explorer link.
5. Answer yes to continue as borrower, or run again later and choose **1**.
6. Accept the borrower disclaimer and simulated KYC. Enter gross borrowing of
   **40-45 demo RLUSD**.
7. The program checks the FIFO authorization, available balance and four fresh
   XRP/RLUSD price observations. Accept the displayed collateral and fee.
8. The program rechecks prices and liquidity before collateral submission.
9. XRP collateral validates first. The lender pays the 2.5% deducted loan fee
   directly to the house, then pays the net loan directly to the borrower.
10. Choose **1** for repayment, **2** for default with excess, or **3** for default
    with shortfall. The demo continues until that settlement completes.

For 40 gross RLUSD, the house receives 1, the borrower receives 39, and repayment
is 40.552329. No second loan-fee payment is requested.

Repayment returns the matching XRP escrow after CancelAfter. Default releases the
matching escrow, pays the lender, then transfers excess to the house or covers the
shortfall from the house. Final lender and house balances are checked.

Price checks use four observations within 0.25%. Demo observation intervals are
one second of validated ledger time; production helpers use 60 seconds. The
demo's default sale proceeds are simulated to exercise each selected outcome.
The Testnet issuer supplies demo token funding, repayment top-ups and the house
shortfall reserve.

The state file is `poc/.fifo-demo-v2.json`. It contains Testnet signing keys and
transaction records. A lock prevents concurrent runs against that file. An
incomplete collateral submission is reconciled against validated Testnet
transaction history and active escrow objects before the demo continues. A
validated failed submission with no matching escrow is marked failed and its
FIFO reservation is released; no transaction is retried. Successful or
ambiguous collateral submissions remain blocked for manual reconciliation.
Before creating escrow, the demo checks the validated XRPL reserve and funds
the Testnet borrower with XRP from the demo issuer when that account has enough
to preserve its own reserve.

If an interrupted journal blocks a new demonstration, preserve it and use a
separate state file. Run the lender flow first to create a new FIFO offer, then
run as borrower using that same file:

```bash
cd ~/Desktop/H-kyc-audit
DEMO_STATE_FILE="$HOME/.local/state/h-kyc-demo-new.json" npm run demo
```

The demo creates the selected state directory if it does not exist. Never point
`DEMO_STATE_FILE` at a production wallet or a journal containing keys you do
not intend to use.

## 5. Windows / VS Code PowerShell

```powershell
Set-Location 'C:\Users\lolol\OneDrive\Bureau\H-kyc-audit'
node .\poc\fifo-testnet-demo.js
```

The same launcher is available as [Run-Demo.ps1](Run-Demo.ps1).
If PowerShell displays `>>`, press Ctrl+C and enter the single `node` command.

## 6. Service functions

The HTTP server factory exposes:

| Endpoint | Function |
|---|---|
| `GET /health` | Process health |
| `GET /terms` | Current loan disclaimer and version |
| `POST /loan/request` | KYC, Check proof, liquidity and price verification; collateral payload |
| `POST /loan/confirm` | Exact collateral confirmation; fee payment payload |
| `POST /loan/fee/confirm` | Exact lender-to-house fee confirmation; net CheckCash payload |
| `POST /loan/disbursement/confirm` | Exact net CheckCash confirmation; Check cancellation payload |
| `POST /loan/funding/confirm` | Confirm the lender-signed cancellation of the unused Check remainder |
| `POST /loan/deficit/confirm` | Confirm a signed Xaman house shortfall payment |

Confirmation calls require the returned `loanId` and `sessionToken`. New loan
requests from a confirmed session's IP are blocked for 24 hours; authenticated
continuation calls remain available. Repeated invalid verification attempts
blacklist the IP fingerprint for the process lifetime. Bodies are limited to
4096 bytes. The global confirmed-loan cap is 300 per rolling 24 hours. The HTTP server also
limits concurrent connections, request/header time, header count, and keep-alive
requests per socket. Per-client guard state is bounded and expires.

Production accounting uses a 1000 RLUSD gross principal, 25 paid to the house,
975 paid to the borrower, and 1013.808219 repaid to the lender. The separate house
XRP network-cost address is not the RLUSD loan-fee recipient. No automatic
top-up or balance sweep is configured.

The mainnet entry point requires `HOUSE_ADDRESS`, `FEE_ADDRESS`,
`CREDENTIALS_DIRECTORY` credentials `fee_regular_key`, `xaman_api_key`, and
`xaman_api_secret`, plus a readable `KYC_FILE`. It verifies the fee signer against
the validated mainnet account's RegularKey, connects to a secure mainnet XRPL
WebSocket, creates Xaman MAINNET signing payloads, and writes loan sessions to
`SESSION_STORE_FILE` (default `var/loan-sessions.json`). One process holds the
state-file lock; stale sessions remain reserved for reconciliation rather than
being silently discarded. The systemd unit provisions `/var/lib/h-kyc` as the
writable state directory.

Borrowers and lenders sign with their own mainnet accounts and provide their own
XRP, RLUSD, and ledger reserve. The service does not faucet-fund accounts.

## Stablecoin selection

`STABLE_SYMBOL` (environment, default `RLUSD`) selects the lent stablecoin from the allowlist in `src/params.js`.
Only RLUSD has a verified official issuer on XRPL mainnet today; `USDC`, `USDT` and `wDAI` are listed but disabled and the
service refuses to start if one of them is selected. Add `Environment=STABLE_SYMBOL=RLUSD` to the systemd unit if you want it explicit.
