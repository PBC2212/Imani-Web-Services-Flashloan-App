#!/usr/bin/env node
import { Command } from "commander";
import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

/* ------------------------ Load ABI safely (no JSON assert) ------------------------ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const abiPath = path.join(__dirname, "abi.json");

if (!fs.existsSync(abiPath)) {
  console.error("❌ abi.json not found next to cli.js");
  process.exit(1);
}

let abi;
try {
  const abiRaw = fs.readFileSync(abiPath, "utf8");
  if (!abiRaw.trim()) {
    console.error("❌ abi.json is empty. Paste your contract ABI there.");
    process.exit(1);
  }
  abi = JSON.parse(abiRaw);
} catch (e) {
  console.error("❌ Failed to parse abi.json:", e.message);
  process.exit(1);
}

/* ------------------------------ Commander setup --------------------------------- */
const program = new Command();

program
  .name("flashloan-cli")
  .description("CLI tool for EnhancedFlashLoanManager operations")
  .version("2.2.1")
  .option(
    "-n, --network <network>",
    "Choose network (sepolia | mainnet)",
    "sepolia"
  );

/* --------------------------- Environment resolution ------------------------------ */
const RPCS = {
  sepolia: process.env.SEPOLIA_RPC_URL || process.env.RPC_URL || "",
  mainnet: process.env.MAINNET_RPC_URL || "",
};

const CONTRACTS = {
  sepolia: process.env.SEPOLIA_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS || "",
  mainnet: process.env.MAINNET_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS || "",
};

function getProvider(network) {
  const rpcUrl = RPCS[network];
  if (!rpcUrl) {
    console.error(`❌ Missing RPC URL for '${network}'. Set SEPOLIA_RPC_URL / MAINNET_RPC_URL (or RPC_URL).`);
    process.exit(1);
  }
  
  try {
    return new ethers.JsonRpcProvider(rpcUrl);
  } catch (e) {
    console.error(`❌ Failed to create provider for ${network}:`, e.message);
    process.exit(1);
  }
}

function getWallet(provider) {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error("❌ Missing PRIVATE_KEY in .env");
    process.exit(1);
  }
  
  if (!pk.startsWith('0x')) {
    console.error("❌ PRIVATE_KEY must start with '0x'");
    process.exit(1);
  }
  
  try {
    return new ethers.Wallet(pk, provider);
  } catch (e) {
    console.error("❌ Invalid PRIVATE_KEY:", e.message);
    process.exit(1);
  }
}

function getContract(network) {
  const addr = CONTRACTS[network];
  if (!addr || !ethers.isAddress(addr)) {
    console.error(`❌ Missing or invalid CONTRACT_ADDRESS for '${network}'. Use SEPOLIA_CONTRACT_ADDRESS / MAINNET_CONTRACT_ADDRESS (or CONTRACT_ADDRESS).`);
    process.exit(1);
  }
  const provider = getProvider(network);
  const wallet = getWallet(provider);
  return { contract: new ethers.Contract(addr, abi, wallet), provider, wallet, address: addr };
}

/* --------------------------------- Utilities ------------------------------------ */
function requireAddr(addr, label = "address") {
  if (!ethers.isAddress(addr)) {
    console.error(`❌ Invalid Ethereum ${label}:`, addr);
    process.exit(1);
  }
}

function parseAmount(amountStr, decimals) {
  try {
    // Handle scientific notation and ensure it's a valid number
    if (!/^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/.test(amountStr)) {
      throw new Error("Invalid number format");
    }
    return ethers.parseUnits(amountStr, decimals);
  } catch (e) {
    console.error(`❌ Invalid amount '${amountStr}' for decimals=${decimals}:`, e.message);
    process.exit(1);
  }
}

async function chooseGasOverrides(provider) {
  try {
    const fee = await provider.getFeeData();
    const overrides = {};
    
    if (fee.gasPrice != null) {
      // Legacy gas pricing
      overrides.gasPrice = fee.gasPrice;
    } else if (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
      // EIP-1559 gas pricing
      overrides.maxFeePerGas = fee.maxFeePerGas;
      overrides.maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
    } else {
      console.warn("⚠️ Could not fetch gas price/fee data; sending tx without overrides.");
    }
    
    return overrides;
  } catch (e) {
    console.warn("⚠️ Error fetching gas data:", e.message);
    return {};
  }
}

/* ---------------------------- Strategy enum mapping ----------------------------- */
/* NOTE: Your contract enum is: 0=REFINANCE, 1=LIQUIDATION, 2=ARBITRAGE */
const STRATEGY_TYPES = {
  REFINANCE: 0,
  LIQUIDATION: 1,
  ARBITRAGE: 2,
};

const STRATEGY_ALIASES = {
  refinance: 0,
  liquidation: 1,
  arbitrage: 2,
  "0": 0,
  "1": 1,
  "2": 2,
};

function resolveStrategy(strategy) {
  const key = String(strategy).toLowerCase();
  const strategyNum = STRATEGY_ALIASES[key];
  if (strategyNum === undefined) {
    console.error("❌ Unknown strategy. Use 'refinance', 'liquidation', 'arbitrage' or 0/1/2.");
    process.exit(1);
  }
  return strategyNum;
}

/* --------------------------------- Commands ------------------------------------ */

// 1) Contract Version
program
  .command("version")
  .description("Get contract version")
  .action(async () => {
    const { network } = program.opts();
    const { contract } = getContract(network);
    try {
      const v = await contract.version();
      console.log("Contract version:", v);
    } catch (err) {
      console.error("❌ Error getting version:", err.reason || err.message || err);
      process.exit(1);
    }
  });

// 2) Get user daily volume info
program
  .command("volume <userAddress>")
  .description("Get user's daily volume usage (used, limit, remaining)")
  .action(async (userAddress) => {
    const { network } = program.opts();
    const { contract } = getContract(network);
    requireAddr(userAddress, "user address");
    try {
      const res = await contract.getUserDailyVolumeInfo(userAddress);
      const used = res.used ?? res[0];
      const limit = res.limit ?? res[1];
      const remaining = res.remaining ?? res[2];

      console.log("📊 Daily Volume Info for", userAddress);
      console.log("Used:     ", ethers.formatUnits(used, 6), "USDC");
      console.log("Limit:    ", ethers.formatUnits(limit, 6), "USDC");
      console.log("Remaining:", ethers.formatUnits(remaining, 6), "USDC");
      
      const usagePercent = limit > 0n ? (Number(used) / Number(limit) * 100) : 0;
      console.log("Usage:    ", usagePercent.toFixed(2) + "%");
    } catch (err) {
      console.error("❌ Error fetching daily volume:", err.reason || err.message || err);
      process.exit(1);
    }
  });

// 3) Get user nonce
program
  .command("nonce <userAddress>")
  .description("Get replay protection nonce for user address")
  .action(async (userAddress) => {
    const { network } = program.opts();
    const { contract } = getContract(network);
    requireAddr(userAddress, "user address");
    try {
      const nonce = await contract.getUserNonce(userAddress);
      console.log(`🔢 Nonce for ${userAddress}:`, nonce.toString());
    } catch (err) {
      console.error("❌ Error fetching nonce:", err.reason || err.message || err);
      process.exit(1);
    }
  });

// 4) Execute Flash Loan
program
  .command("flashloan <asset> <amount> <strategy>")
  .description("Execute flash loan with strategy (amount and profit default to 6 decimals unless overridden)")
  .option("-d, --deadline <seconds>", "Seconds from now until deadline (default 300s)", "300")
  .option("-N, --nonce <nonce>", "User nonce (defaults to on-chain current nonce for your wallet)")
  .option("-p, --profit <profit>", "Expected profit (default 10)", "10")
  .option("--data <strategyData>", "Hex-encoded strategyData (default 0x)", "0x")
  .option("--decimals <n>", "Decimals for amount & profit (default 6)", "6")
  .option("--gas-limit <limit>", "Manual gas limit override")
  .action(async (asset, amount, strategy, options) => {
    const { network } = program.opts();
    const { contract, provider, wallet } = getContract(network);

    requireAddr(asset, "asset");
    
    // Validate decimals
    const decimals = parseInt(options.decimals, 10);
    if (Number.isNaN(decimals) || decimals < 0 || decimals > 36) {
      console.error("❌ Invalid --decimals value (must be 0-36)");
      process.exit(1);
    }

    // Validate deadline
    const deadlineSeconds = parseInt(options.deadline, 10);
    if (Number.isNaN(deadlineSeconds) || deadlineSeconds <= 0) {
      console.error("❌ Invalid deadline (must be positive seconds)");
      process.exit(1);
    }

    // Resolve strategy
    const strategyNum = resolveStrategy(strategy);

    try {
      // Prepare parameters
      const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;
      const nonce = options.nonce !== undefined
        ? BigInt(options.nonce)
        : await contract.getUserNonce(wallet.address);

      const amountParsed = parseAmount(amount, decimals);
      const profitParsed = parseAmount(options.profit, decimals);

      // Validate strategy data
      const strategyData = options.data && options.data !== "" ? options.data : "0x";
      if (!/^0x[0-9a-fA-F]*$/.test(strategyData)) {
        console.error("❌ --data must be hex string (e.g. 0x...)");
        process.exit(1);
      }

      // Prepare transaction overrides
      const overrides = await chooseGasOverrides(provider);
      if (options.gasLimit) {
        const gasLimit = parseInt(options.gasLimit, 10);
        if (Number.isNaN(gasLimit) || gasLimit <= 0) {
          console.error("❌ Invalid gas limit");
          process.exit(1);
        }
        overrides.gasLimit = gasLimit;
      }

      // Display execution info
      console.log("🚀 Executing flash loan...");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("Network:          ", network);
      console.log("Caller:           ", wallet.address);
      console.log("Contract:         ", contract.target.toString());
      console.log("Asset:            ", asset);
      console.log("Amount:           ", amount, `(${decimals} decimals)`);
      console.log("Strategy:         ", Object.keys(STRATEGY_TYPES)[strategyNum], `(${strategyNum})`);
      console.log("Strategy Data:    ", strategyData);
      console.log("Expected Profit:  ", options.profit, `(${decimals} decimals)`);
      console.log("Deadline:         ", new Date(deadline * 1000).toISOString());
      console.log("Nonce:            ", nonce.toString());
      
      if (overrides.gasPrice != null) {
        console.log("Gas Price:        ", ethers.formatUnits(overrides.gasPrice, "gwei"), "gwei");
      } else if (overrides.maxFeePerGas != null) {
        console.log("Max Fee Per Gas:  ", ethers.formatUnits(overrides.maxFeePerGas, "gwei"), "gwei");
        console.log("Max Priority Fee: ", ethers.formatUnits(overrides.maxPriorityFeePerGas, "gwei"), "gwei");
      }
      
      if (overrides.gasLimit) {
        console.log("Gas Limit:        ", overrides.gasLimit.toString());
      }
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      // Execute transaction
      const tx = await contract.executeFlashLoan(
        asset,
        amountParsed,
        strategyNum,
        strategyData,
        profitParsed,
        deadline,
        nonce,
        overrides
      );
      console.log("📋 Tx hash:", tx.hash);
      console.log("⏳ Waiting for confirmation...");

      const receipt = await tx.wait();
      console.log("✅ Flash loan transaction confirmed!");
      console.log("Block Number:     ", receipt.blockNumber.toString());
      console.log("Gas Used:         ", receipt.gasUsed.toString());
      
      if (receipt.effectiveGasPrice) {
        const feePaid = receipt.gasUsed * receipt.effectiveGasPrice;
        console.log("Transaction Fee:  ", ethers.formatEther(feePaid), "ETH");
      }
      
      // Show events if any
      if (receipt.logs && receipt.logs.length > 0) {
        console.log("Events emitted:   ", receipt.logs.length);
      }
      
    } catch (err) {
      console.error("❌ Error executing flash loan:", err.reason || err.message || err);
      if (err.code === 'CALL_EXCEPTION' && err.data) {
        console.error("Contract revert data:", err.data);
      }
      process.exit(1);
    }
  });

// 5) Profitability check
program
  .command("check-profit <asset> <amount> <estProfit>")
  .description("Check if flash loan is profitable (on-chain view)")
  .option("--decimals <n>", "Decimals for amount & estProfit (default 6)", "6")
  .action(async (asset, amount, estProfit, opts) => {
    const { network } = program.opts();
    const { contract } = getContract(network);
    requireAddr(asset, "asset");
    const decimals = parseInt(opts.decimals, 10) || 6;
    
    try {
      const amountParsed = parseAmount(amount, decimals);
      const profitParsed = parseAmount(estProfit, decimals);

      const res = await contract.checkProfitability(asset, amountParsed, profitParsed);
      const isProfitable = res.isProfitable ?? res[0];
      const netProfit = res.netProfit ?? res[1];

      console.log("💰 Profitability Check");
      console.log("Asset:            ", asset);
      console.log("Amount:           ", amount);
      console.log("Estimated Profit: ", estProfit);
      console.log("Is Profitable:    ", isProfitable ? "✅ YES" : "❌ NO");
      console.log("Net Profit:       ", ethers.formatUnits(netProfit, decimals));
    } catch (err) {
      console.error("❌ Error:", err.reason || err.message || err);
      process.exit(1);
    }
  });

// 6) Flash Loan Fee
program
  .command("fee <asset> <amount>")
  .description("Get flash loan fee for asset and amount")
  .option("--decimals <n>", "Decimals for amount (default 6)", "6")
  .action(async (asset, amount, opts) => {
    const { network } = program.opts();
    const { contract } = getContract(network);
    requireAddr(asset, "asset");
    const decimals = parseInt(opts.decimals, 10) || 6;
    
    try {
      const parsed = parseAmount(amount, decimals);
      const fee = await contract.getFlashLoanFee(asset, parsed);
      const feeFormatted = ethers.formatUnits(fee, decimals);
      
      console.log("💸 Flash Loan Fee");
      console.log("Asset:            ", asset);
      console.log("Amount:           ", amount);
      console.log("Fee:              ", feeFormatted);
      
      const pct = (Number(feeFormatted) / Number(amount)) * 100;
      if (isFinite(pct)) {
        console.log("Fee Rate:         ", pct.toFixed(4) + "%");
      }
    } catch (err) {
      console.error("❌ Error:", err.reason || err.message || err);
      process.exit(1);
    }
  });

// 7) System Health Check
program
  .command("health")
  .description("Check system health & treasury info")
  .action(async () => {
    const { network } = program.opts();
    const { contract } = getContract(network);
    
    try {
      console.log("🏥 System Health Check");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      
      const health = await contract.systemHealthCheck();
      const isHealthy = health.isHealthy ?? health[0];
      const issueCount = health.issueCount ?? health[1];

      const treas = await contract.getTreasuryInfo();
      const treasuryAddress = treas.treasuryAddress ?? treas[0];
      const treasuryBalance = treas.balance ?? treas[1];
      const autoForward = treas.autoForward ?? treas[2];

      const maxGas = await contract.maxGasPrice();
      const maxSlip = await contract.maxSlippageBps();

      console.log("System Healthy:   ", isHealthy ? "✅ YES" : "❌ NO");
      console.log("Issue Count:      ", issueCount.toString());
      console.log("Treasury:         ", treasuryAddress);
      console.log("Treasury Balance: ", ethers.formatUnits(treasuryBalance, 6), "USDC");
      console.log("Auto Forward Fees:", autoForward ? "✅ Enabled" : "❌ Disabled");
      console.log("Max Gas Price:    ", ethers.formatUnits(maxGas, "gwei"), "gwei");
      console.log("Max Slippage:     ", (Number(maxSlip) / 100).toFixed(2) + "%");
    } catch (err) {
      console.error("❌ Error:", err.reason || err.message || err);
      process.exit(1);
    }
  });

// 8) Oracle Info
program
  .command("oracle <asset>")
  .description("Show asset oracle configuration & current price")
  .action(async (asset) => {
    const { network } = program.opts();
    const { contract } = getContract(network);
    requireAddr(asset, "asset");
    
    try {
      const cfg = await contract.getOracleConfig(asset);
      const priceInfo = await contract.checkAssetOracle(asset);

      const priceOracle = cfg.priceOracle ?? cfg[0];
      const heartbeat = cfg.heartbeat ?? cfg[1];
      const decimals = cfg.decimals ?? cfg[2];
      const isActive = cfg.isActive ?? cfg[3];
      const deviationThreshold = cfg.deviationThreshold ?? cfg[4];

      const hasOracle = priceInfo.hasOracle ?? priceInfo[0];
      const currentPrice = priceInfo.currentPrice ?? priceInfo[1];

      console.log("🔮 Oracle Information");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("Asset:                ", asset);
      console.log("Oracle Active:        ", isActive ? "✅ YES" : "❌ NO");
      console.log("Oracle Address:       ", priceOracle);
      console.log("Heartbeat:            ", heartbeat.toString(), "seconds");
      console.log("Price Decimals:       ", decimals.toString());
      console.log("Deviation Threshold:  ", (Number(deviationThreshold) / 100).toFixed(2) + "%");
      console.log("Has Valid Price:      ", hasOracle ? "✅ YES" : "❌ NO");
      
      if (hasOracle) {
        console.log("Current Price (USD):  ", "$" + Number(ethers.formatUnits(currentPrice, 18)).toFixed(6));
      }
    } catch (err) {
      console.error("❌ Error:", err.reason || err.message || err);
      process.exit(1);
    }
  });

// 9) Router Support
program
  .command("router <routerAddress>")
  .description("Check if swap router is supported and its reliability score")
  .action(async (routerAddress) => {
    const { network } = program.opts();
    const { contract } = getContract(network);
    requireAddr(routerAddress, "router address");
    
    try {
      const res = await contract.isSwapRouterSupported(routerAddress);
      const supported = res.supported ?? res[0];
      const score = res.reliabilityScore ?? res[1];

      console.log("🔄 Swap Router Status");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("Router Address:       ", routerAddress);
      console.log("Supported:            ", supported ? "✅ YES" : "❌ NO");
      console.log("Reliability Score:    ", score.toString() + "/100");
      
      const scoreNum = Number(score);
      if (scoreNum >= 90) {
        console.log("Rating:               ", "🟢 Excellent");
      } else if (scoreNum >= 70) {
        console.log("Rating:               ", "🟡 Good");
      } else if (scoreNum >= 50) {
        console.log("Rating:               ", "🟠 Fair");
      } else {
        console.log("Rating:               ", "🔴 Poor");
      }
    } catch (err) {
      console.error("❌ Error:", err.reason || err.message || err);
      process.exit(1);
    }
  });

// 10) Network Configuration
program
  .command("network")
  .description("Show protocol network configuration")
  .action(async () => {
    const { network } = program.opts();
    const { contract } = getContract(network);
    
    try {
      const net = await contract.getNetworkConfig();
      const aave = net.aavePoolAddressesProvider ?? net[0];
      const weth = net.wethAddress ?? net[1];
      const oneInch = net.oneInchRouter ?? net[2];
      const chainId = net.chainId ?? net[3];
      const isTestnet = net.isTestnet ?? net[4];

      console.log("🌐 Network Configuration");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("Selected Network:     ", network);
      console.log("Chain ID:             ", chainId.toString());
      console.log("Environment:          ", isTestnet ? "🧪 Testnet" : "🏭 Mainnet");
      console.log("Aave Pool Provider:   ", aave);
      console.log("WETH Address:         ", weth);
      console.log("1inch Router:         ", oneInch);
    } catch (err) {
      console.error("❌ Error:", err.reason || err.message || err);
      process.exit(1);
    }
  });

// 11) MEV Protection Config
program
  .command("mev")
  .description("Show MEV protection configuration")
  .action(async () => {
    const { network } = program.opts();
    const { contract } = getContract(network);
    
    try {
      const mev = await contract.getMEVConfig();
      const minBlockDelay = mev.minBlockDelay ?? mev[0];
      const maxSlippageBps = mev.maxSlippageBps ?? mev[1];
      const frontrunProtection = mev.frontrunProtection ?? mev[2];
      const sandwichProtection = mev.sandwichProtection ?? mev[3];

      console.log("🛡️  MEV Protection Configuration");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("Min Block Delay:      ", minBlockDelay.toString(), "blocks");
      console.log("Max Slippage:         ", (Number(maxSlippageBps) / 100).toFixed(2) + "%");
      console.log("Frontrun Protection:  ", frontrunProtection ? "✅ Enabled" : "❌ Disabled");
      console.log("Sandwich Protection:  ", sandwichProtection ? "✅ Enabled" : "❌ Disabled");
      
      const protectionLevel = (frontrunProtection && sandwichProtection) ? "🟢 Full" : 
                             (frontrunProtection || sandwichProtection) ? "🟡 Partial" : "🔴 None";
      console.log("Protection Level:     ", protectionLevel);
    } catch (err) {
      console.error("❌ Error:", err.reason || err.message || err);
      process.exit(1);
    }
  });

/* -------------------------------- Help footer ---------------------------------- */
program.addHelpText(
  "after",
  `

Examples:
  $ node cli.js version --network sepolia
  $ node cli.js nonce 0xabc... --network sepolia
  $ node cli.js volume 0xabc... -n sepolia
  $ node cli.js fee 0xA0b8... 1000 -n sepolia
  $ node cli.js check-profit 0xA0b8... 1000 50 --decimals 6 -n sepolia
  $ node cli.js flashloan 0xA0b8... 1000 arbitrage -p 50 --decimals 6 -n sepolia
  $ node cli.js health -n sepolia
  $ node cli.js oracle 0xC02a... -n sepolia
  $ node cli.js network -n sepolia
  $ node cli.js mev -n sepolia

.env keys:
  PRIVATE_KEY=194e721a920c33edfaa660cb410c312be9db4775e8c9c37eb83c817b0879a68b
  SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/3a38b29588c64b45a5fc637d9f61c636
  MAINNET_RPC_URL=https://mainnet.infura.io/v3/3a38b29588c64b45a5fc637d9f61c636
  SEPOLIA_CONTRACT_ADDRESS=0x<deployed on Sepolia>
  MAINNET_CONTRACT_ADDRESS=0x<deployed on Mainnet>
  # (Fallbacks: RPC_URL and CONTRACT_ADDRESS are used if network-specific not set)
`
);

/* --------------------------------- Run CLI ------------------------------------- */
program.parseAsync(process.argv).catch(err => {
  console.error("❌ CLI Error:", err.message);
  process.exit(1);
});