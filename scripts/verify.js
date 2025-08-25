import { run } from "hardhat";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  if (!process.env.CONTRACT_ADDRESS) {
    throw new Error("❌ CONTRACT_ADDRESS not set in .env");
  }

  console.log("🔎 Verifying contract:", process.env.CONTRACT_ADDRESS);

  try {
    await run("verify:verify", {
      address: process.env.CONTRACT_ADDRESS,
      constructorArguments: [], // Add constructor args here if your contract takes any
    });
    console.log("✅ Verification complete!");
  } catch (err) {
    console.error("❌ Verification failed:", err.message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
