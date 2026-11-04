# Runs the full XRPL Testnet demo (lender FIFO offer -> borrower loan -> chosen outcome) WITHOUT typing:
# every prompt is pre-answered through DEMO_* variables, and every validated transaction prints its
# https://testnet.xrpl.org link. Output is also saved to poc\recording-<outcome>.txt.
#   .\Record-Demo.ps1 1   -> borrower repays, XRP escrow returned
#   .\Record-Demo.ps1 2   -> default, collateral sale with EXCESS (house keeps it)
#   .\Record-Demo.ps1 3   -> default, collateral sale with SHORTFALL (house covers it)
# Wallets are Testnet faucet wallets created by the demo (seeds saved in poc\.fifo-demo-v2.json, Testnet only).
# Default stablecoin: RLUSD (demo RLUSD is issued by the demo issuer on Testnet). Takes 3-6 minutes.
param([ValidateSet('1', '2', '3')][string]$Outcome = '1', [string]$LenderAmount = '1000', [string]$LoanAmount = '40')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:DEMO_ROLE = '2'                 # start as lender
$env:DEMO_LENDER_AMOUNT = $LenderAmount
$env:DEMO_ACCEPT_TERMS = 'y'
$env:DEMO_KYC = 'y'
$env:DEMO_PREAUTHORIZE = 'y'
$env:DEMO_CONTINUE = 'y'             # then continue as borrower
$env:DEMO_BORROWER_KYC = 'y'
$env:DEMO_LOAN_AMOUNT = $LoanAmount
$env:DEMO_COLLATERAL = 'y'
$env:DEMO_CHOICE = $Outcome
$log = "poc\recording-$Outcome.txt"
Write-Host "== XRPL Testnet - RLUSD micro-loan - outcome $Outcome - explorer https://testnet.xrpl.org ==" -ForegroundColor Cyan
node .\poc\fifo-testnet-demo.js 2>&1 | Tee-Object -FilePath $log
if ($LASTEXITCODE -ne 0) { throw "Demo stopped with exit code $LASTEXITCODE. Read the error above (Testnet faucet or network hiccups: just run it again)." }
Write-Host "saved $log" -ForegroundColor Green
