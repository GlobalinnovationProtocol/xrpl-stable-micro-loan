import { Client } from "xrpl";
import { setupFeeWalletFirewall } from "../src/settlement/firewall.js";
import { loadFeeWallet, operatorAddresses } from "../src/settlement/wallets.js";

async function main() {
  const { treasuryAddress } = operatorAddresses();
  const feeWallet = loadFeeWallet();
  const client = new Client(process.env.XRPL_WS_URL ?? "wss://xrplcluster.com/");
  await client.connect();
  try {
    const { enable, preauth } = await setupFeeWalletFirewall({ client, feeWallet, treasuryAddress });
    console.log("asfDepositAuth enabled:", enable.result?.meta?.TransactionResult ?? enable);
    console.log("DepositPreauth set for", treasuryAddress, ":", preauth.result?.meta?.TransactionResult ?? preauth);
  } finally {
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error("firewall setup failed:", error.message);
  process.exitCode = 1;
});
