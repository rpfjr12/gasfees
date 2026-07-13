/**
 * simulator.js
 * Gasless Flash-Loan Arbitrage Bot — Off-Chain Simulator
 *
 * Simulates the full arbitrage transaction off-chain using eth_call to
 * verify that the trade will be profitable before submitting on-chain.
 * Computes:
 *   - Expected output from each DEX swap
 *   - Aave flash loan premium (0.05%)
 *   - Estimated gas cost
 *   - Paymaster reimbursement
 *   - Net profit
 *
 * Returns a go/no-go decision.
 *
 * Dependencies: ethers v6
 */

const { ethers } = require("ethers");
const settings = require("../config/settings.json");

// ──────────────────────── ABIs ────────────────────────

const FLASH_LOAN_RECEIVER_ABI = [
    "function requestFlashLoan(address asset, uint256 amount, bytes params) external",
];

const UNISWAP_V2_ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
];

const UNISWAP_V3_QUOTER_ABI = [
    "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut)",
];

const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
];

// ──────────────────────── Constants ────────────────────────

const AAVE_FLASH_LOAN_PREMIUM_BPS = 5; // 0.05%
const V3_FEE_TIERS = [500, 3000, 10000];

// ──────────────────────── Simulator Class ────────────────────────

class Simulator {
    constructor(rpcUrl) {
        this.provider = new ethers.JsonRpcProvider(rpcUrl || settings.rpcUrl);
        this.dexAddresses = settings.dexAddresses;
        this.gasEstimateLimit = settings.gasEstimateLimit || 3000000;
        this.gasPriceBufferBps = settings.gasPriceBufferBps || 1100; // 10% buffer
        this.paymasterReimbursementBps = settings.paymasterReimbursementBps || 1000; // 10% of profit
    }

    /**
     * Simulate a complete arbitrage opportunity.
     * @param {Object} opportunity - Opportunity from scanner.js
     * @returns {Object} Simulation result with go/no-go decision.
     */
    async simulate(opportunity) {
        console.log(`[Simulator] Simulating opportunity: ${opportunity.pair.label}`);

        const { pair, buyDex, sellDex, tradeSize } = opportunity;

        try {
            // ─── Step 1: Simulate Swap A (buy) ───
            const swapAResult = await this.simulateSwap(
                buyDex.dexId,
                pair.tokenA,
                pair.tokenB,
                BigInt(tradeSize)
            );

            if (!swapAResult.success) {
                return this.reject("Swap A simulation failed", swapAResult.error);
            }

            console.log(`[Simulator] Swap A: ${tradeSize} ${pair.tokenA} → ${swapAResult.amountOut} ${pair.tokenB}`);

            // ─── Step 2: Simulate Swap B (sell) ───
            const swapBResult = await this.simulateSwap(
                sellDex.dexId,
                pair.tokenB,
                pair.tokenA,
                swapAResult.amountOut
            );

            if (!swapBResult.success) {
                return this.reject("Swap B simulation failed", swapBResult.error);
            }

            console.log(`[Simulator] Swap B: ${swapAResult.amountOut} ${pair.tokenB} → ${swapBResult.amountOut} ${pair.tokenA}`);

            // ─── Step 3: Compute costs ───
            const flashLoanAmount = BigInt(tradeSize);
            const flashLoanPremium = (flashLoanAmount * BigInt(AAVE_FLASH_LOAN_PREMIUM_BPS)) / 10000n;
            const totalRepay = flashLoanAmount + flashLoanPremium;

            // ─── Step 4: Compute profit ───
            const finalAmount = swapBResult.amountOut;
            const grossProfit = finalAmount > totalRepay
                ? finalAmount - totalRepay
                : 0n;

            if (grossProfit === 0n) {
                return this.reject("No gross profit — trade is not profitable");
            }

            // ─── Step 5: Estimate gas cost ───
            const gasEstimate = await this.estimateGas(opportunity);
            const gasPrice = await this.provider.getFeeData();
            const gasCost = this.computeGasCost(gasEstimate, gasPrice);

            // ─── Step 6: Compute paymaster reimbursement ───
            const paymasterReimbursement =
                (grossProfit * BigInt(this.paymasterReimbursementBps)) / 10000n;

            // ─── Step 7: Compute net profit ───
            const netProfit = grossProfit - paymasterReimbursement;

            // Note: Gas is paid by paymaster, not deducted from profit.
            // Paymaster is reimbursed from profit. Net profit goes to owner.
            // We verify that net profit is positive after all costs.
            const gasCostInToken = await this.convertGasCostToToken(gasCost, pair.tokenA);

            const profitAfterAllCosts = netProfit - gasCostInToken;

            // ─── Step 8: Decision ───
            const minNetProfit = ethers.parseUnits(
                settings.minNetProfitUsd || "2",
                pair.decimalsA || 18
            );

            const shouldExecute = profitAfterAllCosts > minNetProfit;

            const result = {
                shouldExecute,
                opportunity,
                flashLoanAmount: flashLoanAmount.toString(),
                flashLoanPremium: flashLoanPremium.toString(),
                totalRepay: totalRepay.toString(),
                swapAOutput: swapAResult.amountOut.toString(),
                swapBOutput: swapBResult.amountOut.toString(),
                grossProfit: grossProfit.toString(),
                gasEstimate: gasEstimate.toString(),
                gasCostWei: gasCost.toString(),
                gasCostInToken: gasCostInToken.toString(),
                paymasterReimbursement: paymasterReimbursement.toString(),
                netProfit: netProfit.toString(),
                profitAfterAllCosts: profitAfterAllCosts.toString(),
                profitable: profitAfterAllCosts > 0n,
                timestamp: Date.now(),
            };

            if (shouldExecute) {
                console.log(`[Simulator] ✅ PROFITABLE — Net profit: ${ethers.formatEther(profitAfterAllCosts)} units`);
            } else {
                console.log(`[Simulator] ❌ NOT PROFITABLE — Net profit: ${ethers.formatEther(profitAfterAllCosts)} units (below threshold)`);
            }

            return result;
        } catch (err) {
            return this.reject("Simulation error", err.message);
        }
    }

    /**
     * Simulate a swap on a given DEX.
     * @param {number} dexId - 0=UniV2, 1=UniV3, 2=Sushi
     * @param {string} tokenIn - Input token address
     * @param {string} tokenOut - Output token address
     * @param {bigint} amountIn - Input amount
     * @returns {Object} { success, amountOut, error }
     */
    async simulateSwap(dexId, tokenIn, tokenOut, amountIn) {
        try {
            if (dexId === 0 || dexId === 2) {
                // Uniswap V2 / SushiSwap
                const routerAddress = dexId === 0
                    ? this.dexAddresses.uniswapV2Router
                    : this.dexAddresses.sushiswapRouter;

                const router = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, this.provider);
                const path = [tokenIn, tokenOut];
                const amounts = await router.getAmountsOut(amountIn, path);
                return { success: true, amountOut: amounts[1] };
            } else if (dexId === 1) {
                // Uniswap V3 — try all fee tiers, pick best
                const quoter = new ethers.Contract(
                    this.dexAddresses.uniswapV3Quoter,
                    UNISWAP_V3_QUOTER_ABI,
                    this.provider
                );

                let bestAmountOut = 0n;
                for (const fee of V3_FEE_TIERS) {
                    try {
                        const amountOut = await quoter.quoteExactInputSingle.staticCall(
                            tokenIn,
                            tokenOut,
                            fee,
                            amountIn,
                            0
                        );
                        if (amountOut > bestAmountOut) {
                            bestAmountOut = amountOut;
                        }
                    } catch (e) {
                        // Try next fee tier
                    }
                }

                if (bestAmountOut > 0n) {
                    return { success: true, amountOut: bestAmountOut };
                }
                return { success: false, error: "No V3 pool found for any fee tier" };
            }
            return { success: false, error: `Unknown DEX ID: ${dexId}` };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Estimate gas for the full arbitrage transaction using eth_call simulation.
     * @param {Object} opportunity - Opportunity from scanner
     * @returns {bigint} Estimated gas units
     */
    async estimateGas(opportunity) {
        try {
            // Build the calldata for the flash loan request
            const flashLoanReceiver = new ethers.Contract(
                settings.contractAddresses.flashLoanReceiver,
                FLASH_LOAN_RECEIVER_ABI,
                this.provider
            );

            const arbitrageParams = this.buildArbitrageParams(opportunity);
            const paramsEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
                ["uint8", "uint8", "address[]", "address[]", "uint256", "uint256"],
                [
                    arbitrageParams.dexA,
                    arbitrageParams.dexB,
                    arbitrageParams.buyPath,
                    arbitrageParams.sellPath,
                    arbitrageParams.minAmountOutA,
                    arbitrageParams.minAmountOutB,
                ]
            );

            // Estimate gas for the requestFlashLoan call
            // We use a from address (the owner/bot wallet) for gas estimation
            const fromAddress = settings.contractAddresses.arbitrage; // Use contract as proxy for estimate

            const gasEstimate = await this.provider.estimateGas({
                to: settings.contractAddresses.flashLoanReceiver,
                from: settings.ownerWallet || fromAddress,
                data: flashLoanReceiver.requestFlashLoan.interface.encodeFunctionData(
                    "requestFlashLoan",
                    [opportunity.pair.tokenA, BigInt(opportunity.tradeSize), paramsEncoded]
                ),
            });

            // Add 20% buffer for safety
            return (gasEstimate * 120n) / 100n;
        } catch (err) {
            console.warn(`[Simulator] Gas estimation failed, using default: ${err.message}`);
            return BigInt(settings.defaultGasEstimate || 500000);
        }
    }

    /**
     * Compute gas cost in wei.
     */
    computeGasCost(gasEstimate, feeData) {
        // Use EIP-1559 gas pricing
        const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 20_000_000_000n;
        const bufferedGasPrice = (gasPrice * BigInt(this.gasPriceBufferBps)) / 1000n;
        return gasEstimate * bufferedGasPrice;
    }

    /**
     * Convert gas cost (in ETH/wei) to token units.
     * Uses a simple price assumption from settings; production should use an oracle.
     */
    async convertGasCostToToken(gasCostWei, tokenAddress) {
        const ethPriceUsd = settings.ethPriceUsd || 3000;
        const tokenPriceUsd = settings.tokenPrices?.[tokenAddress] || 1;

        const gasCostEth = Number(ethers.formatEther(gasCostWei));
        const gasCostUsd = gasCostEth * ethPriceUsd;
        const gasCostInToken = ethers.parseUnits(
            (gasCostUsd / tokenPriceUsd).toFixed(18),
            18
        );

        return gasCostInToken;
    }

    /**
     * Build the ArbitrageParams struct for the on-chain call.
     */
    buildArbitrageParams(opportunity) {
        const { pair, buyDex, sellDex } = opportunity;

        return {
            dexA: buyDex.dexId,
            dexB: sellDex.dexId,
            buyPath: [pair.tokenA, pair.tokenB],
            sellPath: [pair.tokenB, pair.tokenA],
            minAmountOutA: 0n, // Set by executor with slippage
            minAmountOutB: 0n,
        };
    }

    /**
     * Create a rejection result.
     */
    reject(reason, error = null) {
        console.log(`[Simulator] ❌ REJECTED: ${reason}${error ? ` — ${error}` : ""}`);
        return {
            shouldExecute: false,
            reason,
            error,
            timestamp: Date.now(),
        };
    }
}

// ──────────────────────── Module Export ────────────────────────

module.exports = { Simulator, AAVE_FLASH_LOAN_PREMIUM_BPS };

// ──────────────────────── CLI Entry ────────────────────────

if (require.main === module) {
    const simulator = new Simulator(process.env.RPC_URL);

    // Example opportunity for testing
    const sampleOpportunity = {
        pair: {
            label: "WETH/USDC",
            tokenA: settings.tokenPairs[0]?.tokenA || "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            tokenB: settings.tokenPairs[0]?.tokenB || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            decimalsA: 18,
            decimalsB: 6,
        },
        buyDex: { dexId: 0, dexName: "UniswapV2", price: 0n },
        sellDex: { dexId: 2, dexName: "SushiSwap", price: 0n },
        tradeSize: ethers.parseUnits("10", 18).toString(),
    };

    simulator.simulate(sampleOpportunity).then((result) => {
        console.log("\n=== SIMULATION RESULT ===");
        console.log(JSON.stringify(result, null, 2));
        console.log("=========================\n");
    }).catch(console.error);
}
