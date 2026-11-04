import { AccountSetAsfFlags } from "xrpl";

export async function setupFeeWalletFirewall({ client, feeWallet, treasuryAddress }) {
  if (!client) throw new Error("connected xrpl Client required");
  if (!feeWallet?.address || !feeWallet?.wallet) throw new Error("fee wallet required");
  if (!treasuryAddress) throw new Error("treasury address required");

  const enable = await client.submitAndWait(
    { TransactionType: "AccountSet", Account: feeWallet.address, SetFlag: AccountSetAsfFlags.asfDepositAuth },
    { wallet: feeWallet.wallet },
  );
  const preauth = await client.submitAndWait(
    { TransactionType: "DepositPreauth", Account: feeWallet.address, Authorize: treasuryAddress },
    { wallet: feeWallet.wallet },
  );
  return { enable, preauth };
}
