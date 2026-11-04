import { main } from "./fifo-testnet-demo.js";

main().catch((error) => {
  console.error("Demo stopped:", error.message);
  process.exitCode = 1;
});
