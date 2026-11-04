import { ammXrpPrice, fetchTransaction, validatedCloseTime } from "../src/xrpl.js";
import { quote, settleDefault } from "../src/loan.js";

const closeTime = await validatedCloseTime();
const price = await ammXrpPrice();
console.log(`Validated ledger close_time: ${closeTime}`);
console.log(`Live XRP price: ${price} RLUSD`);

const q = quote(price);
console.log("Live quote:", q);
console.log("Liquidation if price falls 80%:", settleDefault({ collateralXrp: q.collateralXrp, xrpPrice: price * 0.2 }));

for (const hash of process.argv.slice(2)) {
  console.log(await fetchTransaction(hash).catch((e) => ({ hash, error: e.message })));
}
