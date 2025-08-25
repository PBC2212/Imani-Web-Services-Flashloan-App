import { ethers, run, network } from "hardhat";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("🚀 Deploying FlashLoanManager...");

  // Match this with your actual contract name
  const Contract = await ethers.getContractFactory("FlashLoanManager");
  const contract = await Contract.deploy();

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log(`✅ Deployed at: ${address}`);

  // Save contract address into .env for CLI
  let envFile = fs.readFileSync(".env", "utf8");
  if (envFile.includes("CONTRACT_ADDRESS=")) {
    envFile = envFile.replace(/CONTRACT_ADDRESS=.*/g, `CONTRACT_ADDRESS=${address}`);
  } else {
    envFile += `\nCONTRACT_ADDRESS=${address}\n`;
  }
  fs.writeFileSync(".env", envFile);

  console.log("📌 Contract address saved to .env");

  // Auto-verify if ETHERSCAN_API_KEY is set and not on hardhat/local
  if (
    process.env.ETHERSCAN_API_KEY &&
    network.name !== "hardhat" &&
    network.name !== "localhost"
  ) {
    console.log("🔎 Waiting for Etherscan to index...");
    await new Promise((r) => setTimeout(r, 30000)); // wait 30s before verify

    console.log("🔎 Verifying contract on Etherscan...");
    try {
      await run("verify:verify", {
        address: address,
        constructorArguments: [], // Add args if your contract needs any
      });
      console.log("✅ Verification complete!");
    } catch (err) {
      console.warn("⚠️ Verification skipped or failed:", err.message);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
