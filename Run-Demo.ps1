$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node .\poc\fifo-testnet-demo.js
if ($LASTEXITCODE -ne 0) { throw "Demo stopped with exit code $LASTEXITCODE. Read the error above." }
