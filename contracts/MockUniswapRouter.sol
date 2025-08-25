// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockUniswapRouter
 * @dev Minimal mock of Uniswap V3's ISwapRouter.exactInputSingle for testing.
 *      - Pulls tokenIn from msg.sender (so caller must approve this router).
 *      - Sends tokenOut from this contract's balance to the recipient.
 *      - Default rate is 1:1; you can set custom rates per (tokenIn, tokenOut) pair.
 */
contract MockUniswapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;                 // ignored in this mock, but kept for signature compatibility
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;  // ignored in this mock
    }

    // rate[tokenIn][tokenOut] = (numerator, denominator)
    struct Rate {
        uint256 num;
        uint256 den;
        bool set;
    }

    mapping(address => mapping(address => Rate)) public rates;

    /**
     * @notice Set a custom swap rate for a token pair.
     * @param tokenIn  Input token address
     * @param tokenOut Output token address
     * @param numerator   Numerator of the rate
     * @param denominator Denominator of the rate (must be > 0)
     *
     * amountOut = amountIn * numerator / denominator
     */
    function setRate(
        address tokenIn,
        address tokenOut,
        uint256 numerator,
        uint256 denominator
    ) external {
        require(denominator != 0, "den=0");
        rates[tokenIn][tokenOut] = Rate({ num: numerator, den: denominator, set: true });
    }

    /**
     * @notice Mocked exactInputSingle. Pulls tokenIn from caller and sends tokenOut from router.
     * @dev Caller must have approved this contract to spend `amountIn` of tokenIn.
     *      Router must hold enough tokenOut to cover the swap.
     */
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        require(params.recipient != address(0), "bad recipient");
        require(block.timestamp <= params.deadline, "deadline");

        // Pull tokenIn from the caller
        require(
            IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn),
            "pull in failed"
        );

        // Compute output using set rate or default 1:1
        Rate memory r = rates[params.tokenIn][params.tokenOut];
        if (r.set) {
            amountOut = (params.amountIn * r.num) / r.den;
        } else {
            amountOut = params.amountIn; // default 1:1
        }

        // Respect minimum output
        require(amountOut >= params.amountOutMinimum, "insufficient out");

        // Pay out tokenOut from router's balance
        require(
            IERC20(params.tokenOut).transfer(params.recipient, amountOut),
            "payout failed"
        );

        return amountOut;
    }

    // Helper to check this router's balance of a token (useful in tests)
    function balanceOf(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}
