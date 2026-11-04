import { PaymentFlags } from "xrpl";
import { STABLE_CURRENCY, STABLE_ISSUER } from "../params.js";

const rlusd = (value) => ({ currency: STABLE_CURRENCY, issuer: STABLE_ISSUER, value: String(value) });

export async function sellCollateralOnAmm({ client, feeWallet, collateralDrops, ceilingRlusd, floorRlusd }) {
  if (!(floorRlusd > 0) || !(ceilingRlusd >= floorRlusd)) throw new Error("invalid price bounds");
  const tx = {
    TransactionType: "Payment",
    Account: feeWallet.address,
    Destination: feeWallet.address,
    SendMax: String(collateralDrops),
    Amount: rlusd(ceilingRlusd),
    DeliverMin: rlusd(floorRlusd),
    Flags: PaymentFlags.tfPartialPayment,
  };
  return client.submitAndWait(tx, { wallet: feeWallet.wallet });
}
