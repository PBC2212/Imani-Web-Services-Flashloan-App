// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Aave V3 Interfaces
interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;

    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);

    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    );

    function getReserveData(address asset) external view returns (DataTypes.ReserveData memory);
    function getUserConfiguration(address user) external view returns (DataTypes.UserConfigurationMap memory);
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

// Uniswap V3 Interfaces
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

// Data types for Aave V3
library DataTypes {
    struct ReserveData {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    struct ReserveConfigurationMap {
        uint256 data;
    }

    struct UserConfigurationMap {
        uint256 data;
    }
}

/**
 * @title EnhancedFlashLoanManager - Production Ready Flash Loan Contract
 * @dev Advanced flash loan platform for arbitrage and liquidations
 * @notice Implements multi-DEX arbitrage and liquidation strategies
 */
contract EnhancedFlashLoanManager is
    Initializable,
    IFlashLoanSimpleReceiver,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    AccessControlUpgradeable
{
    using SafeERC20 for IERC20;

    // Role definitions
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // Core contracts
    IPoolAddressesProvider public ADDRESSES_PROVIDER;
    IPool public AAVE_POOL;
    ISwapRouter public uniswapV3Router;
    address public treasury;

    // Configuration
    uint256 public serviceFee = 200; // 2%
    uint256 public constant MAX_SERVICE_FEE = 500; // 5%
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MIN_PROFIT_THRESHOLD = 1e6; // $1 USDC

    // Strategy types
    enum StrategyType { 
        ARBITRAGE, 
        LIQUIDATION,
        REFINANCE
    }

    // Flash loan parameters
    struct FlashLoanParams {
        StrategyType strategy;
        address user;
        bytes strategyData;
        uint256 expectedProfit;
        uint256 deadline;
    }

    // Arbitrage parameters
    struct ArbitrageParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint256 minAmountOut;
        address recipient;
    }

    // Liquidation parameters
    struct LiquidationParams {
        address user;
        address collateralAsset;
        address debtAsset;
        uint256 debtToCover;
        bool receiveAToken;
        uint256 minProfitBps;
    }

    // Tracking
    mapping(address => uint256) public totalProfits;
    mapping(StrategyType => uint256) public strategyProfits;
    mapping(address => bool) public authorizedCallers;

    // Events
    event FlashLoanExecuted(
        address indexed asset,
        uint256 amount,
        StrategyType strategy,
        address indexed user,
        uint256 profit,
        uint256 serviceFeeCollected,
        uint256 timestamp
    );

    event ArbitrageExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 profit,
        uint256 timestamp
    );

    event LiquidationExecuted(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 debtCovered,
        uint256 profit,
        uint256 timestamp
    );

    // Errors
    error InvalidAmount();
    error InvalidDeadline();
    error UnauthorizedCaller();
    error InsufficientProfit();
    error FlashLoanFailed(string reason);
    error SwapFailed(string reason);

    // Modifiers
    modifier onlyAavePool() {
        if (msg.sender != address(AAVE_POOL)) revert UnauthorizedCaller();
        _;
    }

    modifier validDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert InvalidDeadline();
        _;
    }

    modifier onlyAuthorized() {
        if (!authorizedCallers[msg.sender] && !hasRole(OPERATOR_ROLE, msg.sender)) {
            revert UnauthorizedCaller();
        }
        _;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(OWNER_ROLE) {}

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _addressesProvider,
        address _treasury,
        address _uniswapV3Router,
        address _balancerVault // Keep parameter for compatibility but don't use
    ) public initializer {
        require(_addressesProvider != address(0), "Invalid addresses provider");
        require(_treasury != address(0), "Invalid treasury");

        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OWNER_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);

        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressesProvider);
        AAVE_POOL = IPool(ADDRESSES_PROVIDER.getPool());
        treasury = _treasury;
        uniswapV3Router = ISwapRouter(_uniswapV3Router);

        authorizedCallers[msg.sender] = true;
    }

    /**
     * @dev Execute flash loan with specified strategy
     */
    function executeFlashLoan(
        address asset,
        uint256 amount,
        StrategyType strategy,
        bytes calldata strategyData,
        uint256 expectedProfit,
        uint256 deadline
    ) external nonReentrant whenNotPaused onlyAuthorized validDeadline(deadline) {
        if (amount == 0) revert InvalidAmount();
        if (expectedProfit < MIN_PROFIT_THRESHOLD) revert InsufficientProfit();

        FlashLoanParams memory params = FlashLoanParams({
            strategy: strategy,
            user: msg.sender,
            strategyData: strategyData,
            expectedProfit: expectedProfit,
            deadline: deadline
        });

        bytes memory encodedParams = abi.encode(params);

        AAVE_POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            encodedParams,
            0
        );
    }

    /**
     * @dev Callback function called by Aave pool after flash loan is received
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override onlyAavePool returns (bool) {
        if (initiator != address(this)) revert UnauthorizedCaller();

        FlashLoanParams memory flashParams = abi.decode(params, (FlashLoanParams));
        
        uint256 profit = 0;
        
        if (flashParams.strategy == StrategyType.ARBITRAGE) {
            profit = _executeArbitrage(asset, amount, flashParams.strategyData);
        } else if (flashParams.strategy == StrategyType.LIQUIDATION) {
            profit = _executeLiquidation(asset, amount, flashParams.strategyData);
        } else if (flashParams.strategy == StrategyType.REFINANCE) {
            profit = _executeRefinance(asset, amount, flashParams.strategyData);
        }

        uint256 totalOwed = amount + premium;
        
        if (profit < flashParams.expectedProfit) {
            revert InsufficientProfit();
        }

        // Collect service fee
        uint256 serviceFeeAmount = (profit * serviceFee) / BASIS_POINTS;
        if (serviceFeeAmount > 0) {
            IERC20(asset).safeTransfer(treasury, serviceFeeAmount);
        }

        // Ensure we can repay the flash loan
        require(IERC20(asset).balanceOf(address(this)) >= totalOwed, "Insufficient balance to repay");

        // Approve repayment
        IERC20(asset).approve(address(AAVE_POOL), totalOwed);

        // Update tracking
        totalProfits[asset] += profit;
        strategyProfits[flashParams.strategy] += profit;

        emit FlashLoanExecuted(
            asset,
            amount,
            flashParams.strategy,
            flashParams.user,
            profit,
            serviceFeeAmount,
            block.timestamp
        );

        return true;
    }

    /**
     * @dev Execute arbitrage strategy
     */
    function _executeArbitrage(
        address asset,
        uint256 amount,
        bytes memory strategyData
    ) internal returns (uint256 profit) {
        ArbitrageParams memory params = abi.decode(strategyData, (ArbitrageParams));
        
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        
        // Approve token for swap
        IERC20(params.tokenIn).approve(address(uniswapV3Router), params.amountIn);
        
        // Execute swap
        try uniswapV3Router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                fee: params.fee,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: params.amountIn,
                amountOutMinimum: params.minAmountOut,
                sqrtPriceLimitX96: 0
            })
        ) returns (uint256 amountOut) {
            
            // If we swapped to a different token, swap back to original asset
            if (params.tokenOut != asset) {
                IERC20(params.tokenOut).approve(address(uniswapV3Router), amountOut);
                
                uniswapV3Router.exactInputSingle(
                    ISwapRouter.ExactInputSingleParams({
                        tokenIn: params.tokenOut,
                        tokenOut: asset,
                        fee: params.fee,
                        recipient: address(this),
                        deadline: block.timestamp + 300,
                        amountIn: amountOut,
                        amountOutMinimum: 0,
                        sqrtPriceLimitX96: 0
                    })
                );
            }
            
            uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
            profit = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
            
            emit ArbitrageExecuted(
                params.tokenIn,
                params.tokenOut,
                params.amountIn,
                amountOut,
                profit,
                block.timestamp
            );
            
        } catch {
            revert SwapFailed("Uniswap swap failed");
        }
    }

    /**
     * @dev Execute liquidation strategy
     */
    function _executeLiquidation(
        address asset,
        uint256 amount,
        bytes memory strategyData
    ) internal returns (uint256 profit) {
        LiquidationParams memory params = abi.decode(strategyData, (LiquidationParams));
        
        // Check if user is liquidatable
        (, , , , , uint256 healthFactor) = AAVE_POOL.getUserAccountData(params.user);
        require(healthFactor < 1e18, "User not liquidatable");
        
        uint256 balanceBefore = IERC20(params.collateralAsset).balanceOf(address(this));
        
        // Approve debt asset for liquidation
        IERC20(params.debtAsset).approve(address(AAVE_POOL), params.debtToCover);
        
        // Execute liquidation
        AAVE_POOL.liquidationCall(
            params.collateralAsset,
            params.debtAsset,
            params.user,
            params.debtToCover,
            params.receiveAToken
        );
        
        uint256 balanceAfter = IERC20(params.collateralAsset).balanceOf(address(this));
        uint256 collateralSeized = balanceAfter - balanceBefore;
        
        // Convert collateral to debt asset if needed
        if (params.collateralAsset != asset && collateralSeized > 0) {
            IERC20(params.collateralAsset).approve(address(uniswapV3Router), collateralSeized);
            
            uniswapV3Router.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: params.collateralAsset,
                    tokenOut: asset,
                    fee: 3000, // 0.3% fee
                    recipient: address(this),
                    deadline: block.timestamp + 300,
                    amountIn: collateralSeized,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        }
        
        uint256 finalBalance = IERC20(asset).balanceOf(address(this));
        profit = finalBalance > amount ? finalBalance - amount : 0;
        
        emit LiquidationExecuted(
            params.user,
            params.collateralAsset,
            params.debtAsset,
            params.debtToCover,
            profit,
            block.timestamp
        );
    }

    /**
     * @dev Execute refinance strategy (simplified)
     */
    function _executeRefinance(
        address asset,
        uint256 amount,
        bytes memory strategyData
    ) internal returns (uint256 profit) {
        // Simplified refinance logic
        // In practice, this would involve complex debt management
        profit = 0; // No profit from refinancing, just cost optimization
    }

    // Admin functions
    function setServiceFee(uint256 _serviceFee) external onlyRole(OWNER_ROLE) {
        require(_serviceFee <= MAX_SERVICE_FEE, "Fee too high");
        serviceFee = _serviceFee;
    }

    function setTreasury(address _treasury) external onlyRole(OWNER_ROLE) {
        require(_treasury != address(0), "Invalid treasury");
        treasury = _treasury;
    }

    function setAuthorizedCaller(address caller, bool authorized) external onlyRole(OWNER_ROLE) {
        authorizedCallers[caller] = authorized;
    }

    function pause() external onlyRole(OWNER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(OWNER_ROLE) {
        _unpause();
    }

    // Emergency function to withdraw tokens
    function emergencyWithdraw(address token, uint256 amount) external onlyRole(OWNER_ROLE) {
        IERC20(token).safeTransfer(treasury, amount);
    }

    // View functions
    function getContractBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function getTotalProfit(address asset) external view returns (uint256) {
        return totalProfits[asset];
    }

    function getStrategyProfit(StrategyType strategy) external view returns (uint256) {
        return strategyProfits[strategy];
    }

    // Allow contract to receive ETH
    receive() external payable {}
}