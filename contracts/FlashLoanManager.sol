// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// OZ Upgradeable building blocks
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

// ERC20 + safe wrappers (non-upgradeable module is correct for interfaces/libs)
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

/// @notice Aave datatypes (subset)
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
 * @title EnhancedFlashLoanManager
 * @notice Flash-loan executor for arbitrage, liquidations and refinancing, with simple external wrappers for CLI use.
 * @dev UUPS-upgradeable, role-gated, SafeERC20 everywhere.
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

    // ===== Roles =====
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // ===== Core protocol refs =====
    IPoolAddressesProvider public ADDRESSES_PROVIDER;
    IPool public AAVE_POOL;
    ISwapRouter public uniswapV3Router;
    address public treasury;

    // ===== Config =====
    uint256 public serviceFeeBps;                 // e.g. 200 = 2%
    uint256 public constant MAX_SERVICE_FEE = 500; // = 5%
    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_PROFIT_THRESHOLD = 1e6; // $1 if asset has 6 decimals (e.g. USDC)

    // ===== Strategies =====
    enum StrategyType { ARBITRAGE, LIQUIDATION, REFINANCE }

    struct FlashLoanParams {
        StrategyType strategy;
        address user;          // msg.sender who initiated
        bytes strategyData;    // encoded specific params
        uint256 expectedProfit;
        uint256 deadline;
    }

    struct ArbitrageParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24  fee;           // Uniswap V3 pool fee (e.g., 500, 3000, 10000)
        uint256 minAmountOut;
    }

    struct LiquidationParams {
        address user;              // target borrower
        address collateralAsset;
        address debtAsset;
        uint256 debtToCover;
        bool    receiveAToken;
        uint256 minProfitBps;      // guardrail, optional (not strictly used in this example)
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

    // ===== Errors =====
    error InvalidAmount();
    error InvalidDeadline();
    error UnauthorizedCaller();
    error InsufficientProfit();
    error SwapFailed(string reason);

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

    // ===== UUPS auth =====
    function _authorizeUpgrade(address) internal override onlyRole(OWNER_ROLE) {}

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ========== Init ==========
    function initialize(
        address _addressesProvider,
        address _treasury,
        address _uniswapV3Router,
        address /* _balancerVault (unused, kept for compatibility) */
    ) public initializer {
        require(_addressesProvider != address(0), "Invalid provider");
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
        serviceFeeBps = 200; // 2% default
    }

    // =====================================================
    //               FLASH LOAN CORE (generic)
    // =====================================================

    function executeFlashLoan(
        address asset,
        uint256 amount,
        StrategyType strategy,
        bytes calldata strategyData,
        uint256 expectedProfit,
        uint256 deadline
    ) public nonReentrant whenNotPaused onlyAuthorized validDeadline(deadline) {
        if (amount == 0) revert InvalidAmount();
        if (expectedProfit < MIN_PROFIT_THRESHOLD) revert InsufficientProfit();

        FlashLoanParams memory p = FlashLoanParams({
            strategy: strategy,
            user: msg.sender,
            strategyData: strategyData,
            expectedProfit: expectedProfit,
            deadline: deadline
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
        // deadline guard for operations that execute within callback
        if (block.timestamp > p.deadline) revert InvalidDeadline();

        uint256 profit = 0;

        if (p.strategy == StrategyType.ARBITRAGE) {
            profit = _executeArbitrage(asset, p.strategyData);
        } else if (p.strategy == StrategyType.LIQUIDATION) {
            profit = _executeLiquidation(asset, amount, p.strategyData);
        } else if (p.strategy == StrategyType.REFINANCE) {
            profit = _executeRefinance(asset, amount, p.strategyData);
        }

        uint256 totalOwed = amount + premium;

        if (profit < p.expectedProfit) revert InsufficientProfit();

        // Fee on profit
        uint256 feeAmt = (profit * serviceFeeBps) / BPS;
        if (feeAmt > 0) {
            IERC20(asset).safeTransfer(treasury, feeAmt);
        }

        // Must be able to repay
        require(IERC20(asset).balanceOf(address(this)) >= totalOwed, "Insufficient to repay");

        // Safe approve repayment: reset -> set
        IERC20 token = IERC20(asset);
        token.safeApprove(address(AAVE_POOL), 0);
        token.safeApprove(address(AAVE_POOL), totalOwed);

        // Accounting
        totalProfitsByAsset[asset] += profit;
        strategyProfits[p.strategy] += profit;

        emit FlashLoanExecuted(
            asset,
            amount,
            p.strategy,
            p.user,
            profit,
            feeAmt,
            block.timestamp
        );

        return true;
    }

    // =====================================================
    //                   STRATEGY INTERNALS
    // =====================================================

    function _executeArbitrage(
        address asset,
        bytes memory strategyData
    ) internal returns (uint256 profit) {
        ArbitrageParams memory ap = abi.decode(strategyData, (ArbitrageParams));

        uint256 beforeBal = IERC20(asset).balanceOf(address(this));

        // Approve tokenIn to router
        IERC20(ap.tokenIn).safeApprove(address(uniswapV3Router), 0);
        IERC20(ap.tokenIn).safeApprove(address(uniswapV3Router), ap.amountIn);

        uint256 amountOut;
        try uniswapV3Router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: ap.tokenIn,
                tokenOut: ap.tokenOut,
                fee: ap.fee,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: ap.amountIn,
                amountOutMinimum: ap.minAmountOut,
                sqrtPriceLimitX96: 0
            })
        ) returns (uint256 out) {
            amountOut = out;
        } catch {
            revert SwapFailed("Uniswap swap tokenIn->tokenOut failed");
        }

        // If tokenOut is not the flash asset, swap back to `asset`
        if (ap.tokenOut != asset) {
            IERC20(ap.tokenOut).safeApprove(address(uniswapV3Router), 0);
            IERC20(ap.tokenOut).safeApprove(address(uniswapV3Router), amountOut);

            try uniswapV3Router.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: ap.tokenOut,
                    tokenOut: asset,
                    fee: ap.fee,
                    recipient: address(this),
                    deadline: block.timestamp + 300,
                    amountIn: amountOut,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            ) returns (uint256 /*backOut*/) {
                // no-op
            } catch {
                revert SwapFailed("Uniswap swap tokenOut->asset failed");
            }
        }

        uint256 afterBal = IERC20(asset).balanceOf(address(this));
        profit = afterBal > beforeBal ? afterBal - beforeBal : 0;

        emit ArbitrageExecuted(ap.tokenIn, ap.tokenOut, ap.amountIn, amountOut, profit, block.timestamp);
    }

    function _executeLiquidation(
        address asset,
        uint256 amountBorrowed,
        bytes memory strategyData
    ) internal returns (uint256 profit) {
        LiquidationParams memory lp = abi.decode(strategyData, (LiquidationParams));

        // Target must be liquidatable
        (, , , , , uint256 healthFactor) = AAVE_POOL.getUserAccountData(lp.user);
        require(healthFactor < 1e18, "Target not liquidatable");

        uint256 beforeColl = IERC20(lp.collateralAsset).balanceOf(address(this));

        // Approve debt to Aave for liquidation
        IERC20(lp.debtAsset).safeApprove(address(AAVE_POOL), 0);
        IERC20(lp.debtAsset).safeApprove(address(AAVE_POOL), lp.debtToCover);

        // Perform liquidation
        AAVE_POOL.liquidationCall(
            lp.collateralAsset,
            lp.debtAsset,
            lp.user,
            lp.debtToCover,
            lp.receiveAToken
        );

        uint256 afterColl = IERC20(lp.collateralAsset).balanceOf(address(this));
        uint256 seized = afterColl - beforeColl;

        // Convert collateral to `asset` if needed
        if (lp.collateralAsset != asset && seized > 0) {
            IERC20(lp.collateralAsset).safeApprove(address(uniswapV3Router), 0);
            IERC20(lp.collateralAsset).safeApprove(address(uniswapV3Router), seized);

            // Use a default 0.3% fee tier; customize as needed
            uniswapV3Router.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: lp.collateralAsset,
                    tokenOut: asset,
                    fee: 3000,
                    recipient: address(this),
                    deadline: block.timestamp + 300,
                    amountIn: seized,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        uint256 finalAssetBal = IERC20(asset).balanceOf(address(this));
        profit = finalAssetBal > amountBorrowed ? finalAssetBal - amountBorrowed : 0;

        emit LiquidationExecuted(lp.user, lp.collateralAsset, lp.debtAsset, lp.debtToCover, profit, block.timestamp);
    }

    function _executeRefinance(
        address /*asset*/,
        uint256 /*amountBorrowed*/,
        bytes memory /*strategyData*/
    ) internal pure returns (uint256 profit) {
        // Placeholder: real refinance logic depends on target protocols
        // Keep 0 profit; this path is mainly a workflow hook.
        profit = 0;
    }

    // =====================================================
    //      SIMPLE WRAPPERS (for CLI ease-of-use)
    // =====================================================

    /**
     * @notice One-call arbitrage via flash loan
     * @dev Encodes ArbitrageParams and calls executeFlashLoan with StrategyType.ARBITRAGE
     * @param flashAsset The asset to borrow from Aave (e.g., USDC)
     * @param flashAmount Amount to borrow
     * @param tokenIn Token to sell first
     * @param tokenOut Token to receive on first swap
     * @param fee Uniswap V3 fee tier (e.g. 500/3000/10000)
     * @param minAmountOut Minimum out on first swap (slippage guard)
     * @param expectedProfit Expected net profit (in flashAsset units)
     * @param deadline Unix timestamp deadline for the whole operation
     */
    function arbitrageFlashloan(
        address flashAsset,
        uint256 flashAmount,
        address tokenIn,
        address tokenOut,
        uint24  fee,
        uint256 minAmountOut,
        uint256 expectedProfit,
        uint256 deadline
    ) external onlyAuthorized whenNotPaused {
        bytes memory data = abi.encode(
            ArbitrageParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: flashAmount, // typically you trade the borrowed amount
                fee: fee,
                minAmountOut: minAmountOut
            })
        );

        executeFlashLoan(
            flashAsset,
            flashAmount,
            StrategyType.ARBITRAGE,
            data,
            expectedProfit,
            deadline
        );
    }

    /**
     * @notice One-call liquidation via flash loan
     */
    function liquidateFlashloan(
        address flashAsset,
        uint256 flashAmount,
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 debtToCover,
        bool    receiveAToken,
        uint256 minProfitBps,
        uint256 expectedProfit,
        uint256 deadline
    ) external onlyAuthorized whenNotPaused {
        bytes memory data = abi.encode(
            LiquidationParams({
                user: targetUser,
                collateralAsset: collateralAsset,
                debtAsset: debtAsset,
                debtToCover: debtToCover,
                receiveAToken: receiveAToken,
                minProfitBps: minProfitBps
            })
        );

        executeFlashLoan(
            flashAsset,
            flashAmount,
            StrategyType.LIQUIDATION,
            data,
            expectedProfit,
            deadline
        );
    }

    /**
     * @notice One-call refinance via flash loan (placeholder)
     * @dev Put your refinance data into `strategyData` off-chain and pass it here for maximum flexibility.
     */
    function refinanceFlashloan(
        address flashAsset,
        uint256 flashAmount,
        bytes calldata strategyData,
        uint256 expectedProfit,
        uint256 deadline
    ) external onlyAuthorized whenNotPaused {
        executeFlashLoan(
            flashAsset,
            flashAmount,
            StrategyType.REFINANCE,
            strategyData,
            expectedProfit,
            deadline
        );
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

    // Accept ETH if needed for future integrations
    receive() external payable {}
}
