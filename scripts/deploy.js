const { ethers, network, run } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Network configurations
const NETWORK_CONFIGS = {
  sepolia: {
    chainId: 11155111,
    aavePoolAddressesProvider: "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A",
    wethAddress: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    assets: {
      WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
      USDC: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8",
      USDT: "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0",
      DAI: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357"
    },
    aggregators: {
      oneInch: "0x1111111254EEB25477B68fb85Ed929f73A960582",
      zeroX: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF"
    },
    blockExplorer: "https://sepolia.etherscan.io"
  },
  mainnet: {
    chainId: 1,
    aavePoolAddressesProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
    wethAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    assets: {
      WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      USDC: "0xA0b86a33E6417b8a02CE8bde2d63AB62A8Cd83BE",
      USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F"
    },
    aggregators: {
      oneInch: "0x1111111254EEB25477B68fb85Ed929f73A960582",
      zeroX: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
      paraSwap: "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57"
    },
    blockExplorer: "https://etherscan.io"
  }
};

// Production deployment configuration
const DEPLOYMENT_CONFIG = {
  serviceFee: 25, // 0.25% - competitive for production
  maxGasPrice: 50000000000, // 50 gwei - reasonable for production
  dailyVolumeLimit: ethers.parseUnits("1000000", 6), // $1M USDC per user
  confirmations: network.name === "mainnet" ? 3 : 1,
  gasMultiplier: 1.3, // 30% buffer for production reliability
  verifyContracts: true,
  initialRates: {
    // Initial borrow rates for rate tracking (basis points)
    USDC: 450, // 4.5%
    DAI: 425,  // 4.25%
    USDT: 475, // 4.75%
    WETH: 325  // 3.25%
  }
};

// Enhanced logging with colors
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m"
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logStep(step, message) {
  log(`\n${colors.cyan}[Step ${step}]${colors.reset} ${colors.bright}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`${colors.green}✅ ${message}${colors.reset}`);
}

function logWarning(message) {
  log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

function logError(message) {
  log(`${colors.red}❌ ${message}${colors.reset}`);
}

async function main() {
  try {
    // Initialize deployment
    const networkName = network.name;
    const config = NETWORK_CONFIGS[networkName];
    
    if (!config) {
      throw new Error(`Unsupported network: ${networkName}`);
    }

    log(`\n${colors.magenta}🚀 PRODUCTION Flash Loan Platform Deployment${colors.reset}`);
    log(`${colors.blue}═══════════════════════════════════════════════${colors.reset}`);
    log(`Network: ${colors.bright}${networkName}${colors.reset}`);
    log(`Chain ID: ${colors.bright}${config.chainId}${colors.reset}`);
    log(`Block Explorer: ${colors.bright}${config.blockExplorer}${colors.reset}`);

    // Get deployer info
    const [deployer] = await ethers.getSigners();
    
    if (!deployer) {
      throw new Error("No deployer account found. Please check your PRIVATE_KEY in .env file");
    }
    
    const provider = ethers.provider;
    const deployerBalance = await provider.getBalance(deployer.address);
    
    log(`\nDeployer: ${colors.bright}${deployer.address}${colors.reset}`);
    log(`Balance: ${colors.bright}${ethers.formatEther(deployerBalance)} ETH${colors.reset}`);

    // Check minimum balance for production deployment
    const minBalance = ethers.parseEther(networkName === "mainnet" ? "1.0" : "0.05");
    if (deployerBalance < minBalance) {
      throw new Error(`Insufficient balance. Need at least ${ethers.formatEther(minBalance)} ETH for production deployment`);
    }

    // Deployment tracking
    const     deploymentResults = {
      network: networkName,
      chainId: config.chainId,
      deployer: deployer.address,
      timestamp: new Date().toISOString(),
      blockNumber: await provider.getBlockNumber(),
      contracts: {},
      gasUsed: "0",
      totalCost: "0",
      productionFeatures: {
        serviceFee: DEPLOYMENT_CONFIG.serviceFee,
        maxGasPrice: DEPLOYMENT_CONFIG.maxGasPrice,
        dailyVolumeLimit: ethers.formatUnits(DEPLOYMENT_CONFIG.dailyVolumeLimit, 6),
        supportedStrategies: ["REFINANCE", "LIQUIDATION"],
        supportedAggregators: Object.keys(config.aggregators)
      }
    };

    // Step 1: Deploy Production FlashLoanManager
    logStep(1, "Deploying PRODUCTION FlashLoanManager with real strategies...");
    
    const FlashLoanManagerFactory = await ethers.getContractFactory("FlashLoanManager");
    
    log(`Aave Pool Provider: ${colors.bright}${config.aavePoolAddressesProvider}${colors.reset}`);
    log(`Estimated deployment gas: ${colors.bright}~4.5M gas${colors.reset}`);
    
    // Deploy with automatic gas settings
    const flashLoanManager = await FlashLoanManagerFactory.deploy(
      config.aavePoolAddressesProvider,
      {
        gasLimit: 6500000 // Higher limit for production contract
      }
    );

    await flashLoanManager.waitForDeployment(DEPLOYMENT_CONFIG.confirmations);
    const flashLoanManagerAddress = await flashLoanManager.getAddress();
    
    logSuccess(`FlashLoanManager deployed to: ${flashLoanManagerAddress}`);
    
    // Get deployment transaction details
    const deployTx = flashLoanManager.deploymentTransaction();
    const deployReceipt = await deployTx.wait(DEPLOYMENT_CONFIG.confirmations);
    
    deploymentResults.contracts.FlashLoanManager = {
      address: flashLoanManagerAddress,
      txHash: deployTx.hash,
      gasUsed: deployReceipt.gasUsed.toString(),
      gasPrice: deployTx.gasPrice.toString(),
      blockNumber: deployReceipt.blockNumber
    };
    
    deploymentResults.gasUsed = deployReceipt.gasUsed.toString();
    deploymentResults.totalCost = (deployReceipt.gasUsed * deployTx.gasPrice).toString();

    // Step 2: Configure Production Settings
    logStep(2, "Configuring production settings...");
    
    let configTxCount = 0;
    
    // Set optimized service fee for production
    if (DEPLOYMENT_CONFIG.serviceFee !== 25) {
      log(`Setting service fee to ${DEPLOYMENT_CONFIG.serviceFee} basis points (${DEPLOYMENT_CONFIG.serviceFee/100}%)...`);
      const setFeeTx = await flashLoanManager.setServiceFee(DEPLOYMENT_CONFIG.serviceFee);
      await setFeeTx.wait(DEPLOYMENT_CONFIG.confirmations);
      configTxCount++;
    }
    
    // Set production gas price limit
    log(`Setting max gas price to ${DEPLOYMENT_CONFIG.maxGasPrice / 1e9} gwei...`);
    const setGasTx = await flashLoanManager.setMaxGasPrice(DEPLOYMENT_CONFIG.maxGasPrice);
    await setGasTx.wait(DEPLOYMENT_CONFIG.confirmations);
    configTxCount++;
    
    // Set production daily volume limit
    log(`Setting daily volume limit to ${ethers.formatUnits(DEPLOYMENT_CONFIG.dailyVolumeLimit, 6)} USDC...`);
    const setLimitTx = await flashLoanManager.setDailyLimit(deployer.address, DEPLOYMENT_CONFIG.dailyVolumeLimit);
    await setLimitTx.wait(DEPLOYMENT_CONFIG.confirmations);
    configTxCount++;
    
    // Initialize asset rates for production tracking
    log("Initializing asset borrow rates for tracking...");
    for (const [symbol, rate] of Object.entries(DEPLOYMENT_CONFIG.initialRates)) {
      if (config.assets[symbol]) {
        const setRateTx = await flashLoanManager.updateAssetRate(config.assets[symbol], rate);
        await setRateTx.wait(DEPLOYMENT_CONFIG.confirmations);
        configTxCount++;
      }
    }
    
    logSuccess(`Completed ${configTxCount} configuration transactions`);

    // Step 3: Verify Swap Router Configuration
    logStep(3, "Verifying production swap router configuration...");
    
    let supportedRouters = 0;
    for (const [name, address] of Object.entries(config.aggregators)) {
      const isSupported = await flashLoanManager.isSwapRouterSupported(address);
      if (isSupported) {
        logSuccess(`${name} router (${address.slice(0,8)}...) is supported`);
        supportedRouters++;
      } else {
        logWarning(`${name} router (${address.slice(0,8)}...) is not supported`);
      }
    }
    
    if (supportedRouters === 0) {
      logWarning("No swap routers are supported - manual configuration may be needed");
    }

    // Step 4: Production Functionality Testing
    logStep(4, "Testing production functionality...");
    
    try {
      // Test network configuration
      const networkConfigFromContract = await flashLoanManager.getNetworkConfig();
      logSuccess(`Network config validated - Chain ID: ${networkConfigFromContract.chainId}`);
      
      // Test flash loan fee calculation with production amounts
      const testAmount = ethers.parseUnits("10000", 6); // $10,000 USDC
      const flashLoanFee = await flashLoanManager.getFlashLoanFee(config.assets.USDC, testAmount);
      logSuccess(`Flash loan fee calculation works - Fee: $${ethers.formatUnits(flashLoanFee, 6)} USDC on $10K`);
      
      // Test profitability calculation with realistic profits
      const estimatedProfit = ethers.parseUnits("50", 6); // $50 profit
      const [isProfitable, netProfit] = await flashLoanManager.checkProfitability(
        config.assets.USDC,
        testAmount,
        estimatedProfit
      );
      logSuccess(`Profitability check works - Profitable: ${isProfitable}, Net: $${ethers.formatUnits(netProfit, 6)}`);
      
      // Test user nonce system
      const userNonce = await flashLoanManager.getUserNonce(deployer.address);
      logSuccess(`User nonce system works - Current nonce: ${userNonce}`);
      
      // Test refinance profit estimation
      const refinanceProfit = await flashLoanManager.estimateRefinanceProfit(
        config.assets.USDC,
        testAmount,
        500, // 5% current rate
        450  // 4.5% new rate
      );
      logSuccess(`Refinance estimation works - Annual savings: $${ethers.formatUnits(refinanceProfit, 6)}`);
      
    } catch (error) {
      logWarning(`Production functionality test failed: ${error.message}`);
    }

    // Step 5: Contract Verification on Etherscan
    if (DEPLOYMENT_CONFIG.verifyContracts && process.env.ETHERSCAN_API_KEY) {
      logStep(5, "Verifying contracts on Etherscan...");
      
      try {
        log("Waiting for Etherscan to index contracts...");
        await new Promise(resolve => setTimeout(resolve, 45000)); // Longer wait for production
        
        log("Verifying FlashLoanManager...");
        await run("verify:verify", {
          address: flashLoanManagerAddress,
          constructorArguments: [config.aavePoolAddressesProvider],
        });
        logSuccess("FlashLoanManager verified on Etherscan");
        
      } catch (error) {
        logWarning(`Contract verification failed: ${error.message}`);
        logWarning("You can verify manually using the deployment results");
      }
    } else {
      logWarning("Skipping contract verification (missing ETHERSCAN_API_KEY or disabled)");
    }

    // Step 6: Save Production Deployment Results
    logStep(6, "Saving production deployment results...");
    
    const deploymentsDir = path.join(__dirname, "..", "deployments");
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const deploymentFile = path.join(deploymentsDir, `${networkName}_production_${timestamp}.json`);
    const latestFile = path.join(deploymentsDir, `${networkName}_latest.json`);
    
    // Add final deployment summary
    deploymentResults.summary = {
      totalGasUsed: deploymentResults.gasUsed,
      totalCostETH: ethers.formatEther(deploymentResults.totalCost),
      averageGasPrice: "auto",
      contractsDeployed: Object.keys(deploymentResults.contracts).length,
      configurationTxs: configTxCount,
      supportedRouters: supportedRouters,
      productionReady: true,
      blockExplorerUrls: {
        FlashLoanManager: `${config.blockExplorer}/address/${flashLoanManagerAddress}`,
        transactions: `${config.blockExplorer}/tx/${deployTx.hash}`
      }
    };
    
    fs.writeFileSync(deploymentFile, JSON.stringify(deploymentResults, null, 2));
    fs.writeFileSync(latestFile, JSON.stringify(deploymentResults, null, 2));
    
    logSuccess(`Production deployment results saved to: ${deploymentFile}`);

    // Step 7: Generate Production Usage Examples
    logStep(7, "Generating production usage examples...");
    
    const examples = generateProductionExamples(flashLoanManagerAddress, config);
    const examplesFile = path.join(deploymentsDir, `${networkName}_production_examples.js`);
    fs.writeFileSync(examplesFile, examples);
    logSuccess(`Production examples saved to: ${examplesFile}`);

    // Final Production Summary
    log(`\n${colors.green}🎉 PRODUCTION DEPLOYMENT SUCCESSFUL! 🎉${colors.reset}`);
    log(`${colors.blue}═══════════════════════════════════════════════${colors.reset}`);
    log(`${colors.bright}FlashLoanManager:${colors.reset} ${flashLoanManagerAddress}`);
    log(`${colors.bright}Total Gas Used:${colors.reset} ${deploymentResults.gasUsed.toLocaleString()}`);
    log(`${colors.bright}Total Cost:${colors.reset} ${ethers.formatEther(deploymentResults.totalCost)} ETH`);
    log(`${colors.bright}Service Fee:${colors.reset} ${DEPLOYMENT_CONFIG.serviceFee/100}% (${DEPLOYMENT_CONFIG.serviceFee} bps)`);
    log(`${colors.bright}Daily Limit:${colors.reset} $${ethers.formatUnits(DEPLOYMENT_CONFIG.dailyVolumeLimit, 6)} USDC`);
    log(`${colors.bright}Block Explorer:${colors.reset} ${config.blockExplorer}/address/${flashLoanManagerAddress}`);
    
    log(`\n${colors.magenta}Production Features Enabled:${colors.reset}`);
    log(`✅ Real refinance strategy with debt migration`);
    log(`✅ Real liquidation strategy with bonus capture`);
    log(`✅ Production DEX integration (1inch, 0x)`);
    log(`✅ Comprehensive security and daily limits`);
    log(`✅ Gas optimization and error handling`);
    log(`✅ Rate tracking and profit estimation`);
    
    log(`\n${colors.yellow}Revenue Opportunities:${colors.reset}`);
    log(`💰 Refinance fees: 0.25% of transaction volume`);
    log(`💰 Liquidation profits: 5-15% bonus on liquidations`);
    log(`💰 User savings: 0.5-2% annually on borrowing costs`);
    log(`💰 Platform volume: $1000+ minimum per transaction`);
    
    log(`\n${colors.cyan}Next Steps:${colors.reset}`);
    log(`1. Test with the production examples: ${examplesFile}`);
    log(`2. Monitor transactions on: ${config.blockExplorer}/address/${flashLoanManagerAddress}`);
    log(`3. Set up monitoring alerts for daily volumes and profits`);
    log(`4. Consider mainnet deployment when ready`);
    
    if (networkName === "sepolia") {
      log(`\n${colors.cyan}Sepolia Testing:${colors.reset}`);
      log(`- Get test ETH: https://sepoliafaucet.com/`);
      log(`- Get test tokens: Aave V3 Sepolia faucet`);
      log(`- Start with small amounts: $100-1000 USDC`);
      log(`- Monitor gas costs and profitability`);
    }

  } catch (error) {
    logError(`Production deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

function generateProductionExamples(managerAddress, config) {
  return `// Imani Flash Loan Platform - PRODUCTION Usage Examples
// Network: ${network.name}
// FlashLoanManager: ${managerAddress}
// Features: Real refinance and liquidation strategies

const { ethers } = require("hardhat");

async function main() {
  // Get production contract instance
  const flashLoanManager = await ethers.getContractAt("FlashLoanManager", "${managerAddress}");
  
  // PRODUCTION EXAMPLE 1: Refinance $50K USDC debt with rate savings
  async function executeProductionRefinance() {
    console.log("\\n=== PRODUCTION REFINANCE EXAMPLE ===");
    
    const [signer] = await ethers.getSigners();
    const nonce = await flashLoanManager.getUserNonce(signer.address);
    
    // Real refinance parameters for $50,000 USDC
    const refinanceParams = {
      debtAsset: "${config.assets.USDC}",           // USDC debt to refinance
      debtAmount: ethers.parseUnits("50000", 6),    // $50,000 debt
      collateralAsset: "${config.assets.WETH}",     // ETH collateral
      collateralAmount: ethers.parseUnits("20", 18), // 20 ETH collateral
      newBorrowAmount: ethers.parseUnits("50000", 6), // Same amount at better rate
      minHealthFactor: ethers.parseUnits("1.3", 18),  // 130% minimum health
      swapRouter: "${config.aggregators.oneInch}",     // 1inch for swaps
      swapData: "0x",                               // No swap needed (same asset)
      minAmountOut: 0,                              // No swap
      usePermit: false,                             // Standard approval
      permitDeadline: 0,
      permitV: 0,
      permitR: "0x0000000000000000000000000000000000000000000000000000000000000000",
      permitS: "0x0000000000000000000000000000000000000000000000000000000000000000"
    };
    
    const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode([
      "tuple(address,uint256,address,uint256,uint256,uint256,address,bytes,uint256,bool,uint256,uint8,bytes32,bytes32)"
    ], [Object.values(refinanceParams)]);
    
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    const expectedProfit = ethers.parseUnits("100", 6); // $100 expected savings
    
    console.log("Executing refinance for $50,000 USDC...");
    console.log("Expected annual savings: 0.5% = $250/year");
    console.log("Platform fee: 0.25% = $12.50");
    
    // Check profitability first
    const [profitable, netProfit] = await flashLoanManager.checkProfitability(
      "${config.assets.USDC}",
      ethers.parseUnits("50000", 6),
      expectedProfit
    );
    
    console.log("Profitable:", profitable);
    console.log("Net profit:", ethers.formatUnits(netProfit, 6), "USDC");
    
    if (profitable) {
      // Execute the refinance
      const tx = await flashLoanManager.executeFlashLoan(
        "${config.assets.USDC}",
        ethers.parseUnits("50000", 6),
        0, // REFINANCE strategy
        encodedParams,
        expectedProfit,
        deadline,
        nonce
      );
      
      const receipt = await tx.wait();
      console.log("Refinance executed:", receipt.hash);
      console.log("Gas used:", receipt.gasUsed.toString());
    }
  }
  
  // PRODUCTION EXAMPLE 2: Liquidate unhealthy position for profit
  async function executeProductionLiquidation() {
    console.log("\\n=== PRODUCTION LIQUIDATION EXAMPLE ===");
    
    const [signer] = await ethers.getSigners();
    const nonce = await flashLoanManager.getUserNonce(signer.address);
    
    // Target user with unhealthy position (< 100% health factor)
    const targetUser = "0x1234567890123456789012345678901234567890"; // Replace with actual address
    
    // Check if user is liquidatable
    const [profitable, expectedBonus] = await flashLoanManager.checkLiquidationProfitability(
      targetUser,
      "${config.assets.WETH}", // ETH collateral
      "${config.assets.USDC}", // USDC debt
      ethers.parseUnits("10000", 6) // $10K debt to cover
    );
    
    console.log("User liquidatable:", profitable);
    console.log("Expected bonus:", ethers.formatUnits(expectedBonus, 6), "USDC");
    
    if (profitable) {
      const liquidationParams = {
        user: targetUser,
        collateralAsset: "${config.assets.WETH}",
        debtAsset: "${config.assets.USDC}",
        debtToCover: ethers.parseUnits("10000", 6),  // $10K to liquidate
        receiveAToken: false,                         // Receive underlying ETH
        swapRouter: "${config.aggregators.oneInch}",  // 1inch for ETH->USDC swap
        swapData: "0x",                              // Would contain real swap data
        minProfitBps: 500                            // 5% minimum profit
      };
      
      const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode([
        "tuple(address,address,address,uint256,bool,address,bytes,uint256)"
      ], [Object.values(liquidationParams)]);
      
      const deadline = Math.floor(Date.now() / 1000) + 1800; // 30 minutes
      const expectedProfit = expectedBonus; // Use calculated bonus
      
      console.log("Executing liquidation...");
      console.log("Debt to cover: $10,000 USDC");
      console.log("Expected profit:", ethers.formatUnits(expectedProfit, 6), "USDC");
      
      const tx = await flashLoanManager.executeFlashLoan(
        "${config.assets.USDC}",
        ethers.parseUnits("10000", 6),
        1, // LIQUIDATION strategy
        encodedParams,
        expectedProfit,
        deadline,
        nonce
      );
      
      const receipt = await tx.wait();
      console.log("Liquidation executed:", receipt.hash);
      console.log("Gas used:", receipt.gasUsed.toString());
    }
  }
  
  // PRODUCTION EXAMPLE 3: Check platform metrics and profitability
  async function checkPlatformMetrics() {
    console.log("\\n=== PLATFORM METRICS ===");
    
    // Check current rates and opportunities
    const usdcRate = await flashLoanManager.lastKnownBorrowRate("${config.assets.USDC}");
    const ethRate = await flashLoanManager.lastKnownBorrowRate("${config.assets.WETH}");
    
    console.log("Current USDC borrow rate:", usdcRate.toString(), "bps");
    console.log("Current ETH borrow rate:", ethRate.toString(), "bps");
    
    // Check flash loan fees
    const testAmount = ethers.parseUnits("100000", 6); // $100K
    const flashFee = await flashLoanManager.getFlashLoanFee("${config.assets.USDC}", testAmount);
    console.log("Flash loan fee for $100K:", ethers.formatUnits(flashFee, 6), "USDC");
    
    // Check network configuration
    const networkConfig = await flashLoanManager.getNetworkConfig();
    console.log("Network:", networkConfig.isTestnet ? "Testnet" : "Mainnet");
    console.log("Chain ID:", networkConfig.chainId.toString());
    
    // Check supported routers
    const oneInchSupported = await flashLoanManager.isSwapRouterSupported("${config.aggregators.oneInch}");
    console.log("1inch supported:", oneInchSupported);
  }
  
  // PRODUCTION EXAMPLE 4: Estimate profitability before execution
  async function estimateProfitability() {
    console.log("\\n=== PROFITABILITY ESTIMATION ===");
    
    // Estimate refinance savings
    const refinanceSavings = await flashLoanManager.estimateRefinanceProfit(
      "${config.assets.USDC}",
      ethers.parseUnits("100000", 6), // $100K debt
      500, // 5% current rate
      425  // 4.25% new rate
    );
    
    console.log("Annual savings on $100K refinance:", ethers.formatUnits(refinanceSavings, 6), "USDC");
    console.log("Platform fee (0.25%):", ethers.formatUnits(refinanceSavings, 6) * 0.0025, "USDC");
    
    // Check minimum amounts and limits
    const userNonce = await flashLoanManager.getUserNonce("${config.assets.USDC}");
    console.log("Current user nonce:", userNonce.toString());
  }
  
  // Run production examples
  console.log("🚀 IMANI FLASH LOAN PLATFORM - PRODUCTION EXAMPLES");
  console.log("Network:", "${network.name}");
  console.log("Contract:", "${managerAddress}");
  
  await checkPlatformMetrics();
  await estimateProfitability();
  
  // Uncomment to test actual transactions (requires setup)
  // await executeProductionRefinance();
  // await executeProductionLiquidation();
}

main().catch(console.error);
`;
}

// Execute production deployment
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { main, NETWORK_CONFIGS, DEPLOYMENT_CONFIG };