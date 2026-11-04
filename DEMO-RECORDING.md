# Enregistrer la demo au terminal (PowerShell) - XRPL RLUSD/XRP

Tout se passe sur le **XRPL Testnet** avec de vraies transactions validees : chaque etape affiche son lien
`https://testnet.xrpl.org/transactions/...`. Aucune cle a fournir : la demo cree ses wallets au faucet Testnet.

## Une fois
```powershell
cd "$env:USERPROFILE\OneDrive\Bureau\H-kyc-xrpl-audit"
npm install
npm test            # 65 tests verts
```

## Enregistrer (Win+Alt+R demarre/arrete la capture Xbox Game Bar ; ou OBS)
Agrandir la police (Ctrl + molette), puis :
```powershell
.\Record-Demo.ps1 1    # pret de 40 RLUSD demo, remboursement, escrow XRP rendu
.\Record-Demo.ps1 2    # defaut, vente du collateral avec EXCEDENT (la maison le garde)
.\Record-Demo.ps1 3    # defaut, vente avec MANQUE (la maison le couvre)
```
Chaque run : offre FIFO du preteur (1000 RLUSD demo), 4 observations de prix XRP/RLUSD stables, escrow XRP du
borrower valide, frais 2,5 % payes a la maison, pret net verse, puis l'issue choisie. Les liens explorateur sont
dans la sortie et dans `poc\recording-<n>.txt`.

## Quoi dire pendant que ca tourne
1. Produit : prets fixes de 1000 RLUSD, 42 jours, frais 2,5 %, 12 %/an, LTV 25 %, collateral XRP en escrow natif.
2. KYC des deux cotes, file FIFO des preteurs, 300 prets/jour max.
3. Non custodial : les participants signent eux-memes (Xaman en mainnet) ; le serveur ne detient pas les fonds.
4. Reglement des defauts : vente XRP -> RLUSD via l'AMM officiel avec plancher ; manque couvert par la maison, verifie sur le ledger.
5. Stablecoin configurable par liste blanche (RLUSD actif ; USDC/USDT/wDAI desactives tant qu'aucun emetteur officiel n'existe sur XRPL).

## Si ca echoue
Faucet Testnet sature ou reseau lent : relancer la meme commande. L'etat de la demo est dans `poc\.fifo-demo-v2.json`
(contient des graines **Testnet** : ne pas copier sur une machine de production ni dans un depot public - il est ignore par git).
