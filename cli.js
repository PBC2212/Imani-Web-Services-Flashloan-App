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

let abiJson;
try {
  const abiContent = fs.readFileSync(abiPath, 'utf8');
  abiJson = JSON.parse(abiContent);
} catch (error) {
  console.error("❌ Failed to parse ABI:", error.message);
  process.exit(1);
}

const contractAddress = process.env.CONTRACT_ADDRESS;
if (!contractAddress) {
  console.error("❌ CONTRACT_ADDRESS missing in .env. Did you deploy?");
  process.exit(1);
}

let contract;
try {
  contract = new ethers.Contract(contractAddress, abiJson.abi, wallet);
} catch (error) {
  console.error("❌ Failed to create contract instance:", error.message);
  process.exit(1);
}

// ----------------------------
// Minimal ERC20 ABI
// ----------------------------
const erc20Abi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

// ----------------------------
// Helper Functions
// ----------------------------
async function waitForTransaction(tx, description = "Transaction") {
  console.log(`📤 ${description} sent: ${tx.hash}`);
  console.log("⏳ Waiting for confirmation...");
  
  try {
    const receipt = await tx.wait();
    console.log(`✅ ${description} confirmed in block ${receipt.blockNumber}`);
    
    if (receipt.gasUsed) {
      console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);
    }
    
    return receipt;
  } catch (error) {
    console.error(`❌ ${description} failed:`, error.message);
    throw error;
  }
}

function formatBalance(balance, decimals, symbol = "") {
  const formatted = ethers.formatUnits(balance, decimals);
  return `${parseFloat(formatted).toLocaleString()} ${symbol}`.trim();
}

// ----------------------------
// CLI Commands
// ----------------------------

// ✅ Status command with ETH + ERC20 balances
program
  .command("status")
  .description("Show current CLI configuration, ETH balance, and token balances")
  .action(async () => {
    try {
      console.log("📊 Status Report");
      console.log("===========================");
      console.log("👤 Wallet:", wallet.address);
      console.log("🌐 RPC URL:", process.env.RPC_URL);
      console.log("📄 Contract Address:", contractAddress);

      const network = await provider.getNetwork();
      console.log("🌍 Network:", network.name, `(chainId: ${network.chainId})`);

      // ETH Balances
      const walletBalance = await provider.getBalance(wallet.address);
      console.log("💰 Wallet ETH:", ethers.formatEther(walletBalance), "ETH");

      const contractBalance = await provider.getBalance(contractAddress);
      console.log("🏦 Contract ETH:", ethers.formatEther(contractBalance), "ETH");

      // Contract status
      try {
        const treasury = await contract.treasury();
        console.log("🏛️ Treasury:", treasury);
        
        const serviceFeeBps = await contract.serviceFeeBps();
        console.log("💸 Service Fee:", `${serviceFeeBps.toString()} bps (${Number(serviceFeeBps) / 100}%)`);
        
        const isAuthorized = await contract.authorizedCallers(wallet.address);
        console.log("🔐 Wallet Authorized:", isAuthorized ? "✅ Yes" : "❌ No");
        
      } catch (error) {
        console.warn("⚠️ Could not fetch contract details:", error.message);
      }

      // Token balances
      if (process.env.TOKEN_ADDRESSES) {
        console.log("\n🪙 Token Balances:");
        const tokens = process.env.TOKEN_ADDRESSES.split(",").map((a) => a.trim());

        for (const tokenAddr of tokens) {
          if (!ethers.isAddress(tokenAddr)) {
            console.warn(`⚠️ Invalid token address: ${tokenAddr}`);
            continue;
          }

          try {
            const token = new ethers.Contract(tokenAddr, erc20Abi, provider);
            const [symbol, decimals, wBal, cBal] = await Promise.all([
              token.symbol(),
              token.decimals(),
              token.balanceOf(wallet.address),
              token.balanceOf(contractAddress),
            ]);

            console.log(`   ${symbol} (${tokenAddr}):`);
            console.log(`     👤 Wallet: ${formatBalance(wBal, decimals, symbol)}`);
            console.log(`     🏦 Contract: ${formatBalance(cBal, decimals, symbol)}`);

            // Check allowance
            const allowance = await token.allowance(wallet.address, contractAddress);
            if (allowance > 0) {
              console.log(`     🔓 Allowance: ${formatBalance(allowance, decimals, symbol)}`);
            }
            
          } catch (err) {
            console.warn(`⚠️ Could not fetch token at ${tokenAddr}:`, err.message);
          }
        }
      }

      console.log("===========================");
    } catch (error) {
      console.error("❌ Status command failed:", error.message);
      process.exit(1);
    }
  });

// Deposit collateral
program
  .command("deposit")
  .requiredOption("--token <address>", "Token address")
  .requiredOption("--amount <amount>", "Amount to deposit")
  .description("Deposit collateral tokens to the contract")
  .action(async (opts) => {
    try {
      if (!ethers.isAddress(opts.token)) {
        throw new Error("Invalid token address");
      }

      const token = new ethers.Contract(opts.token, erc20Abi, wallet);
      const decimals = await token.decimals();
      const amount = ethers.parseUnits(opts.amount, decimals);

      console.log(`💰 Depositing ${opts.amount} tokens to contract...`);
      
      // Check balance
      const balance = await token.balanceOf(wallet.address);
      if (balance < amount) {
        throw new Error("Insufficient token balance");
      }

      // Check allowance and approve if needed
      const allowance = await token.allowance(wallet.address, contractAddress);
      if (allowance < amount) {
        console.log("🔓 Approving token spend...");
        const approveTx = await token.approve(contractAddress, amount);
        await waitForTransaction(approveTx, "Token approval");
      }

      // Deposit
      const tx = await contract.depositCollateral(opts.token, amount);
      await waitForTransaction(tx, "Deposit");

      console.log("✅ Deposit completed successfully!");
      
    } catch (error) {
      console.error("❌ Deposit failed:", error.message);
      process.exit(1);
    }
  });

// Withdraw collateral
program
  .command("withdraw")
  .requiredOption("--token <address>", "Token address")
  .requiredOption("--amount <amount>", "Amount to withdraw")
  .description("Withdraw collateral tokens from the contract")
  .action(async (opts) => {
    try {
      if (!ethers.isAddress(opts.token)) {
        throw new Error("Invalid token address");
      }

      const token = new ethers.Contract(opts.token, erc20Abi, wallet);
      const decimals = await token.decimals();
      const amount = ethers.parseUnits(opts.amount, decimals);

      console.log(`💸 Withdrawing ${opts.amount} tokens from contract...`);

      // Check collateral balance
      const collateral = await contract.getUserCollateral(wallet.address, opts.token);
      if (collateral < amount) {
        throw new Error("Insufficient collateral deposited");
      }

      const tx = await contract.withdrawCollateral(opts.token, amount);
      await waitForTransaction(tx, "Withdrawal");

      console.log("✅ Withdrawal completed successfully!");
      
    } catch (error) {
      console.error("❌ Withdrawal failed:", error.message);
      process.exit(1);
    }
  });

// Execute flashloan
program
  .command("flashloan")
  .requiredOption("--asset <address>", "Asset address to borrow")
  .requiredOption("--amount <amount>", "Amount to borrow")
  .description("Execute a basic flash loan")
  .action(async (opts) => {
    try {
      if (!ethers.isAddress(opts.asset)) {
        throw new Error("Invalid asset address");
      }

      const amount = ethers.parseEther(opts.amount);
      console.log(`⚡ Executing flash loan: ${opts.amount} tokens...`);

      const tx = await contract.executeFlashLoan(opts.asset, amount);
      await waitForTransaction(tx, "Flash loan");

      console.log("✅ Flash loan executed successfully!");
      
    } catch (error) {
      console.error("❌ Flash loan failed:", error.message);
      process.exit(1);
    }
  });

// Arbitrage
program
  .command("arbitrage")
  .requiredOption("--tokenIn <address>", "Input token address")
  .requiredOption("--tokenOut <address>", "Output token address")
  .requiredOption("--amount <amount>", "Amount to trade")
  .description("Execute arbitrage between two tokens")
  .action(async (opts) => {
    try {
      if (!ethers.isAddress(opts.tokenIn) || !ethers.isAddress(opts.tokenOut)) {
        throw new Error("Invalid token addresses");
      }

      const amount = ethers.parseEther(opts.amount);
      console.log(`🚀 Executing arbitrage: ${opts.amount} ${opts.tokenIn} -> ${opts.tokenOut}...`);

      const tx = await contract.executeArbitrage(opts.tokenIn, opts.tokenOut, amount);
      await waitForTransaction(tx, "Arbitrage");

      console.log("✅ Arbitrage executed successfully!");
      
    } catch (error) {
      console.error("❌ Arbitrage failed:", error.message);
      process.exit(1);
    }
  });

// Liquidation
program
  .command("liquidate")
  .requiredOption("--borrower <address>", "Borrower address to liquidate")
  .requiredOption("--debtAsset <address>", "Debt token address")
  .requiredOption("--collateralAsset <address>", "Collateral token address")
  .requiredOption("--debtAmount <amount>", "Debt amount to cover")
  .description("Execute liquidation of an undercollateralized position")
  .action(async (opts) => {
    try {
      if (!ethers.isAddress(opts.borrower) || !ethers.isAddress(opts.debtAsset) || !ethers.isAddress(opts.collateralAsset)) {
        throw new Error("Invalid addresses provided");
      }

      const debtAmount = ethers.parseEther(opts.debtAmount);
      console.log(`⚡ Executing liquidation of ${opts.borrower}...`);

      const tx = await contract.executeLiquidation(
        opts.borrower,
        opts.debtAsset,
        opts.collateralAsset,
        debtAmount
      );
      await waitForTransaction(tx, "Liquidation");

      console.log("✅ Liquidation executed successfully!");
      
    } catch (error) {
      console.error("❌ Liquidation failed:", error.message);
      process.exit(1);
    }
  });

// Refinance
program
  .command("refinance")
  .requiredOption("--oldProtocol <address>", "Old lending protocol address")
  .requiredOption("--newProtocol <address>", "New lending protocol address")
  .requiredOption("--debtAsset <address>", "Debt token address")
  .requiredOption("--amount <amount>", "Debt amount to refinance")
  .description("Refinance debt from one protocol to another")
  .action(async (opts) => {
    try {
      if (!ethers.isAddress(opts.oldProtocol) || !ethers.isAddress(opts.newProtocol) || !ethers.isAddress(opts.debtAsset)) {
        throw new Error("Invalid addresses provided");
      }

      const amount = ethers.parseEther(opts.amount);
      console.log(`🔄 Executing refinance: ${opts.amount} ${opts.debtAsset}...`);

      const tx = await contract.executeRefinance(
        opts.oldProtocol,
        opts.newProtocol,
        opts.debtAsset,
        amount
      );
      await waitForTransaction(tx, "Refinance");

      console.log("✅ Refinance executed successfully!");
      
    } catch (error) {
      console.error("❌ Refinance failed:", error.message);
      process.exit(1);
    }
  });

// ✅ Transfer command
program
  .command("transfer")
  .requiredOption("--to <address>", "Recipient address")
  .requiredOption("--amount <amount>", "Amount to send")
  .option("--token <address>", "ERC20 token address (omit for ETH)")
  .description("Send ETH or ERC20 tokens from your wallet")
  .action(async (opts) => {
    try {
      if (!ethers.isAddress(opts.to)) {
        throw new Error("Invalid recipient address");
      }

      if (opts.token) {
        if (!ethers.isAddress(opts.token)) {
          throw new Error("Invalid token address");
        }

        // ERC20 transfer
        const token = new ethers.Contract(opts.token, erc20Abi, wallet);
        const decimals = await token.decimals();
        const amount = ethers.parseUnits(opts.amount, decimals);

        console.log(`🔼 Sending ${opts.amount} tokens to ${opts.to}...`);
        const tx = await token.transfer(opts.to, amount);
        await waitForTransaction(tx, "Token transfer");
        
      } else {
        // ETH transfer
        console.log(`🔼 Sending ${opts.amount} ETH to ${opts.to}...`);
        const tx = await wallet.sendTransaction({
          to: opts.to,
          value: ethers.parseEther(opts.amount),
        });
        await waitForTransaction(tx, "ETH transfer");
      }

      console.log("✅ Transfer completed successfully!");
      
    } catch (error) {
      console.error("❌ Transfer failed:", error.message);
      process.exit(1);
    }
  });

// Set program info
program
  .name("flashloan-cli")
  .description("CLI for FlashLoanManager smart contract operations")
  .version("1.0.0");

// Parse arguments
program.parse(process.argv);