// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal Aave V3 interfaces we need
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

    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    );
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

/// @notice Minimal Uniswap V3 router interface
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

/**
 * @title FlashLoanManager
 * @notice Flash-loan executor for arbitrage, liquidations and refinancing, with simple external wrappers for CLI use.
 * @dev Non-upgradeable version for simplicity
 */
contract FlashLoanManager is
    IFlashLoanSimpleReceiver,
    ReentrancyGuard,
    Pausable,
    AccessControl
{
    using SafeERC20 for IERC20;

    // ===== Roles =====
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // ===== Core protocol refs =====
    IPoolAddressesProvider public ADDRESSES_PROVIDER;
    IPool public AAVE_POOL;
    ISwapRouter public uniswapV3Router;
    address public treasury;

    // ===== Config =====
    uint256 public serviceFeeBps = 200;                 // 2%
    uint256 public constant MAX_SERVICE_FEE = 500; // = 5%
    uint256 public constant BPS = 10_000;

    // ===== Simple collateral tracking =====
    mapping(address => mapping(address => uint256)) public userCollateral; // user => token => amount

    // ===== Strategies =====
    enum StrategyType { ARBITRAGE, LIQUIDATION, REFINANCE }

    struct FlashLoanParams {
        StrategyType strategy;
        address user;          // msg.sender who initiated
        bytes strategyData;    // encoded specific params
        uint256 expectedProfit;
        uint256 deadline;
    }

    // ===== Tracking =====
    mapping(address => uint256) public totalProfitsByAsset;
    mapping(StrategyType => uint256) public strategyProfits;
    mapping(address => bool) public authorizedCallers;

    // ===== Events =====
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

    event CollateralDeposited(address indexed user, address indexed token, uint256 amount);
    event CollateralWithdrawn(address indexed user, address indexed token, uint256 amount);

    // ===== Errors =====
    error InvalidAmount();
    error InvalidDeadline();
    error UnauthorizedCaller();
    error InsufficientProfit();
    error SwapFailed(string reason);
    error InsufficientCollateral();

    // ===== Modifiers =====
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

    // ===== Constructor =====
    constructor(
        address _addressesProvider,
        address _treasury,
        address _uniswapV3Router
    ) {
        require(_addressesProvider != address(0), "Invalid provider");
        require(_treasury != address(0), "Invalid treasury");

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OWNER_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);

        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressesProvider);
        AAVE_POOL = IPool(ADDRESSES_PROVIDER.getPool());
        treasury = _treasury;
        uniswapV3Router = ISwapRouter(_uniswapV3Router);

        authorizedCallers[msg.sender] = true;
    }

    // =====================================================
    //           SIMPLE COLLATERAL MANAGEMENT
    // =====================================================

    function depositCollateral(address token, uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        userCollateral[msg.sender][token] += amount;
        
        emit CollateralDeposited(msg.sender, token, amount);
    }

    function withdrawCollateral(address token, uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        if (userCollateral[msg.sender][token] < amount) revert InsufficientCollateral();
        
        userCollateral[msg.sender][token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        
        emit CollateralWithdrawn(msg.sender, token, amount);
    }

    // =====================================================
    //               FLASH LOAN CORE (generic)
    // =====================================================

    function executeFlashLoan(
        address asset,
        uint256 amount
    ) public nonReentrant whenNotPaused onlyAuthorized {
        if (amount == 0) revert InvalidAmount();

        FlashLoanParams memory p = FlashLoanParams({
            strategy: StrategyType.ARBITRAGE,
            user: msg.sender,
            strategyData: "",
            expectedProfit: 0,
            deadline: block.timestamp + 3600 // 1 hour default
        });

        AAVE_POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            abi.encode(p),
            0
        );
    }

    /// @dev Aave callback
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override onlyAavePool returns (bool) {
        require(initiator == address(this), "Bad initiator");

        FlashLoanParams memory p = abi.decode(params, (FlashLoanParams));
        
        uint256 totalOwed = amount + premium;

        // For basic flashloan, just ensure we can repay
        require(IERC20(asset).balanceOf(address(this)) >= totalOwed, "Insufficient to repay");

        // Approve repayment
        IERC20(asset).forceApprove(address(AAVE_POOL), totalOwed);

        emit FlashLoanExecuted(
            asset,
            amount,
            p.strategy,
            p.user,
            0, // profit
            0, // fee
            block.timestamp
        );

        return true;
    }

    // =====================================================
    //              CLI WRAPPER FUNCTIONS
    // =====================================================

    function executeArbitrage(
        address tokenIn,
        address tokenOut,
        uint256 amount
    ) external onlyAuthorized whenNotPaused {
        // Simple arbitrage logic using Uniswap
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amount);
        
        // Approve for Uniswap
        IERC20(tokenIn).forceApprove(address(uniswapV3Router), amount);
        
        // Execute swap
        uint256 amountOut = uniswapV3Router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: 3000, // 0.3%
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: amount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        
        // Transfer result back to user
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
        
        emit ArbitrageExecuted(tokenIn, tokenOut, amount, amountOut, 0, block.timestamp);
    }

    function executeLiquidation(
        address borrower,
        address debtAsset,
        address collateralAsset,
        uint256 debtAmount
    ) external onlyAuthorized whenNotPaused {
        // Check if borrower is liquidatable
        (, , , , , uint256 healthFactor) = AAVE_POOL.getUserAccountData(borrower);
        require(healthFactor < 1e18, "Target not liquidatable");

        // Transfer debt asset from caller
        IERC20(debtAsset).safeTransferFrom(msg.sender, address(this), debtAmount);
        
        // Approve for Aave
        IERC20(debtAsset).forceApprove(address(AAVE_POOL), debtAmount);
        
        // Execute liquidation
        AAVE_POOL.liquidationCall(
            collateralAsset,
            debtAsset,
            borrower,
            debtAmount,
            false // receive underlying asset, not aToken
        );
        
        // Transfer seized collateral to caller
        uint256 collateralBalance = IERC20(collateralAsset).balanceOf(address(this));
        if (collateralBalance > 0) {
            IERC20(collateralAsset).safeTransfer(msg.sender, collateralBalance);
        }
        
        emit LiquidationExecuted(borrower, collateralAsset, debtAsset, debtAmount, 0, block.timestamp);
    }

    function executeRefinance(
        address oldProtocol,
        address newProtocol,
        address debtAsset,
        uint256 amount
    ) external onlyAuthorized whenNotPaused {
        // Placeholder implementation - just log the event
        emit FlashLoanExecuted(debtAsset, amount, StrategyType.REFINANCE, msg.sender, 0, 0, block.timestamp);
    }

    // =====================================================
    //                     ADMIN
    // =====================================================

    function setServiceFee(uint256 _bps) external onlyRole(OWNER_ROLE) {
        require(_bps <= MAX_SERVICE_FEE, "Fee too high");
        serviceFeeBps = _bps;
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

    function emergencyWithdraw(address token, uint256 amount) external onlyRole(OWNER_ROLE) {
        IERC20(token).safeTransfer(treasury, amount);
    }

    // =====================================================
    //                      VIEWS
    // =====================================================

    function getContractBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function getTotalProfit(address asset) external view returns (uint256) {
        return totalProfitsByAsset[asset];
    }

    function getStrategyProfit(StrategyType strategy) external view returns (uint256) {
        return strategyProfits[strategy];
    }

    function getUserCollateral(address user, address token) external view returns (uint256) {
        return userCollateral[user][token];
    }

    // Accept ETH if needed for future integrations
    receive() external payable {}
}