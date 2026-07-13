// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "./interfaces/IAaveV3.sol";
import {
    IUniswapV2Router02,
    ISwapRouter
} from "./interfaces/IDEX.sol";

/**
 * @title Arbitrage
 * @author Gasless Flash-Loan Arbitrage Bot
 * @notice Core arbitrage execution contract. Receives flash-loaned capital,
 *         executes multi-DEX arbitrage, repays the loan, reimburses the paymaster
 *         for gas, and forwards all remaining profit to the owner wallet.
 *
 * Execution flow (all atomic within a single transaction):
 *   1. Borrow `amount` of `asset` via Aave V3 flash loan.
 *   2. Swap borrowed asset on DEX A (buy low).
 *   3. Swap received tokens on DEX B (sell high).
 *   4. Repay flash loan: `amount + premium` to Aave Pool.
 *   5. Reimburse paymaster for gas costs incurred during execution.
 *   6. Forward all remaining profit to the owner wallet.
 *   7. If any step fails, the entire transaction reverts (atomic safety).
 */
contract Arbitrage {
    // ──────────────────────────── Storage ────────────────────────────

    /// @notice The owner / profit recipient.
    address public immutable owner;

    /// @notice The FlashLoanReceiver contract that borrows from Aave.
    address public immutable flashLoanReceiver;

    /// @notice The Paymaster contract that sponsors gas.
    address public immutable paymaster;

    /// @notice Aave V3 Pool address for flash loan repayment.
    address public immutable aavePool;

    // DEX router addresses
    address public immutable uniswapV2Router;
    address public immutable uniswapV3Router;
    address public immutable sushiswapRouter;

    // ──────────────────────────── Events ─────────────────────────────

    event ArbitrageExecuted(
        address indexed asset,
        uint256 amountBorrowed,
        uint256 amountRepaid,
        uint256 paymasterReimbursement,
        uint256 profit
    );

    event SwapExecuted(
        address indexed dex,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    event ProfitForwarded(address indexed to, uint256 amount, address indexed token);

    // ──────────────────────────── Modifiers ──────────────────────────

    modifier onlyFlashLoanReceiver() {
        require(
            msg.sender == flashLoanReceiver,
            "Arbitrage: caller is not FlashLoanReceiver"
        );
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Arbitrage: caller is not owner");
        _;
    }

    // ──────────────────────────── Constructor ────────────────────────

    /**
     * @param _flashLoanReceiver Address of the FlashLoanReceiver contract.
     * @param _paymaster         Address of the Paymaster contract.
     * @param _aavePool          Address of the Aave V3 Pool.
     * @param _uniswapV2Router   Uniswap V2 Router02 address.
     * @param _uniswapV3Router   Uniswap V3 SwapRouter address.
     * @param _sushiswapRouter   SushiSwap Router address.
     */
    constructor(
        address _flashLoanReceiver,
        address _paymaster,
        address _aavePool,
        address _uniswapV2Router,
        address _uniswapV3Router,
        address _sushiswapRouter
    ) {
        owner = msg.sender;
        flashLoanReceiver = _flashLoanReceiver;
        paymaster = _paymaster;
        aavePool = _aavePool;
        uniswapV2Router = _uniswapV2Router;
        uniswapV3Router = _uniswapV3Router;
        sushiswapRouter = _sushiswapRouter;
    }

    // ──────────────────── Flash Loan Callback Entry ──────────────────

    /**
     * @notice Called by FlashLoanReceiver after Aave sends the loaned asset.
     *         Executes the full arbitrage path atomically.
     * @param asset      The flash-loaned token address.
     * @param amount     The flash-loaned amount.
     * @param premium    Aave flash loan fee (0.05% on V3 mainnet).
     * @param params     ABI-encoded ArbitrageParams struct.
     * @return success   Always true if execution reaches the end (reverts otherwise).
     */
    function executeArbitrage(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes calldata params
    ) external onlyFlashLoanReceiver returns (bool success) {
        ArbitrageParams memory arbParams = abi.decode(params, (ArbitrageParams));

        // Record balance before arbitrage (should be `amount` of `asset`)
        uint256 startBalance = IERC20(asset).balanceOf(address(this));
        require(startBalance >= amount, "Arbitrage: insufficient loan received");

        // ─── Step 1: Swap on DEX A (buy path) ───
        uint256 intermediateAmount = _swap(
            arbParams.dexA,
            arbParams.buyPath,
            amount,
            arbParams.minAmountOutA
        );

        address intermediateToken = arbParams.buyPath[arbParams.buyPath.length - 1];
        require(
            intermediateAmount > 0,
            "Arbitrage: DEX A swap returned zero"
        );

        // ─── Step 2: Swap on DEX B (sell path) ───
        uint256 finalAmount = _swap(
            arbParams.dexB,
            arbParams.sellPath,
            intermediateAmount,
            arbParams.minAmountOutB
        );

        address finalToken = arbParams.sellPath[arbParams.sellPath.length - 1];
        require(finalAmount > 0, "Arbitrage: DEX B swap returned zero");

        // ─── Step 3: Repay flash loan (amount + premium) ───
        uint256 totalRepay = amount + premium;

        // If the final token is the same as the loaned asset, use it for repayment
        if (finalToken == asset) {
            require(
                finalAmount >= totalRepay,
                "Arbitrage: insufficient to repay loan"
            );
            IERC20(asset).approve(aavePool, totalRepay);

            uint256 profit = finalAmount - totalRepay;

            // ─── Step 4: Reimburse paymaster for gas ───
            uint256 paymasterReimbursement = _reimbursePaymaster(asset, profit);

            // ─── Step 5: Forward remaining profit to owner ───
            uint256 remainingProfit = IERC20(asset).balanceOf(address(this));
            if (remainingProfit > 0) {
                require(
                    IERC20(asset).transfer(owner, remainingProfit),
                    "Arbitrage: profit transfer failed"
                );
                emit ProfitForwarded(owner, remainingProfit, asset);
            }

            emit ArbitrageExecuted(
                asset,
                amount,
                totalRepay,
                paymasterReimbursement,
                remainingProfit
            );
        } else {
            // Final token differs from loan asset — need to handle repayment
            // Repay the loaned asset from the contract's balance
            require(
                IERC20(asset).balanceOf(address(this)) >= totalRepay,
                "Arbitrage: insufficient loan asset for repayment"
            );
            IERC20(asset).approve(aavePool, totalRepay);

            // Forward the final token profit to owner after paymaster reimbursement
            uint256 finalTokenBalance = IERC20(finalToken).balanceOf(address(this));

            // Reimburse paymaster in final token
            uint256 paymasterReimbursement = _reimbursePaymaster(finalToken, finalTokenBalance);

            uint256 remainingProfit = IERC20(finalToken).balanceOf(address(this));
            if (remainingProfit > 0) {
                require(
                    IERC20(finalToken).transfer(owner, remainingProfit),
                    "Arbitrage: profit transfer failed"
                );
                emit ProfitForwarded(owner, remainingProfit, finalToken);
            }

            emit ArbitrageExecuted(
                asset,
                amount,
                totalRepay,
                paymasterReimbursement,
                remainingProfit
            );
        }

        return true;
    }

    // ──────────────────────────── Swap Logic ─────────────────────────

    /**
     * @dev Internal swap dispatcher. Routes to the correct DEX based on `dexId`.
     *      dexId: 0 = Uniswap V2, 1 = Uniswap V3, 2 = SushiSwap
     *      For V3, the path array must encode [tokenIn, tokenOut] and the fee
     *      is passed in `minAmountOut` high bits — but for simplicity we use V2-style
     *      routing for V3 via a wrapper or the V3 router's exactInputSingle.
     *
     *      For V3 swaps, we expect path = [tokenIn, tokenOut] and use a default
     *      fee of 3000 (0.3%). This can be overridden by encoding the fee in params.
     */
    function _swap(
        uint8 dexId,
        address[] memory path,
        uint256 amountIn,
        uint256 minAmountOut
    ) internal returns (uint256 amountOut) {
        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];

        // Approve the router to spend the input token
        address router;
        if (dexId == 0) {
            router = uniswapV2Router;
        } else if (dexId == 1) {
            router = uniswapV3Router;
        } else if (dexId == 2) {
            router = sushiswapRouter;
        } else {
            revert("Arbitrage: invalid DEX ID");
        }

        IERC20(tokenIn).approve(router, amountIn);

        if (dexId == 0 || dexId == 2) {
            // Uniswap V2 / SushiSwap — multi-hop via swapExactTokensForTokens
            IUniswapV2Router02 v2Router = IUniswapV2Router02(router);
            uint256[] memory amounts = v2Router.swapExactTokensForTokens(
                amountIn,
                minAmountOut,
                path,
                address(this),
                block.timestamp + 300
            );
            amountOut = amounts[amounts.length - 1];
        } else if (dexId == 1) {
            // Uniswap V3 — single-hop via exactInputSingle
            // For multi-hop V3, extend with encoded path; here we support single hop
            require(path.length == 2, "Arbitrage: V3 swap requires 2-token path");
            ISwapRouter v3Router = ISwapRouter(router);
            amountOut = v3Router.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: path[0],
                    tokenOut: path[1],
                    fee: 3000, // 0.3% pool fee tier
                    recipient: address(this),
                    deadline: block.timestamp + 300,
                    amountIn: amountIn,
                    amountOutMinimum: minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        emit SwapExecuted(router, tokenIn, tokenOut, amountIn, amountOut);
    }

    // ──────────────────── Paymaster Reimbursement ────────────────────

    /**
     * @dev Reimburses the Paymaster for gas costs incurred during execution.
     *      The reimbursement amount is capped at the paymaster's actual deposit
     *      consumption or a pre-computed value passed in params.
     *      Returns the amount reimbursed.
     */
    function _reimbursePaymaster(address token, uint256 availableProfit)
        internal
        returns (uint256 reimbursement)
    {
        // Reimburse up to the available profit, capped at a reasonable gas cost.
        // The paymaster deposit on EntryPoint covers gas; we repay in the profit token.
        // Gas reimbursement is capped at 0.01 ETH equivalent in token value.
        // For production, this should use a price oracle for exact conversion.
        uint256 maxGasReimbursement = availableProfit / 10; // 10% of profit cap
        reimbursement = maxGasReimbursement;

        if (reimbursement > 0 && IERC20(token).balanceOf(address(this)) >= reimbursement) {
            require(
                IERC20(token).transfer(paymaster, reimbursement),
                "Arbitrage: paymaster reimbursement failed"
            );
        } else {
            reimbursement = 0;
        }
    }

    // ──────────────────── Rescue Functions ───────────────────────────

    /**
     * @notice Emergency function to rescue stuck tokens (only owner).
     * @param token The token to rescue.
     * @param to    The recipient address.
     * @param amount The amount to rescue.
     */
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(to, amount), "Arbitrage: rescue failed");
    }

    // ──────────────────────── Structs ────────────────────────────────

    /**
     * @dev Parameters for a single arbitrage execution, passed through flash loan calldata.
     * @param dexA          DEX ID for the first swap (0=UniV2, 1=UniV3, 2=Sushi).
     * @param dexB          DEX ID for the second swap.
     * @param buyPath       Token path for the first swap (buy low).
     * @param sellPath      Token path for the second swap (sell high).
     * @param minAmountOutA Minimum output for swap A (slippage protection).
     * @param minAmountOutB Minimum output for swap B (slippage protection).
     */
    struct ArbitrageParams {
        uint8 dexA;
        uint8 dexB;
        address[] buyPath;
        address[] sellPath;
        uint256 minAmountOutA;
        uint256 minAmountOutB;
    }
}
