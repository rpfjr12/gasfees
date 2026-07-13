// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    IPool,
    IPoolAddressesProvider,
    IFlashLoanSimpleReceiver,
    IERC20
} from "./interfaces/IAaveV3.sol";
import {Arbitrage} from "./Arbitrage.sol";

/**
 * @title FlashLoanReceiver
 * @author Gasless Flash-Loan Arbitrage Bot
 * @notice Implements Aave V3's IFlashLoanSimpleReceiver interface.
 *         Borrows capital from Aave, delegates to Arbitrage contract for execution,
 *         and ensures atomic repayment.
 *
 * Lifecycle:
 *   1. Bot calls `requestFlashLoan()` with arbitrage parameters.
 *   2. Aave Pool sends `amount` of `asset` to this contract and calls `executeOperation()`.
 *   3. `executeOperation()` delegates to `Arbitrage.executeArbitrage()`.
 *   4. Arbitrage contract swaps on DEXes, repays the loan, sends profit to owner.
 *   5. If `executeOperation()` returns true, Aave verifies repayment and finalizes.
 *   6. If anything fails, the entire transaction reverts — no funds are lost.
 */
contract FlashLoanReceiver is IFlashLoanSimpleReceiver {
    // ──────────────────────────── Storage ────────────────────────────

    /// @notice Aave V3 Pool address.
    IPool public immutable pool;

    /// @notice Aave PoolAddressesProvider (used to fetch Pool at construction).
    address public immutable addressesProvider;

    /// @notice The Arbitrage logic contract.
    Arbitrage public immutable arbitrage;

    /// @notice The owner of this contract (who can initiate flash loans).
    address public immutable owner;

    // ──────────────────────────── Events ─────────────────────────────

    event FlashLoanRequested(
        address indexed asset,
        uint256 amount,
        address indexed initiator
    );

    event FlashLoanExecuted(
        address indexed asset,
        uint256 amount,
        uint256 premium,
        bool success
    );

    // ──────────────────────────── Modifiers ──────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "FlashLoanReceiver: caller is not owner");
        _;
    }

    modifier onlyPool() {
        require(msg.sender == address(pool), "FlashLoanReceiver: caller is not pool");
        _;
    }

    // ──────────────────────────── Constructor ────────────────────────

    /**
     * @param _addressesProvider Aave V3 PoolAddressesProvider address.
     * @param _arbitrage         Arbitrage contract address.
     */
    constructor(address _addressesProvider, address _arbitrage) {
        addressesProvider = _addressesProvider;
        pool = IPool(IPoolAddressesProvider(_addressesProvider).getPool());
        arbitrage = Arbitrage(_arbitrage);
        owner = msg.sender;
    }

    // ──────────────────────── Flash Loan Initiation ──────────────────

    /**
     * @notice Requests a flash loan from Aave V3. Callable only by the owner.
     * @param asset      The token to borrow.
     * @param amount     The amount to borrow.
     * @param params     ABI-encoded Arbitrage.ArbitrageParams struct.
     */
    function requestFlashLoan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        emit FlashLoanRequested(asset, amount, msg.sender);
        pool.flashLoanSimple(
            address(this), // receiver
            asset,
            amount,
            params,
            0 // referral code
        );
    }

    // ──────────────────── Aave Callback (Flash Loan) ─────────────────

    /**
     * @inheritdoc IFlashLoanSimpleReceiver
     * @dev Called by the Aave Pool after transferring the loaned asset.
     *      Delegates execution to the Arbitrage contract. Must ensure that
     *      `amount + premium` of `asset` is returned to the Pool before returning.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override onlyPool returns (bool) {
        require(initiator == address(this), "FlashLoanReceiver: bad initiator");

        // Delegate to Arbitrage contract for full execution
        // The Arbitrage contract will:
        //   - Swap on DEX A and DEX B
        //   - Repay the flash loan (amount + premium) to the Pool
        //   - Reimburse the paymaster
        //   - Send profit to owner
        bool success = arbitrage.executeArbitrage(asset, amount, premium, params);

        // Verify that the Pool has been repaid
        uint256 totalRepay = amount + premium;
        uint256 poolBalance = IERC20(asset).balanceOf(address(pool));
        require(
            poolBalance >= totalRepay,
            "FlashLoanReceiver: pool not repaid"
        );

        emit FlashLoanExecuted(asset, amount, premium, success);
        return true;
    }

    // ──────────────────── View / Admin Functions ─────────────────────

    /**
     * @notice Returns the Aave Pool address.
     */
    function getPoolAddress() external view returns (address) {
        return address(pool);
    }

    /**
     * @notice Emergency rescue of stuck tokens (only owner).
     * @param token  The token to rescue.
     * @param to     The recipient.
     * @param amount The amount to rescue.
     */
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(to, amount), "FlashLoanReceiver: rescue failed");
    }

    /**
     * @notice Allows the contract to receive ETH (for WETH unwrapping scenarios).
     */
    receive() external payable {}
}
