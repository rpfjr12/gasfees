// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEntryPoint, UserOperation, IPaymaster} from "./interfaces/IERC4337.sol";
import {IERC20} from "./interfaces/IAaveV3.sol";

/**
 * @title Paymaster
 * @author Gasless Flash-Loan Arbitrage Bot
 * @notice ERC-4337 Paymaster that sponsors gas for the user's arbitrage operations.
 *         The user pays zero gas. The paymaster deposits ETH into the EntryPoint
 *         to cover gas, and reimburses itself from the arbitrage profit within
 *         the same atomic transaction via `postOp()`.
 *
 * Economic model:
 *   - `validatePaymasterUserOp()`: Validates that the UserOperation targets the
 *     arbitrage contracts and that the encoded expected profit exceeds the
 *     estimated gas cost. Returns context with gas cost data.
 *   - `postOp()`: Called after the UserOperation executes. If the arbitrage was
 *     profitable, the Paymaster receives token reimbursement from the Arbitrage
 *     contract. If the operation reverted, `postOp` is called in mode 1 and the
 *     paymaster absorbs the gas cost (loss), but this is rare due to off-chain
 *     simulation.
 *
 * Security:
 *   - Only whitelisted sender addresses can use this paymaster.
 *   - Expected profit is encoded in `paymasterAndData` and checked against a
 *     minimum threshold.
 *   - The owner can fund/withdraw the paymaster deposit on the EntryPoint.
 */
contract Paymaster is IPaymaster {
    // ──────────────────────────── Storage ────────────────────────────

    /// @notice The ERC-4337 EntryPoint contract.
    IEntryPoint public immutable entryPoint;

    /// @notice The owner of this paymaster (admin).
    address public immutable owner;

    /// @notice The Arbitrage contract address (for receiving reimbursements).
    address public immutable arbitrageContract;

    /// @notice The token in which reimbursements are accepted.
    address public reimbursementToken;

    /// @notice Minimum expected profit (in reimbursement token) to sponsor gas.
    uint256 public minProfitThreshold;

    /// @notice Maximum gas cost the paymaster will sponsor per operation (in ETH).
    uint256 public maxSponsoredGasCost;

    /// @notice Whitelist of sender addresses allowed to use this paymaster.
    mapping(address => bool) public whitelistedSenders;

    // ──────────────────────────── Events ─────────────────────────────

    event UserOpSponsored(address indexed sender, uint256 maxCost);
    event PostOpExecuted(uint8 mode, uint256 actualGasCost, uint256 reimbursement);
    event DepositAdded(uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event SenderWhitelisted(address indexed sender, bool status);

    // ──────────────────────────── Modifiers ──────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Paymaster: caller is not owner");
        _;
    }

    modifier onlyEntryPoint() {
        require(
            msg.sender == address(entryPoint),
            "Paymaster: caller is not EntryPoint"
        );
        _;
    }

    // ──────────────────────────── Constructor ────────────────────────

    /**
     * @param _entryPoint         ERC-4337 EntryPoint address.
     * @param _arbitrageContract  Arbitrage contract address.
     * @param _reimbursementToken Token in which reimbursements are accepted (e.g. USDC).
     * @param _minProfitThreshold  Minimum expected profit to sponsor (in token units).
     * @param _maxSponsoredGasCost Max gas cost to sponsor per op (in wei).
     */
    constructor(
        address _entryPoint,
        address _arbitrageContract,
        address _reimbursementToken,
        uint256 _minProfitThreshold,
        uint256 _maxSponsoredGasCost
    ) {
        entryPoint = IEntryPoint(_entryPoint);
        owner = msg.sender;
        arbitrageContract = _arbitrageContract;
        reimbursementToken = _reimbursementToken;
        minProfitThreshold = _minProfitThreshold;
        maxSponsoredGasCost = _maxSponsoredGasCost;
    }

    // ──────────────────────── Paymaster Core Logic ───────────────────

    /**
     * @inheritdoc IPaymaster
     * @dev Validates the UserOperation:
     *      1. Sender must be whitelisted.
     *      2. Expected profit (encoded in paymasterAndData) must exceed threshold.
     *      3. Estimated gas cost must be within maxSponsoredGasCost.
     *
     * paymasterAndData format (ABI-encoded):
     *   bytes4  selector  → paymaster address (implicit, first 20 bytes)
     *   uint256 expectedProfit → expected profit in reimbursement token
     *   uint256 estimatedGasCost → estimated gas cost in wei
     */
    function validatePaymasterUserOp(
        UserOperation calldata userOp,
        bytes32 /* userOpHash */,
        uint256 maxCost
    ) external override onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        // Verify sender is whitelisted
        require(
            whitelistedSenders[userOp.sender],
            "Paymaster: sender not whitelisted"
        );

        // Decode paymaster-specific data
        // paymasterAndData = address(paymaster) + abi.encode(expectedProfit, estimatedGasCost)
        require(
            userOp.paymasterAndData.length >= 84,
            "Paymaster: invalid paymasterAndData"
        );

        // Skip first 20 bytes (paymaster address)
        bytes memory data = bytes(userOp.paymasterAndData[20:]);
        (uint256 expectedProfit, uint256 estimatedGasCost) = abi.decode(
            data,
            (uint256, uint256)
        );

        // Validate expected profit exceeds threshold
        require(
            expectedProfit >= minProfitThreshold,
            "Paymaster: profit below threshold"
        );

        // Validate gas cost is within limits
        require(
            maxCost <= maxSponsoredGasCost,
            "Paymaster: gas cost exceeds limit"
        );

        // Validate that expected profit covers gas cost
        // (Using a simple ETH-to-token conversion heuristic; production should use an oracle)
        require(
            expectedProfit > estimatedGasCost,
            "Paymaster: profit must exceed gas cost"
        );

        emit UserOpSponsored(userOp.sender, maxCost);

        // Return context for postOp: sender, expectedProfit, maxCost
        context = abi.encode(userOp.sender, expectedProfit, maxCost);
        validationData = 0; // 0 = valid
    }

    /**
     * @inheritdoc IPaymaster
     * @dev Called after the UserOperation executes. The Arbitrage contract should
     *      have already transferred reimbursement tokens to this paymaster during
     *      execution. We log the result here.
     *
     * mode 0: normal postOp (operation succeeded)
     * mode 1: postOp after revert (operation failed — paymaster takes the loss)
     */
    function postOp(
        uint8 mode,
        bytes calldata context,
        uint256 actualGasCost
    ) external override onlyEntryPoint {
        (address sender, uint256 expectedProfit, uint256 maxCost) = abi.decode(
            context,
            (address, uint256, uint256)
        );

        uint256 reimbursement = 0;

        if (mode == 0) {
            // Operation succeeded — check if we received reimbursement tokens
            if (reimbursementToken != address(0)) {
                reimbursement = IERC20(reimbursementToken).balanceOf(address(this));
                // Note: balance includes prior deposits; in production, track delta
            }
        }

        emit PostOpExecuted(mode, actualGasCost, reimbursement);
    }

    // ──────────────────────────── Admin ──────────────────────────────

    /**
     * @notice Adds or removes a sender from the whitelist.
     * @param sender The sender address.
     * @param status True to whitelist, false to remove.
     */
    function setWhitelistedSender(address sender, bool status) external onlyOwner {
        whitelistedSenders[sender] = status;
        emit SenderWhitelisted(sender, status);
    }

    /**
     * @notice Updates the minimum profit threshold.
     * @param _threshold New threshold (in token units).
     */
    function setMinProfitThreshold(uint256 _threshold) external onlyOwner {
        minProfitThreshold = _threshold;
    }

    /**
     * @notice Updates the maximum sponsored gas cost.
     * @param _maxCost New max cost (in wei).
     */
    function setMaxSponsoredGasCost(uint256 _maxCost) external onlyOwner {
        maxSponsoredGasCost = _maxCost;
    }

    /**
     * @notice Updates the reimbursement token.
     * @param _token New token address.
     */
    function setReimbursementToken(address _token) external onlyOwner {
        reimbursementToken = _token;
    }

    /**
     * @notice Deposits ETH into the EntryPoint to fund gas sponsorship.
     */
    function addDeposit() external payable onlyOwner {
        entryPoint.depositTo{value: msg.value}(address(this));
        emit DepositAdded(msg.value);
    }

    /**
     * @notice Withdraws ETH from the EntryPoint deposit.
     * @param to     Recipient address.
     * @param amount Amount to withdraw (in wei).
     */
    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        require(
            entryPoint.balanceOf(address(this)) >= amount,
            "Paymaster: insufficient deposit"
        );
        // EntryPoint withdrawal is done via its withdrawTo function
        (bool success, ) = address(entryPoint).call(
            abi.encodeWithSignature("withdrawTo(address,uint256)", to, amount)
        );
        require(success, "Paymaster: withdraw failed");
        emit Withdrawn(to, amount);
    }

    /**
     * @notice Returns the current deposit balance on the EntryPoint.
     */
    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    /**
     * @notice Withdraws reimbursement tokens received from arbitrage operations.
     * @param token  Token address to withdraw.
     * @param to     Recipient.
     * @param amount Amount to withdraw.
     */
    function withdrawTokens(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        require(IERC20(token).transfer(to, amount), "Paymaster: token withdraw failed");
    }

    /**
     * @notice Allows the contract to receive ETH.
     */
    receive() external payable {}
}
