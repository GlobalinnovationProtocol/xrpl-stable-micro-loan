import { readFileSync } from "node:fs";
import { Wallet } from "xrpl";
import { isAddress } from "../loan.js";

export function loadFeeWallet({
  credentialsDir = process.env.CREDENTIALS_DIRECTORY,
  credentialName = "fee_regular_key",
  address = process.env.FEE_ADDRESS,
  readSeed = (path) => readFileSync(path, "utf8").trim(),
} = {}) {
  if (!isAddress(address)) throw new Error("FEE_ADDRESS required");
  if (!credentialsDir) throw new Error("CREDENTIALS_DIRECTORY required");
  const seed = readSeed(`${credentialsDir}/${credentialName}`);
  return { address, wallet: Wallet.fromSeed(seed) };
}

export function operatorAddresses({
  feeAddress = process.env.FEE_ADDRESS,
  houseAddress = process.env.HOUSE_ADDRESS,
  treasuryAddress = process.env.TREASURY_ADDRESS,
} = {}) {
  return { feeAddress, houseAddress, treasuryAddress };
}
