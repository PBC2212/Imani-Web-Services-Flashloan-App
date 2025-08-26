// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IFlashLoanSimpleReceiver.sol";

contract MockAavePool {
    address public constant ADDRESSES_PROVIDER = address(0x123);
    uint256 private healthFactor = 0;
    uint256 private liquidationResult = 0;

    function getPool() external view returns (address) {
        return address(this);
    }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 /* referralCode */
    ) external {
        IFlashLoanSimpleReceiver(receiverAddress).executeOperation(
            asset,
            amount,
            0, // premium
            address(this),
            params
        );
    }

    function liquidationCall(
        address /* collateralAsset */,
        address /* debtAsset */,
        address /* user */,
        uint256 /* debtToCover */,
        bool /* receiveAToken */
    ) external view returns (uint256) {
        return liquidationResult;
    }

    function getUserAccountData(address /* user */) external view returns (
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256
    ) {
        return (0, 0, 0, 0, 0, healthFactor);
    }

    function setHealthFactor(uint256 _healthFactor) external {
        healthFactor = _healthFactor;
    }

    function setLiquidationResult(uint256 _result) external {
        liquidationResult = _result;
    }
}