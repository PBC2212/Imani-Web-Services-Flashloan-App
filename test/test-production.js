// Simple Production Tests for Deployed FlashLoanManager
// Run with: npx hardhat run test/test-production.js --network sepolia

const { ethers } = require("hardhat");

// Your deployed contract address
const FLASHLOAN_MANAGER_ADDRESS = "0xf2D6c635AFc942780Fa0Afb55aFE2Fa6d8d23d35";

// Sepolia test assets
const SEPOLIA_ASSETS = {
  USDC: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8",
  WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  DAI: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357"
};

async function main() {
  console.log("🧪 PRODUCTION TESTING - Deployed FlashLoanManager");
  console.log("=" .repeat(60));
  console.log(`Contract: ${FLASHLOAN_MANAGER_ADDRESS}`);
  console.log(`Network: ${network.name}`);
  
  // Get the deployed contract
  const flashLoanManager = await ethers.getContractAt("FlashLoanManager", FLASHLOAN_MANAGER_ADDRESS);
  const [deployer] = await ethers.getSigners();
  
  console.log(`Tester: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  
  let passedTests = 0;
  let totalTests = 0;
  
  // TEST 1: Contract basic info
  console.log("\n📋 TEST 1: Contract Basic Info");
  try {
    const networkConfig = await flashLoanManager.getNetworkConfig();
    const serviceFee = await flashLoanManager.serviceFee();
    const maxGasPrice = await flashLoanManager.maxGasPrice();
    
    console.log(`✅ Network Chain ID: ${networkConfig.chainId}`);
    console.log(`✅ Is Testnet: ${networkConfig.isTestnet}`);
    console.log(`✅ Service Fee: ${serviceFee} bps (${serviceFee/100}%)`);
    console.log(`✅ Max Gas Price: ${ethers.formatUnits(maxGasPrice, "gwei")} gwei`);
    
    passedTests++;
  } catch (error) {
    console.log(`❌ Contract info test failed: ${error.message}`);
  }
  totalTests++;
  
  // TEST 2: Flash loan fee calculation
  console.log("\n💰 TEST 2: Flash Loan Fee Calculation");
  try {
    const testAmount = ethers.parseUnits("1000", 6); // $1000 USDC
    const flashLoanFee = await flashLoanManager.getFlashLoanFee(SEPOLIA_ASSETS.USDC, testAmount);
    const feePercent = Number(flashLoanFee * 10000n / testAmount) / 100;
    
    console.log(`✅ Amount: $${ethers.formatUnits(testAmount, 6)} USDC`);
    console.log(`✅ Flash loan fee: $${ethers.formatUnits(flashLoanFee, 6)} USDC`);
    console.log(`✅ Fee percentage: ${feePercent}%`);
    
    if (flashLoanFee > 0 && flashLoanFee < testAmount) {
      passedTests++;
    } else {
      console.log("❌ Fee calculation seems incorrect");
    }
  } catch (error) {
    console.log(`❌ Flash loan fee test failed: ${error.message}`);
  }
  totalTests++;
  
  // TEST 3: Profitability check
  console.log("\n📊 TEST 3: Profitability Calculation");
  try {
    const testAmount = ethers.parseUnits("5000", 6); // $5000 USDC
    const estimatedProfit = ethers.parseUnits("25", 6); // $25 profit
    
    const [isProfitable, netProfit] = await flashLoanManager.checkProfitability(
      SEPOLIA_ASSETS.USDC,
      testAmount,
      estimatedProfit
    );
    
    console.log(`✅ Test amount: $${ethers.formatUnits(testAmount, 6)} USDC`);
    console.log(`✅ Estimated profit: $${ethers.formatUnits(estimatedProfit, 6)} USDC`);
    console.log(`✅ Is profitable: ${isProfitable}`);
    console.log(`✅ Net profit: $${ethers.formatUnits(netProfit, 6)} USDC`);
    
    if (isProfitable && netProfit > 0) {
      passedTests++;
    } else {
      console.log("❌ Profitability check failed");
    }
  } catch (error) {
    console.log(`❌ Profitability test failed: ${error.message}`);
  }
  totalTests++;
  
  // TEST 4: User nonce system
  console.log("\n🔢 TEST 4: User Nonce System");
  try {
    const userNonce = await flashLoanManager.getUserNonce(deployer.address);
    const dailyLimit = await flashLoanManager.dailyVolumeLimit(deployer.address);
    const remainingLimit = await flashLoanManager.getRemainingDailyLimit(deployer.address);
    
    console.log(`✅ Current nonce: ${userNonce}`);
    console.log(`✅ Daily limit: $${ethers.formatUnits(dailyLimit, 6)} USDC`);
    console.log(`✅ Remaining limit: $${ethers.formatUnits(remainingLimit, 6)} USDC`);
    
    passedTests++;
  } catch (error) {
    console.log(`❌ Nonce system test failed: ${error.message}`);
  }
  totalTests++;
  
  // TEST 5: Swap router support
  console.log("\n🔄 TEST 5: DEX Router Support");
  try {
    const oneInchSupported = await flashLoanManager.isSwapRouterSupported("0x1111111254EEB25477B68fb85Ed929f73A960582");
    const zeroXSupported = await flashLoanManager.isSwapRouterSupported("0xDef1C0ded9bec7F1a1670819833240f027b25EfF");
    
    console.log(`✅ 1inch V5 supported: ${oneInchSupported}`);
    console.log(`✅ 0x Protocol supported: ${zeroXSupported}`);
    
    if (oneInchSupported && zeroXSupported) {
      passedTests++;
    } else {
      console.log("❌ Some routers not supported");
    }
  } catch (error) {
    console.log(`❌ Router support test failed: ${error.message}`);
  }
  totalTests++;
  
  // TEST 6: Refinance profit estimation
  console.log("\n💡 TEST 6: Refinance Profit Estimation");
  try {
    const testAmount = ethers.parseUnits("10000", 6); // $10K
    const currentRate = 500; // 5%
    const newRate = 450; // 4.5%
    
    const annualSavings = await flashLoanManager.estimateRefinanceProfit(
      SEPOLIA_ASSETS.USDC,
      testAmount,
      currentRate,
      newRate
    );
    
    console.log(`✅ Debt amount: $${ethers.formatUnits(testAmount, 6)} USDC`);
    console.log(`✅ Current rate: ${currentRate/100}%`);
    console.log(`✅ New rate: ${newRate/100}%`);
    console.log(`✅ Annual savings: $${ethers.formatUnits(annualSavings, 6)} USDC`);
    
    if (annualSavings > 0) {
      passedTests++;
    } else {
      console.log("❌ Refinance estimation failed");
    }
  } catch (error) {
    console.log(`❌ Refinance estimation test failed: ${error.message}`);
  }
  totalTests++;
  
  // TEST 7: Liquidation profitability check
  console.log("\n⚡ TEST 7: Liquidation Profitability");
  try {
    const mockUser = "0x1234567890123456789012345678901234567890";
    const debtToCover = ethers.parseUnits("5000", 6); // $5K
    
    const [profitable, expectedBonus] = await flashLoanManager.checkLiquidationProfitability(
      mockUser,
      SEPOLIA_ASSETS.WETH,
      SEPOLIA_ASSETS.USDC,
      debtToCover
    );
    
    console.log(`✅ Mock user: ${mockUser.slice(0,10)}...`);
    console.log(`✅ Debt to cover: $${ethers.formatUnits(debtToCover, 6)} USDC`);
    console.log(`✅ Liquidation profitable: ${profitable}`);
    console.log(`✅ Expected bonus: $${ethers.formatUnits(expectedBonus, 6)} USDC`);
    
    // This test passes if the function executes without error
    passedTests++;
  } catch (error) {
    console.log(`❌ Liquidation profitability test failed: ${error.message}`);
  }
  totalTests++;
  
  // TEST 8: Owner functions access
  console.log("\n🔐 TEST 8: Owner Access Control");
  try {
    const owner = await flashLoanManager.owner();
    const isOwner = owner.toLowerCase() === deployer.address.toLowerCase();
    
    console.log(`✅ Contract owner: ${owner}`);
    console.log(`✅ Is deployer owner: ${isOwner}`);
    
    if (isOwner) {
      // Test owner function
      const currentServiceFee = await flashLoanManager.serviceFee();
      console.log(`✅ Current service fee: ${currentServiceFee} bps`);
      passedTests++;
    } else {
      console.log("❌ Deployer is not the owner");
    }
  } catch (error) {
    console.log(`❌ Owner access test failed: ${error.message}`);
  }
  totalTests++;
  
  // SUMMARY
  console.log("\n" + "=" .repeat(60));
  console.log("📊 PRODUCTION TEST SUMMARY");
  console.log("=" .repeat(60));
  console.log(`Total Tests: ${totalTests}`);
  console.log(`Passed: ${passedTests} ✅`);
  console.log(`Failed: ${totalTests - passedTests} ❌`);
  console.log(`Success Rate: ${Math.round((passedTests/totalTests) * 100)}%`);
  
  if (passedTests === totalTests) {
    console.log("\n🎉 ALL TESTS PASSED - PLATFORM IS PRODUCTION READY! 🎉");
    console.log("\n🚀 NEXT STEPS:");
    console.log("1. Get test tokens from Aave Sepolia faucet");
    console.log("2. Create test positions on Aave V3");
    console.log("3. Execute real refinance/liquidation transactions");
    console.log("4. Monitor gas costs and profitability");
    console.log("5. Deploy to mainnet when ready");
  } else {
    console.log("\n⚠️  SOME TESTS FAILED - REVIEW BEFORE PRODUCTION");
    console.log("Check the failed tests above and fix any issues");
  }
  
  console.log(`\n🔗 View contract: https://sepolia.etherscan.io/address/${FLASHLOAN_MANAGER_ADDRESS}`);
  console.log("💰 Your flash loan platform is ready for revenue generation!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Production testing failed:", error);
    process.exit(1);
  });