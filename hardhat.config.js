require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-verify");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-contract-sizer");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000, // Optimized for deployment cost vs execution cost
      },
      viaIR: true, // Enable IR compilation for better optimization
      metadata: {
        bytecodeHash: "none", // Remove metadata hash for deterministic builds
      },
    },
  },
  
  networks: {
    hardhat: {
      chainId: 31337,
      forking: {
        url: process.env.MAINNET_RPC_URL || "https://eth-mainnet.alchemyapi.io/v2/demo",
        blockNumber: 18500000, // Pin to specific block for consistent testing
      },
      accounts: {
        count: 20,
        accountsBalance: "10000000000000000000000", // 10,000 ETH per account
      },
      mining: {
        auto: true,
        interval: [3000, 6000], // Random block time between 3-6 seconds
      },
    },
    
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/demo",
      chainId: 11155111,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: "auto",
      gas: "auto",
      timeout: 60000,
      httpHeaders: {
        "User-Agent": "Imani-FlashLoan-App/1.0.0",
      },
    },
    
    mainnet: {
      url: process.env.MAINNET_RPC_URL || "https://eth-mainnet.alchemyapi.io/v2/demo",
      chainId: 1,
      accounts: process.env.MAINNET_PRIVATE_KEY ? [process.env.MAINNET_PRIVATE_KEY] : [],
      gasPrice: "auto",
      gas: "auto",
      timeout: 120000,
      httpHeaders: {
        "User-Agent": "Imani-FlashLoan-App/1.0.0",
      },
    },
  },
  
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY,
      sepolia: process.env.ETHERSCAN_API_KEY,
    },
    customChains: [],
  },
  
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    gasPrice: 25, // gwei
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    outputFile: "gas-report.txt",
    noColors: false,
    rst: false,
    rstTitle: "Gas Usage Report",
    showTimeSpent: true,
    excludeContracts: ["Migrations", "MockERC20"],
  },
  
  contractSizer: {
    alphaSort: true,
    disambiguatePaths: false,
    runOnCompile: true,
    strict: true,
    only: [],
    except: ["Mock", "Test"],
  },
  
  mocha: {
    timeout: 60000, // 60 seconds
    reporter: "spec",
    slow: 10000, // 10 seconds
  },
  
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
    alwaysGenerateOverloads: false,
    externalArtifacts: ["node_modules/@aave/core-v3/artifacts/contracts/**/*.sol/!(*.dbg.json)"],
  },
  
  // Path configurations
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  
  // Verification settings
  verify: {
    etherscan: {
      apiUrl: "https://api.etherscan.io/api",
    },
  },
  
  // Coverage settings
  coverage: {
    include: ["contracts/**/*.sol"],
    exclude: ["contracts/mocks/**/*.sol", "contracts/test/**/*.sol"],
  },
  
  // Warning settings
  warnings: {
    "@aave/core-v3/**/*": "off",
    "@openzeppelin/contracts/**/*": "off",
  },
};