# H-kyc-audit: functional model

## Amounts

- Lender FIFO authorization: 1000 RLUSD or any multiple up to 1000000.
- Mainnet gross principal: exactly 1000 RLUSD per loan.
- Deducted loan fee: 2.5%, sent directly from lender to house first.
- Net borrower proceeds: 975 RLUSD.
- Repayment: 1000 plus 12% annual interest prorated over 42 days,
  totaling 1013.808219 RLUSD. The loan fee is not charged again.
- XRP collateral: 25% LTV calculated on gross principal.

## Opening

The lender chooses an amount, accepts the loan disclaimer, completes KYC and
authorizes FIFO funding. The borrower accepts terms and completes KYC. Available
FIFO funding and four fresh stable price observations are verified before XRP
collateral submission. The XRP escrow validates before fee and net funding.

Funding moves directly from lender to house and borrower. Verification checks
the accounts, destination, token issuer, currency, amount and validated result.
FIFO reservations prevent the same Check being allocated twice during a process.

## Settlement

1. **Repayment:** validated borrower payments cover gross principal plus interest.
   The matching XRP escrow is cancelled after CancelAfter and its deletion is
   verified in transaction metadata.
2. **Default with excess:** stable-price checks precede release and sale. The
   lender receives principal plus interest; excess goes to the house.
3. **Default with shortfall:** actual validated sale proceeds go to the lender.
   The remaining shortfall generates a house Xaman approval request.

The production settlement helper uses the delivered sale amount rather than
estimated sale proceeds. Failed or ambiguous side effects enter
`reconciliation_required` rather than being blindly resubmitted.

## Demo

Gross borrowing is 40-45 demo RLUSD. Signing and KYC use yes/no confirmation.
Testnet default-sale proceeds and reserve funding are simulated. Each submitted
transaction is fetched back from the ledger and printed with an explorer link.
The three settlement choices continue after loan opening.

## Execution state

See [UBUNTU.md](UBUNTU.md) for commands, endpoint contracts and the current
mainnet entry-point configuration status.
