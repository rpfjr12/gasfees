// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IERC4337
 * @dev Minimal ERC-4337 (Account Abstraction) interfaces for Paymaster integration.
 *      Source: https://github.com/eth-infinitism/account-abstraction
 */

struct UserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    uint256 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPoint {
    function handleOps(UserOperation[] calldata ops, address beneficiary) external;

    function balanceOf(address account) external view returns (uint256);

    function depositTo(address account) external payable;

    function getSenderAddress(bytes memory initCode) external;

    function getUserOpHash(UserOperation calldata userOp) external view returns (bytes32);

    function simulateValidation(UserOperation calldata userOp)
        external
        returns (uint256 validationData);
}

interface IPaymaster {
    /**
     * @dev Called by the EntryPoint to validate a UserOperation.
     * @param userOp The UserOperation to validate.
     * @param userOpHash Hash of the UserOperation.
     * @param maxCost Maximum cost of the operation (gas * gasPrice).
     * @return context Arbitrary data passed to postOp.
     * @return validationData 0 = valid, 1 = invalid, >1 = validWithAggregation.
     */
    function validatePaymasterUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external returns (bytes memory context, uint256 validationData);

    /**
     * @dev Called by the EntryPoint after the UserOperation is executed.
     * @param mode 0 = postOp called once, 1 = postOp called twice (revert scenario).
     * @param context The context returned by validatePaymasterUserOp.
     * @param actualGasCost The actual gas cost of the operation.
     */
    function postOp(uint8 mode, bytes calldata context, uint256 actualGasCost) external;
}
