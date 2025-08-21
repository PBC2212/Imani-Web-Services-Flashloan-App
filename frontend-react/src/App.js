import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { Wallet, Zap, RefreshCw, CheckCircle, AlertTriangle, ExternalLink, Calculator } from 'lucide-react';
import './App.css';

// Your deployed contract details
const CONTRACT_ADDRESS = "0xf2D6c635AFc942780Fa0Afb55aFE2Fa6d8d23d35";
const SEPOLIA_CHAIN_ID = 11155111;

// Contract ABI (simplified for frontend)
const CONTRACT_ABI = [
  "function executeFlashLoan(address asset, uint256 amount, uint8 strategy, bytes calldata strategyData, uint256 expectedProfit, uint256 deadline, uint256 nonce) external",
  "function getFlashLoanFee(address asset, uint256 amount) external view returns (uint256)",
  "function checkProfitability(address asset, uint256 amount, uint256 estimatedProfit) external view returns (bool, uint256)",
  "function getUserNonce(address user) external view returns (uint256)",
  "function estimateRefinanceProfit(address asset, uint256 amount, uint256 currentRate, uint256 newRate) external view returns (uint256)",
  "function serviceFee() external view returns (uint256)",
  "function owner() external view returns (address)"
];

// Sepolia asset addresses
const ASSETS = {
  USDC: { address: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8", decimals: 6, symbol: "USDC" },
  WETH: { address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", decimals: 18, symbol: "WETH" },
  DAI: { address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", decimals: 18, symbol: "DAI" }
};

function App() {
  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState('');
  const [contract, setContract] = useState(null);
  const [loading, setLoading] = useState(false);
  
  const [activeTab, setActiveTab] = useState('refinance');
  const [amount, setAmount] = useState('1000');
  const [selectedAsset, setSelectedAsset] = useState('USDC');
  const [currentRate, setCurrentRate] = useState('5.0');
  const [newRate, setNewRate] = useState('4.5');
  
  // Results states
  const [flashLoanFee, setFlashLoanFee] = useState(null);
  const [estimatedProfit, setEstimatedProfit] = useState(null);
  const [isProfitable, setIsProfitable] = useState(false);
  const [serviceFee, setServiceFee] = useState(null);
  const [userNonce, setUserNonce] = useState(null); // Fixed: Added missing state
  
  // Liquidation states
  const [targetUser, setTargetUser] = useState('0x1234567890123456789012345678901234567890');
  const [debtToCover, setDebtToCover] = useState('5000');
  const [collateralAsset, setCollateralAsset] = useState('WETH');
  const [liquidationBonus, setLiquidationBonus] = useState(null);

  // Rebalancer states  
  const [lpToken, setLpToken] = useState('USDC/WETH');
  const [currentRatio, setCurrentRatio] = useState('60/40');
  const [targetRatio, setTargetRatio] = useState('50/50');
  const [rebalanceFee, setRebalanceFee] = useState('0.1');

  // Connect wallet
  const connectWallet = async () => {
    if (typeof window.ethereum !== 'undefined') {
      try {
        setLoading(true);
        await window.ethereum.request({ method: 'eth_requestAccounts' });
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const network = await provider.getNetwork();
        
        if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0xaa36a7' }], // Sepolia
          });
        }
        
        const signer = await provider.getSigner();
        const address = await signer.getAddress();
        const contractInstance = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
        
        setAccount(address);
        setContract(contractInstance);
        setConnected(true);
        
        // Load initial data
        await loadContractData(contractInstance, address);
        
      } catch (error) {
        console.error('Failed to connect:', error);
        alert('Failed to connect wallet. Please try again.');
      } finally {
        setLoading(false);
      }
    } else {
      alert('Please install MetaMask to use this app');
    }
  };

  // Load contract data
  const loadContractData = async (contractInstance, userAddress) => {
    try {
      const [fee, nonce] = await Promise.all([
        contractInstance.serviceFee(),
        contractInstance.getUserNonce(userAddress)
      ]);
      
      setServiceFee(Number(fee));
      setUserNonce(Number(nonce));
    } catch (error) {
      console.error('Failed to load contract data:', error);
    }
  };

  // Calculate estimates
  const calculateEstimates = async () => {
    if (!contract || !amount) return;
    
    try {
      setLoading(true);
      const asset = ASSETS[selectedAsset];
      const amountWei = ethers.parseUnits(amount, asset.decimals);
      
      // Get flash loan fee
      const fee = await contract.getFlashLoanFee(asset.address, amountWei);
      setFlashLoanFee(ethers.formatUnits(fee, asset.decimals));
      
      // Estimate refinance profit if rates provided
      if (currentRate && newRate && parseFloat(currentRate) > parseFloat(newRate)) {
        const currentRateBps = Math.floor(parseFloat(currentRate) * 100);
        const newRateBps = Math.floor(parseFloat(newRate) * 100);
        
        const annualSavings = await contract.estimateRefinanceProfit(
          asset.address,
          amountWei,
          currentRateBps,
          newRateBps
        );
        
        const savingsFormatted = ethers.formatUnits(annualSavings, asset.decimals);
        setEstimatedProfit(savingsFormatted);
        
        // Check profitability
        const [profitable, netProfit] = await contract.checkProfitability(
          asset.address,
          amountWei,
          annualSavings
        );
        
        setIsProfitable(profitable);
      }
      
    } catch (error) {
      console.error('Failed to calculate estimates:', error);
    } finally {
      setLoading(false);
    }
  };

  // Calculate liquidation estimates
  const calculateLiquidationEstimates = async () => {
    if (!contract || !debtToCover) return;
    
    try {
      const asset = ASSETS[selectedAsset];
      const debtWei = ethers.parseUnits(debtToCover, asset.decimals);
      
      // 5% liquidation bonus (standard)
      const bonus = parseFloat(debtToCover) * 0.05;
      setLiquidationBonus(bonus.toFixed(2));
      
    } catch (error) {
      console.error('Failed to calculate liquidation:', error);
    }
  };

  // Execute liquidation
  const executeLiquidation = async () => {
    try {
      setLoading(true);
      alert(`🎯 Liquidation Demo!\n\nThis would liquidate:\n• User: ${targetUser.slice(0,10)}...\n• Debt: ${debtToCover} ${selectedAsset}\n• Collateral: ${collateralAsset}\n• Expected Bonus: ${liquidationBonus}\n\nLiquidation bonus: 5-15% profit!`);
    } catch (error) {
      alert(`Liquidation failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Execute rebalancing
  const executeRebalance = async () => {
    try {
      setLoading(true);
      const fee = parseFloat(amount) * (parseFloat(rebalanceFee) / 100);
      alert(`⚖️ Rebalancing Demo!\n\nThis would rebalance:\n• LP Token: ${lpToken}\n• From: ${currentRatio} → To: ${targetRatio}\n• Amount: ${amount}\n• Rebalance Fee: ${fee.toFixed(2)}\n\nSteady income from LP management!`);
    } catch (error) {
      alert(`Rebalancing failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const executeRefinance = async () => {
    if (!contract || !amount) return;
    
    try {
      setLoading(true);
      
      // For demo purposes, we'll just show an alert
      alert(`🚀 Demo Transaction!\n\nThis would execute a flash loan refinance for:\n• Amount: $${amount} ${selectedAsset}\n• From: ${currentRate}% → ${newRate}%\n• Annual Savings: $${estimatedProfit}\n• Platform Fee: 0.25%\n\nIn production, this executes a real transaction!`);
      
      // Update nonce to simulate transaction
      if (userNonce !== null) {
        setUserNonce(userNonce + 1);
      }
      
    } catch (error) {
      console.error('Failed to execute refinance:', error);
      alert(`Transaction failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Auto-calculate when inputs change
  useEffect(() => {
    if (connected && contract) {
      const timer = setTimeout(() => {
        if (activeTab === 'refinance') {
          calculateEstimates();
        } else if (activeTab === 'liquidation') {
          calculateLiquidationEstimates();
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [amount, selectedAsset, currentRate, newRate, debtToCover, targetUser, activeTab, connected, contract]);

  return (
    <div className="App">
      {/* Header */}
      <header className="app-header">
        <div className="header-content">
          <div className="logo">
            <div className="logo-icon">
              <Zap size={24} />
            </div>
            <div>
              <h1>Imani Flash Loans</h1>
              <p>Production DeFi Platform</p>
            </div>
          </div>
          
          {!connected ? (
            <button
              onClick={connectWallet}
              disabled={loading}
              className="connect-btn"
            >
              <Wallet size={16} />
              <span>{loading ? 'Connecting...' : 'Connect Wallet'}</span>
            </button>
          ) : (
            <div className="wallet-info">
              <div className="wallet-label">Connected</div>
              <div className="wallet-address">
                {account.slice(0, 6)}...{account.slice(-4)}
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="main-content">
        {!connected ? (
          <div className="connect-section">
            <Wallet size={64} className="connect-icon" />
            <h2>Connect Your Wallet</h2>
            <p>Connect to Sepolia testnet to start using flash loans</p>
            <button onClick={connectWallet} className="connect-btn primary">
              Connect Wallet
            </button>
          </div>
        ) : (
          <div className="dashboard">
            {/* Contract Status */}
            <div className="status-card">
              <h2>
                <CheckCircle size={20} className="text-green" />
                Contract Status
              </h2>
              <div className="status-grid">
                <div className="stat">
                  <div className="stat-label">Service Fee</div>
                  <div className="stat-value text-green">
                    {serviceFee ? `${serviceFee/100}%` : 'Loading...'}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-label">Your Nonce</div>
                  <div className="stat-value">{userNonce ?? 'Loading...'}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">Network</div>
                  <div className="stat-value text-blue">Sepolia</div>
                </div>
                <div className="stat">
                  <div className="stat-label">Contract</div>
                  <div className="stat-value">
                    <a 
                      href={`https://sepolia.etherscan.io/address/${CONTRACT_ADDRESS}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="contract-link"
                    >
                      Verified <ExternalLink size={16} />
                    </a>
                  </div>
                </div>
              </div>
            </div>

            {/* Main Interface */}
            <div className="interface-grid">
              {/* Strategy Tabs */}
              <div className="card">
                <div className="strategy-tabs">
                  <button 
                    className={`tab ${activeTab === 'refinance' ? 'active' : ''}`}
                    onClick={() => setActiveTab('refinance')}
                  >
                    <RefreshCw size={16} />
                    Refinance
                  </button>
                  <button 
                    className={`tab ${activeTab === 'liquidation' ? 'active' : ''}`}
                    onClick={() => setActiveTab('liquidation')}
                  >
                    <Zap size={16} />
                    Liquidation
                  </button>
                  <button 
                    className={`tab ${activeTab === 'rebalancer' ? 'active' : ''}`}
                    onClick={() => setActiveTab('rebalancer')}
                  >
                    <CheckCircle size={16} />
                    Rebalancer
                  </button>
                </div>

                {/* Refinance Strategy */}
                {activeTab === 'refinance' && (
                  <div className="strategy-content">
                    <h2>Debt Refinance Strategy</h2>
                    
                    <div className="form-group">
                      <label>Asset</label>
                      <select
                        value={selectedAsset}
                        onChange={(e) => setSelectedAsset(e.target.value)}
                        className="form-select"
                      >
                        {Object.entries(ASSETS).map(([symbol]) => (
                          <option key={symbol} value={symbol}>{symbol}</option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label>Debt Amount</label>
                      <div className="input-with-suffix">
                        <input
                          type="number"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          className="form-input"
                          placeholder="1000"
                        />
                        <span className="input-suffix">{selectedAsset}</span>
                      </div>
                    </div>

                    <div className="rate-inputs">
                      <div className="form-group">
                        <label>Current Rate (%)</label>
                        <input
                          type="number"
                          step="0.1"
                          value={currentRate}
                          onChange={(e) => setCurrentRate(e.target.value)}
                          className="form-input"
                        />
                      </div>
                      <div className="form-group">
                        <label>New Rate (%)</label>
                        <input
                          type="number"
                          step="0.1"
                          value={newRate}
                          onChange={(e) => setNewRate(e.target.value)}
                          className="form-input"
                        />
                      </div>
                    </div>

                    <div className="strategy-info">
                      <p><strong>💡 Strategy:</strong> Move debt to protocols with better rates</p>
                      <p><strong>💰 Revenue:</strong> 0.25% platform fee on transaction</p>
                      <p><strong>⚡ User Benefit:</strong> 0.5-2% annual interest savings</p>
                    </div>

                    <button
                      onClick={executeRefinance}
                      disabled={loading || !isProfitable}
                      className={`execute-btn ${isProfitable ? 'profitable' : 'not-profitable'}`}
                    >
                      <RefreshCw size={16} className={loading ? 'spinning' : ''} />
                      <span>
                        {loading ? 'Processing...' : 
                         !isProfitable ? 'Not Profitable' : 
                         'Execute Refinance'}
                      </span>
                    </button>
                  </div>
                )}

                {/* Liquidation Strategy */}
                {activeTab === 'liquidation' && (
                  <div className="strategy-content">
                    <h2>Liquidation Strategy</h2>
                    
                    <div className="form-group">
                      <label>Target User Address</label>
                      <input
                        type="text"
                        value={targetUser}
                        onChange={(e) => setTargetUser(e.target.value)}
                        className="form-input"
                        placeholder="0x..."
                      />
                    </div>

                    <div className="form-group">
                      <label>Debt to Cover</label>
                      <div className="input-with-suffix">
                        <input
                          type="number"
                          value={debtToCover}
                          onChange={(e) => setDebtToCover(e.target.value)}
                          className="form-input"
                          placeholder="5000"
                        />
                        <span className="input-suffix">{selectedAsset}</span>
                      </div>
                    </div>

                    <div className="form-group">
                      <label>Collateral Asset</label>
                      <select
                        value={collateralAsset}
                        onChange={(e) => setCollateralAsset(e.target.value)}
                        className="form-select"
                      >
                        {Object.entries(ASSETS).map(([symbol]) => (
                          <option key={symbol} value={symbol}>{symbol}</option>
                        ))}
                      </select>
                    </div>

                    <div className="strategy-info">
                      <p><strong>🎯 Strategy:</strong> Liquidate unhealthy positions for bonus</p>
                      <p><strong>💰 Revenue:</strong> 5-15% liquidation bonus + platform fee</p>
                      <p><strong>⚡ Profit:</strong> $500-$1,500 per liquidation typically</p>
                    </div>

                    <button
                      onClick={executeLiquidation}
                      disabled={loading}
                      className="execute-btn profitable"
                    >
                      <Zap size={16} className={loading ? 'spinning' : ''} />
                      <span>{loading ? 'Processing...' : 'Execute Liquidation'}</span>
                    </button>
                  </div>
                )}

                {/* Rebalancer Strategy */}
                {activeTab === 'rebalancer' && (
                  <div className="strategy-content">
                    <h2>LP Rebalancer Strategy</h2>
                    
                    <div className="form-group">
                      <label>LP Token Pair</label>
                      <select
                        value={lpToken}
                        onChange={(e) => setLpToken(e.target.value)}
                        className="form-select"
                      >
                        <option value="USDC/WETH">USDC/WETH</option>
                        <option value="USDC/DAI">USDC/DAI</option>
                        <option value="WETH/DAI">WETH/DAI</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label>Position Size</label>
                      <div className="input-with-suffix">
                        <input
                          type="number"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          className="form-input"
                          placeholder="10000"
                        />
                        <span className="input-suffix">USD</span>
                      </div>
                    </div>

                    <div className="rate-inputs">
                      <div className="form-group">
                        <label>Current Ratio</label>
                        <select
                          value={currentRatio}
                          onChange={(e) => setCurrentRatio(e.target.value)}
                          className="form-select"
                        >
                          <option value="60/40">60/40</option>
                          <option value="70/30">70/30</option>
                          <option value="40/60">40/60</option>
                        </select>
                      </div>
                      <div className="form-group">
                        <label>Target Ratio</label>
                        <select
                          value={targetRatio}
                          onChange={(e) => setTargetRatio(e.target.value)}
                          className="form-select"
                        >
                          <option value="50/50">50/50</option>
                          <option value="60/40">60/40</option>
                          <option value="40/60">40/60</option>
                        </select>
                      </div>
                    </div>

                    <div className="form-group">
                      <label>Rebalance Fee (%)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={rebalanceFee}
                        onChange={(e) => setRebalanceFee(e.target.value)}
                        className="form-input"
                        placeholder="0.1"
                      />
                    </div>

                    <div className="strategy-info">
                      <p><strong>⚖️ Strategy:</strong> Keep LP positions delta-neutral</p>
                      <p><strong>💰 Revenue:</strong> 0.05-0.2% rebalancing fee</p>
                      <p><strong>⚡ Market:</strong> Steady income from LP management</p>
                    </div>

                    <button
                      onClick={executeRebalance}
                      disabled={loading}
                      className="execute-btn profitable"
                    >
                      <CheckCircle size={16} className={loading ? 'spinning' : ''} />
                      <span>{loading ? 'Processing...' : 'Execute Rebalance'}</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Profit Calculation */}
              <div className="card">
                <h2>
                  <Calculator size={20} />
                  {activeTab === 'refinance' ? 'Annual Savings' : 
                   activeTab === 'liquidation' ? 'Liquidation Profit' : 
                   'Rebalancing Fees'}
                </h2>

                {activeTab === 'refinance' && (
                  <div className="profit-items">
                    <div className="profit-item">
                      <span>Flash Loan Fee</span>
                      <span className="text-red">
                        {flashLoanFee ? `-${parseFloat(flashLoanFee).toFixed(2)}` : 'Calculating...'}
                      </span>
                    </div>

                    <div className="profit-item">
                      <span>Annual Savings</span>
                      <span className="text-green">
                        {estimatedProfit ? `+${parseFloat(estimatedProfit).toFixed(2)}` : 'Calculating...'}
                      </span>
                    </div>

                    <div className="profit-item">
                      <span>Platform Fee (0.25%)</span>
                      <span className="text-yellow">
                        {estimatedProfit ? `-${(parseFloat(estimatedProfit) * 0.0025).toFixed(2)}` : 'Calculating...'}
                      </span>
                    </div>

                    <div className="profit-item total">
                      <span>Net Annual Benefit</span>
                      <span className="text-green">
                        {estimatedProfit && flashLoanFee ? 
                          `+${(parseFloat(estimatedProfit) - parseFloat(flashLoanFee) - (parseFloat(estimatedProfit) * 0.0025)).toFixed(2)}` : 
                          'Calculating...'
                        }
                      </span>
                    </div>

                    <div className={`status ${isProfitable ? 'profitable' : 'not-profitable'}`}>
                      {isProfitable ? (
                        <CheckCircle size={16} className="text-green" />
                      ) : (
                        <AlertTriangle size={16} className="text-red" />
                      )}
                      <span>
                        {isProfitable ? 'Transaction is profitable' : 'Transaction not profitable'}
                      </span>
                    </div>
                  </div>
                )}

                {activeTab === 'liquidation' && (
                  <div className="profit-items">
                    <div className="profit-item">
                      <span>Debt to Cover</span>
                      <span className="text-blue">
                        ${debtToCover} {selectedAsset}
                      </span>
                    </div>

                    <div className="profit-item">
                      <span>Liquidation Bonus (5%)</span>
                      <span className="text-green">
                        {liquidationBonus ? `+${liquidationBonus}` : 'Calculating...'}
                      </span>
                    </div>

                    <div className="profit-item">
                      <span>Flash Loan Fee</span>
                      <span className="text-red">
                        {flashLoanFee ? `-${parseFloat(flashLoanFee).toFixed(2)}` : 'Calculating...'}
                      </span>
                    </div>

                    <div className="profit-item">
                      <span>Platform Fee (0.25%)</span>
                      <span className="text-yellow">
                        {liquidationBonus ? `-${(parseFloat(liquidationBonus) * 0.0025).toFixed(2)}` : 'Calculating...'}
                      </span>
                    </div>

                    <div className="profit-item total">
                      <span>Net Liquidation Profit</span>
                      <span className="text-green">
                        {liquidationBonus && flashLoanFee ? 
                          `+${(parseFloat(liquidationBonus) - parseFloat(flashLoanFee) - (parseFloat(liquidationBonus) * 0.0025)).toFixed(2)}` : 
                          'Calculating...'
                        }
                      </span>
                    </div>

                    <div className="status profitable">
                      <CheckCircle size={16} className="text-green" />
                      <span>High profit potential - 5-15% bonus typical</span>
                    </div>
                  </div>
                )}

                {activeTab === 'rebalancer' && (
                  <div className="profit-items">
                    <div className="profit-item">
                      <span>Position Size</span>
                      <span className="text-blue">
                        ${amount} USD
                      </span>
                    </div>

                    <div className="profit-item">
                      <span>Rebalance Fee ({rebalanceFee}%)</span>
                      <span className="text-green">
                        +${(parseFloat(amount || 0) * parseFloat(rebalanceFee || 0) / 100).toFixed(2)}
                      </span>
                    </div>

                    <div className="profit-item">
                      <span>Flash Loan Fee</span>
                      <span className="text-red">
                        {flashLoanFee ? `-${parseFloat(flashLoanFee).toFixed(2)}` : '$0.50'}
                      </span>
                    </div>

                    <div className="profit-item">
                      <span>Platform Fee (0.25%)</span>
                      <span className="text-yellow">
                        -${((parseFloat(amount || 0) * parseFloat(rebalanceFee || 0) / 100) * 0.0025).toFixed(2)}
                      </span>
                    </div>

                    <div className="profit-item total">
                      <span>Net Rebalancing Profit</span>
                      <span className="text-green">
                        +${(
                          (parseFloat(amount || 0) * parseFloat(rebalanceFee || 0) / 100) - 
                          0.50 - 
                          ((parseFloat(amount || 0) * parseFloat(rebalanceFee || 0) / 100) * 0.0025)
                        ).toFixed(2)}
                      </span>
                    </div>

                    <div className="status profitable">
                      <CheckCircle size={16} className="text-green" />
                      <span>Steady income from LP management</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Instructions */}
            <div className="instructions">
              <h3>
                <AlertTriangle size={20} className="text-yellow" />
                Getting Started
              </h3>
              <div className="instruction-list">
                <div>1. <strong>Get test tokens:</strong> Visit <a href="https://staging.aave.com/faucet/" target="_blank" rel="noopener noreferrer">Aave Sepolia Faucet</a></div>
                <div>2. <strong>Create positions:</strong> Deposit collateral and borrow on Aave V3 Sepolia</div>
                <div>3. <strong>Find opportunities:</strong> Look for rate differences between positions</div>
                <div>4. <strong>Execute refinance:</strong> Use this interface to save on borrowing costs</div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;