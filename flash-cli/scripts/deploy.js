// scripts/deploy.js
import { ethers, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  
  console.log("Deploying contracts with the account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await deployer.provider.getBalance(deployer.address)), "ETH");
  
  // Get network information
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name, "ChainId:", network.chainId.toString());

  // Sepolia testnet addresses
  const aaveAddressesProvider = "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A"; // Aave V3 PoolAddressesProvider
  const treasuryAddress = deployer.address; // Using deployer's address as the treasury
  const uniswapV3Router = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap V3 SwapRouter
  const balancerVault = "0x0000000000000000000000000000000000000000"; // Not available on Sepolia

  console.log("\nDeployment parameters:");
  console.log("- Aave AddressesProvider:", aaveAddressesProvider);
  console.log("- Treasury Address:", treasuryAddress);
  console.log("- Uniswap V3 Router:", uniswapV3Router);
  console.log("- Balancer Vault:", balancerVault);

  const initializerArgs = [
    aaveAddressesProvider,
    treasuryAddress,
    uniswapV3Router,
    balancerVault,
  ];

  try {
    // Get the contract factory
    const Manager = await ethers.getContractFactory("EnhancedFlashLoanManager");
    console.log("\nContract factory created successfully");

    // Deploy the proxy and initialize it
    console.log("Deploying EnhancedFlashLoanManager proxy...");
    const contract = await upgrades.deployProxy(Manager, initializerArgs, {
      initializer: "initialize",
      kind: "uups",
    });

    // Wait for the deployment transaction to be mined
    console.log("Waiting for deployment transaction to be mined...");
    await contract.waitForDeployment();

    const contractAddress = await contract.getAddress();
    console.log("✅ EnhancedFlashLoanManager proxy deployed to:", contractAddress);

    // Get implementation address
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(
      contractAddress
    );
    console.log("📋 Implementation contract deployed to:", implementationAddress);

    // Get deployment transaction hash
    const deploymentTx = contract.deploymentTransaction();
    if (deploymentTx) {
      console.log("🔗 Deployment transaction hash:", deploymentTx.hash);
      
      // Wait for confirmations
      console.log("Waiting for transaction confirmations...");
      await deploymentTx.wait(2); // Wait for 2 confirmations
      console.log("✅ Transaction confirmed");
    }

    // Verify contract initialization
    console.log("\nVerifying contract initialization...");
    try {
      const owner = await contract.owner();
      console.log("Contract owner:", owner);
      
      const addressProvider = await contract.ADDRESSES_PROVIDER();
      console.log("Addresses provider:", addressProvider);
      
      console.log("✅ Contract initialized successfully");
    } catch (verifyError) {
      console.log("⚠️ Could not verify initialization:", verifyError.message);
    }

    // Output deployment summary
    console.log("\n" + "=".repeat(50));
    console.log("DEPLOYMENT SUMMARY");
    console.log("=".repeat(50));
    console.log("Network:", network.name);
    console.log("Proxy Address:", contractAddress);
    console.log("Implementation:", implementationAddress);
    console.log("Deployer:", deployer.address);
    if (deploymentTx) {
      console.log("Tx Hash:", deploymentTx.hash);
    }
    console.log("=".repeat(50));

    // Save deployment info to file
    const deploymentInfo = {
      network: network.name,
      chainId: network.chainId.toString(),
      proxyAddress: contractAddress,
      implementationAddress: implementationAddress,
      deployer: deployer.address,
      deploymentTx: deploymentTx?.hash,
      timestamp: new Date().toISOString(),
      initializerArgs: {
        aaveAddressesProvider,
        treasuryAddress,
        uniswapV3Router,
        balancerVault,
      }
    };

    // Write to file (you might want to save this info)
    console.log("\n📄 Deployment info:", JSON.stringify(deploymentInfo, null, 2));

  } catch (error) {
    console.error("❌ Deployment failed:", error.message);
    
    // Log more details for debugging
    if (error.data) {
      console.error("Error data:", error.data);
    }
    if (error.transaction) {
      console.error("Failed transaction:", error.transaction);
    }
    
    throw error;
  }
}

main()
  .then(() => {
    console.log("🎉 Deployment completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("💥 Deployment script failed:", error);
    process.exitCode = 1;
  });