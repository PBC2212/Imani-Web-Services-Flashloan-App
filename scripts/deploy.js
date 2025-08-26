import pkg from "hardhat";
const { ethers, run, network } = pkg;
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("🚀 Deploying FlashLoanManager...");

  const [deployer] = await ethers.getSigners();
  console.log("👤 Deploying with account:", deployer.address);

  // Check balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("💰 Account balance:", ethers.formatEther(balance), "ETH");

  if (balance < ethers.parseEther("0.01")) {
    console.warn("⚠️ Low balance! You might need more ETH for deployment");
  }

  // Get network-specific addresses
  let addressesProvider, uniswapRouter, treasury;
  
  if (network.name === "sepolia") {
    // Sepolia testnet addresses
    addressesProvider = "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A"; // Aave V3 Sepolia
    uniswapRouter = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";     // Uniswap V3 Sepolia
    treasury = deployer.address; // Use deployer as treasury for testing
  } else if (network.name === "mainnet") {
    // Mainnet addresses
    addressesProvider = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e"; // Aave V3 Mainnet
    uniswapRouter = "0xE592427A0AEce92De3Edee1F18E0157C05861564";     // Uniswap V3 Mainnet
    treasury = process.env.TREASURY_ADDRESS || deployer.address;
  } else {
    // Local/Hardhat - use mock addresses
    console.log("🧪 Local network detected, using mock addresses");
    addressesProvider = "0x1234567890123456789012345678901234567890"; // Mock
    uniswapRouter = "0x2345678901234567890123456789012345678901";     // Mock
    treasury = deployer.address;
  }

  console.log("🏦 Using Aave Provider:", addressesProvider);
  console.log("🔄 Using Uniswap Router:", uniswapRouter);
  console.log("💰 Using Treasury:", treasury);

  // Deploy the contract
  console.log("📦 Deploying contract...");
  const Contract = await ethers.getContractFactory("FlashLoanManager");
  
  console.log("⛽ Using gas limit: 5,000,000");

  const contract = await Contract.deploy(
    addressesProvider,
    treasury,
    uniswapRouter,
    {
      gasLimit: 5000000, // 5M gas should be plenty
      maxFeePerGas: ethers.parseUnits("20", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("2", "gwei")
    }
  );

  console.log("⏳ Waiting for deployment...");
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log(`✅ FlashLoanManager deployed at: ${address}`);

  // Set up permissions
  console.log("🔐 Setting up permissions...");
  
  try {
    // Grant OPERATOR_ROLE to deployer for CLI usage
    const OPERATOR_ROLE = await contract.OPERATOR_ROLE();
    const hasRole = await contract.hasRole(OPERATOR_ROLE, deployer.address);
    
    if (!hasRole) {
      console.log("⏳ Granting OPERATOR_ROLE...");
      const tx = await contract.grantRole(OPERATOR_ROLE, deployer.address);
      await tx.wait();
      console.log("✅ Granted OPERATOR_ROLE to deployer");
    } else {
      console.log("✅ Deployer already has OPERATOR_ROLE");
    }

    // Set deployer as authorized caller
    const isAuthorized = await contract.authorizedCallers(deployer.address);
    if (!isAuthorized) {
      console.log("⏳ Adding authorized caller...");
      const tx = await contract.setAuthorizedCaller(deployer.address, true);
      await tx.wait();
      console.log("✅ Added deployer as authorized caller");
    } else {
      console.log("✅ Deployer already authorized");
    }
  } catch (error) {
    console.warn("⚠️ Permission setup failed:", error.message);
    console.warn("You can set permissions manually later");
  }

  // Save contract address into .env for CLI
  try {
    let envContent = "";
    if (fs.existsSync(".env")) {
      envContent = fs.readFileSync(".env", "utf8");
    }

    if (envContent.includes("CONTRACT_ADDRESS=")) {
      envContent = envContent.replace(/CONTRACT_ADDRESS=.*/g, `CONTRACT_ADDRESS=${address}`);
    } else {
      envContent += `\nCONTRACT_ADDRESS=${address}\n`;
    }

    // Also save network-specific info
    if (!envContent.includes("DEPLOYED_NETWORK=")) {
      envContent += `DEPLOYED_NETWORK=${network.name}\n`;
    } else {
      envContent = envContent.replace(/DEPLOYED_NETWORK=.*/g, `DEPLOYED_NETWORK=${network.name}`);
    }

    fs.writeFileSync(".env", envContent);
    console.log("📌 Contract address saved to .env");
  } catch (error) {
    console.warn("⚠️ Could not save to .env:", error.message);
    console.log("💡 Manually add this to your .env file:");
    console.log(`CONTRACT_ADDRESS=${address}`);
  }

  // Display useful info
  console.log("\n📊 Deployment Summary:");
  console.log("===========================");
  console.log("🌐 Network:", network.name);
  console.log("📄 Contract Address:", address);
  console.log("💰 Treasury:", treasury);
  console.log("🔐 Deployer Authorized:", "✅");
  console.log("🏦 Aave Provider:", addressesProvider);
  console.log("🔄 Uniswap Router:", uniswapRouter);

  // Auto-verify if ETHERSCAN_API_KEY is set and not on hardhat/local
  if (
    process.env.ETHERSCAN_API_KEY &&
    network.name !== "hardhat" &&
    network.name !== "localhost"
  ) {
    console.log("\n🔎 Waiting for Etherscan to index...");
    console.log("⏳ Please wait 30 seconds...");
    await new Promise((r) => setTimeout(r, 30000)); // wait 30s before verify

    console.log("🔎 Verifying contract on Etherscan...");
    try {
      await run("verify:verify", {
        address: address,
        constructorArguments: [addressesProvider, treasury, uniswapRouter],
      });
      console.log("✅ Verification complete!");
    } catch (err) {
      console.warn("⚠️ Verification failed:", err.message);
      console.warn("💡 You can verify manually later with:");
      console.warn(`npx hardhat verify ${address} ${addressesProvider} ${treasury} ${uniswapRouter} --network ${network.name}`);
    }
  }

  console.log("\n🎉 Deployment complete! You can now use the CLI:");
  console.log("   node cli.js status");
  console.log("\n🌐 View on Etherscan:");
  if (network.name === "sepolia") {
    console.log(`   https://sepolia.etherscan.io/address/${address}`);
  } else if (network.name === "mainnet") {
    console.log(`   https://etherscan.io/address/${address}`);
  }
}

main().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exitCode = 1;
});