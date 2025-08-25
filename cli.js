#!/usr/bin/env node
import { Command } from "commander";
import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
const program = new Command();

// ----------------------------
// Load Provider + Wallet
// ----------------------------
if (!process.env.RPC_URL || !process.env.PRIVATE_KEY) {
  console.error("❌ Missing RPC_URL or PRIVATE_KEY in .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ----------------------------
// Load Contract ABI + Address
// ----------------------------
const abiPath = "./artifacts/contracts/FlashLoanManager.sol/FlashLoanManager.json";
if (!fs.existsSync(abiPath)) {
  console.error("❌ ABI not found. Did you run `npx hardhat compile`?");
  process.exit(1);
}
import abiJson from "./artifacts/contracts/FlashLoanManager.sol/FlashLoanManager.json" assert { type: "json" };

const contractAddress = process.env.CONTRACT_ADDRESS;
if (!contractAddress) {
  console.error("❌ CONTRACT_ADDRESS missing in .env. Did you deploy?");
  process.exit(1);
}

const contract = new ethers.Contract(contractAddress, abiJson.abi, wallet);

// ----------------------------
// Minimal ERC20 ABI
// ----------------------------
const erc20Abi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)"
];

// ----------------------------
// CLI Commands
// ----------------------------

// ✅ Status command with ETH + ERC20 balances
program
  .command("status")
  .description("Show current CLI configuration, ETH balance, and token balances")
  .action(async () => {
    console.log("📊 Status Report");
    console.log("----------------------------");
    console.log("👤 Wallet:", wallet.address);
    console.log("🌐 RPC URL:", process.env.RPC_URL);
    console.log("📄 Contract Address:", contractAddress);

    const network = await provider.getNetwork();
    console.log("🌍 Network:", network.name, `(chainId: ${network.chainId})`);

    const walletBalance = await provider.getBalance(wallet.address);
    console.log("💰 Wallet ETH:", ethers.formatEther(walletBalance), "ETH");

    const contractBalance = await provider.getBalance(contractAddress);
    console.log("🏦 Contract ETH:", ethers.formatEther(contractBalance), "ETH");

    if (process.env.TOKEN_ADDRESSES) {
      console.log("\n🔎 Tracking ERC20 Tokens:");
      const tokens = process.env.TOKEN_ADDRESSES.split(",").map((a) => a.trim());

      for (const tokenAddr of tokens) {
        try {
          const token = new ethers.Contract(tokenAddr, erc20Abi, provider);
          const [symbol, decimals, wBal, cBal] = await Promise.all([
            token.symbol(),
            token.decimals(),
            token.balanceOf(wallet.address),
            token.balanceOf(contractAddress),
          ]);

          const walletFormatted = ethers.formatUnits(wBal, decimals);
          const contractFormatted = ethers.formatUnits(cBal, decimals);

          console.log(
            `   🪙 ${symbol} (${tokenAddr})\n      👤 Wallet: ${walletFormatted} ${symbol}\n      🏦 Contract: ${contractFormatted} ${symbol}`
          );
        } catch (err) {
          console.warn(`⚠️ Could not fetch token at ${tokenAddr}:`, err.message);
        }
      }
    }

    console.log("----------------------------");
  });

// Deposit collateral
program
  .command("deposit")
  .requiredOption("--token <address>", "Token address")
  .requiredOption("--amount <amount>", "Amount in ETH")
  .action(async (opts) => {
    const tx = await contract.depositCollateral(opts.token, ethers.parseEther(opts.amount));
    console.log("Deposit tx:", tx.hash);
    await tx.wait();
    console.log("✅ Deposit confirmed");
  });

// Withdraw collateral
program
  .command("withdraw")
  .requiredOption("--token <address>", "Token address")
  .requiredOption("--amount <amount>", "Amount")
  .action(async (opts) => {
    const tx = await contract.withdrawCollateral(opts.token, ethers.parseEther(opts.amount));
    console.log("Withdraw tx:", tx.hash);
    await tx.wait();
    console.log("✅ Withdrawal confirmed");
  });

// Execute flashloan
program
  .command("flashloan")
  .requiredOption("--asset <address>", "Asset address")
  .requiredOption("--amount <amount>", "Amount")
  .action(async (opts) => {
    const tx = await contract.executeFlashLoan(opts.asset, ethers.parseEther(opts.amount));
    console.log("Flashloan tx:", tx.hash);
    await tx.wait();
    console.log("✅ Flashloan executed");
  });

// Arbitrage
program
  .command("arbitrage")
  .requiredOption("--tokenIn <address>", "Input token")
  .requiredOption("--tokenOut <address>", "Output token")
  .requiredOption("--amount <amount>", "Amount")
  .action(async (opts) => {
    console.log("🚀 Running arbitrage...");
    const tx = await contract.executeArbitrage(
      opts.tokenIn,
      opts.tokenOut,
      ethers.parseEther(opts.amount)
    );
    console.log("Arbitrage tx:", tx.hash);
    await tx.wait();
    console.log("✅ Arbitrage attempt complete");
  });

// Liquidation
program
  .command("liquidate")
  .requiredOption("--borrower <address>", "Borrower address")
  .requiredOption("--debtAsset <address>", "Debt token")
  .requiredOption("--collateralAsset <address>", "Collateral token")
  .requiredOption("--debtAmount <amount>", "Debt amount to cover")
  .action(async (opts) => {
    console.log("⚡ Running liquidation...");
    const tx = await contract.executeLiquidation(
      opts.borrower,
      opts.debtAsset,
      opts.collateralAsset,
      ethers.parseEther(opts.debtAmount)
    );
    console.log("Liquidation tx:", tx.hash);
    await tx.wait();
    console.log("✅ Liquidation executed");
  });

// Refinance
program
  .command("refinance")
  .requiredOption("--oldProtocol <address>", "Old lending protocol")
  .requiredOption("--newProtocol <address>", "New lending protocol")
  .requiredOption("--debtAsset <address>", "Debt token")
  .requiredOption("--amount <amount>", "Debt amount to move")
  .action(async (opts) => {
    console.log("🔄 Running refinance...");
    const tx = await contract.executeRefinance(
      opts.oldProtocol,
      opts.newProtocol,
      opts.debtAsset,
      ethers.parseEther(opts.amount)
    );
    console.log("Refinance tx:", tx.hash);
    await tx.wait();
    console.log("✅ Refinance executed");
  });

// ✅ New Transfer command
program
  .command("transfer")
  .requiredOption("--to <address>", "Recipient address")
  .requiredOption("--amount <amount>", "Amount to send")
  .option("--token <address>", "ERC20 token address (omit for ETH)")
  .description("Send ETH or ERC20 tokens from your wallet")
  .action(async (opts) => {
    if (opts.token) {
      // ERC20 transfer
      const token = new ethers.Contract(opts.token, erc20Abi, wallet);
      const decimals = await token.decimals();
      const amount = ethers.parseUnits(opts.amount, decimals);

      console.log(`🔼 Sending ${opts.amount} tokens to ${opts.to}...`);
      const tx = await token.transfer(opts.to, amount);
      console.log("Transfer tx:", tx.hash);
      await tx.wait();
      console.log("✅ Token transfer complete");
    } else {
      // ETH transfer
      const tx = await wallet.sendTransaction({
        to: opts.to,
        value: ethers.parseEther(opts.amount),
      });
      console.log("Transfer tx:", tx.hash);
      await tx.wait();
      console.log("✅ ETH transfer complete");
    }
  });

program.parse(process.argv);
