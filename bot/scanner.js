/**
 * scanner.js
 * Gasless Flash-Loan Arbitrage Bot — DEX Price Scanner
 *
 * Continuously scans Uniswap V2, Uniswap V3, and SushiSwap for price
 * discrepancies on configured token pairs. Emits opportunities when
 * a profitable spread is detected.
 *
 * Dependencies: ethers v6
 */

const { ethers } = require("ethers");
const settings = require("../config/settings.json");

// ──────────────────────── ABIs ────────────────────────

const UNISWAP_V2_PAIR_ABI = [
    "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
];

const UNISWAP_V2_FACTORY_ABI = [
    "function getPair(address tokenA, address tokenB) view returns (address)",
];

const UNISWAP_V3_QUOTER_ABI = [
    "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut)",
];

const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
];

// ──────────────────────── Constants ────────────────────────

const DEX_NAMES = {
    0: "UniswapV2",
    1: "UniswapV3",
    2: "SushiSwap",
};

const V3_FEE_TIERS = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

// ──────────────────────── Scanner Class ────────────────────────

class Scanner {
    constructor(rpcUrl) {
        this.provider = new ethers.JsonRpcProvider(rpcUrl || settings.rpcUrl);
        this.pairs = settings.tokenPairs;
        this.dexAddresses = settings.dexAddresses;
        this.scanInterval = settings.scanIntervalMs || 5000;
        this.minProfitThreshold = ethers.parseUnits(
            settings.minProfitThresholdUsd || "5",
            6
        );
        this.isRunning = false;
        this.opportunities = [];
        this.callbacks = [];
    }

    /**
     * Register a callback for when an opportunity is found.
     * @param {Function} cb - Called with (opportunity) when an arbitrage opportunity is detected.
     */
    onOpportunity(cb) {
        this.callbacks.push(cb);
    }

    /**
     * Start scanning all configured pairs across all DEXes.
     */
    async start() {
        this.isRunning = true;
        console.log("[Scanner] Starting price scanner...");
        console.log(`[Scanner] Monitoring ${this.pairs.length} token pairs across ${Object.keys(DEX_NAMES).length} DEXes`);

        while (this.isRunning) {
            try {
                await this.scanAllPairs();
            } catch (err) {
                console.error("[Scanner] Scan error:", err.message);
            }
            await this.sleep(this.scanInterval);
        }
    }

    /**
     * Stop the scanner.
     */
    stop() {
        this.isRunning = false;
        console.log("[Scanner] Stopped.");
    }

    /**
     * Scan all configured token pairs for arbitrage opportunities.
     */
    async scanAllPairs() {
        const allPrices = [];

        for (const pair of this.pairs) {
            const prices = await this.getPricesAcrossDEXes(pair);
            if (prices.length >= 2) {
                allPrices.push({ pair, prices });
            }
        }

        for (const { pair, prices } of allPrices) {
            const opportunities = this.detectArbitrage(pair, prices);
            for (const opp of opportunities) {
                this.opportunities.push(opp);
                this.callbacks.forEach((cb) => cb(opp));
            }
        }
    }

    /**
     * Get the price of a token pair across all configured DEXes.
     * @param {Object} pair - { tokenA, tokenB, label }
     * @returns {Array} Array of { dexId, dexName, price, amountOut }
     */
    async getPricesAcrossDEXes(pair) {
        const prices = [];
        const amountIn = ethers.parseUnits("1", pair.decimalsA || 18);

        // Uniswap V2
        try {
            const v2Price = await this.getUniswapV2Price(
                this.dexAddresses.uniswapV2Factory,
                pair.tokenA,
                pair.tokenB,
                amountIn
            );
            if (v2Price) {
                prices.push({ dexId: 0, dexName: "UniswapV2", price: v2Price, amountOut: v2Price });
            }
        } catch (e) {
            // Pair may not exist on V2
        }

        // Uniswap V3
        try {
            const v3Price = await this.getUniswapV3Price(
                this.dexAddresses.uniswapV3Quoter,
                pair.tokenA,
                pair.tokenB,
                amountIn
            );
            if (v3Price) {
                prices.push({ dexId: 1, dexName: "UniswapV3", price: v3Price, amountOut: v3Price });
            }
        } catch (e) {
            // Pair may not exist on V3
        }

        // SushiSwap
        try {
            const sushiPrice = await this.getUniswapV2Price(
                this.dexAddresses.sushiswapFactory,
                pair.tokenA,
                pair.tokenB,
                amountIn
            );
            if (sushiPrice) {
                prices.push({ dexId: 2, dexName: "SushiSwap", price: sushiPrice, amountOut: sushiPrice });
            }
        } catch (e) {
            // Pair may not exist on SushiSwap
        }

        return prices;
    }

    /**
     * Get price from a Uniswap V2-style DEX (V2, SushiSwap).
     * Uses the constant product formula: out = (in * reserveOut) / (reserveIn + in)
     */
    async getUniswapV2Price(factoryAddress, tokenIn, tokenOut, amountIn) {
        const factory = new ethers.Contract(factoryAddress, UNISWAP_V2_FACTORY_ABI, this.provider);
        const pairAddress = await factory.getPair(tokenIn, tokenOut);
        if (pairAddress === ethers.ZeroAddress) return null;

        const pairContract = new ethers.Contract(pairAddress, UNISWAP_V2_PAIR_ABI, this.provider);
        const [reserve0, reserve1] = await pairContract.getReserves();
        const token0 = await pairContract.token0();

        // Determine which reserve corresponds to tokenIn
        let reserveIn, reserveOut;
        if (token0.toLowerCase() === tokenIn.toLowerCase()) {
            reserveIn = reserve0;
            reserveOut = reserve1;
        } else {
            reserveIn = reserve1;
            reserveOut = reserve0;
        }

        // Constant product formula with 0.3% fee
        const amountInWithFee = amountIn * 997n;
        const numerator = amountInWithFee * reserveOut;
        const denominator = reserveIn * 1000n + amountInWithFee;
        const amountOut = numerator / denominator;

        return amountOut;
    }

    /**
     * Get price from Uniswap V3 using the Quoter contract.
     * Tries multiple fee tiers and returns the best price.
     */
    async getUniswapV3Price(quoterAddress, tokenIn, tokenOut, amountIn) {
        const quoter = new ethers.Contract(quoterAddress, UNISWAP_V3_QUOTER_ABI, this.provider);

        let bestPrice = 0n;

        for (const fee of V3_FEE_TIERS) {
            try {
                // quoteExactInputSingle is not a view function (it uses revert for return)
                // We use staticCall to simulate
                const amountOut = await quoter.quoteExactInputSingle.staticCall(
                    tokenIn,
                    tokenOut,
                    fee,
                    amountIn,
                    0
                );
                if (amountOut > bestPrice) {
                    bestPrice = amountOut;
                }
            } catch (e) {
                // This fee tier doesn't have a pool for this pair
            }
        }

        return bestPrice > 0n ? bestPrice : null;
    }

    /**
     * Detect arbitrage opportunities by comparing prices across DEXes.
     * @param {Object} pair - Token pair config.
     * @param {Array} prices - Array of price objects from getPricesAcrossDEXes.
     * @returns {Array} Array of opportunity objects.
     */
    detectArbitrage(pair, prices) {
        const opportunities = [];

        // Sort by price ascending (cheapest to buy, most expensive to sell)
        const sorted = [...prices].sort((a, b) => {
            if (a.price < b.price) return -1;
            if (a.price > b.price) return 1;
            return 0;
        });

        for (let i = 0; i < sorted.length - 1; i++) {
            const buyDex = sorted[i];
            const sellDex = sorted[sorted.length - 1];

            if (buyDex.dexId === sellDex.dexId) continue;

            const priceDiff = sellDex.price - buyDex.price;
            const profitPct = (Number(priceDiff) / Number(buyDex.price)) * 100;

            // Calculate potential profit for a given trade size
            const tradeSize = ethers.parseUnits(
                settings.tradeSizeUsd || "10000",
                pair.decimalsA || 18
            );

            // Estimated profit = tradeSize * priceDiff / buyDex.price (simplified)
            const estimatedGrossProfit = (tradeSize * priceDiff) / buyDex.price;

            if (profitPct >= (settings.minProfitPct || 0.5)) {
                const opportunity = {
                    id: `${pair.label}-${buyDex.dexId}-${sellDex.dexId}-${Date.now()}`,
                    pair: pair,
                    buyDex: buyDex,
                    sellDex: sellDex,
                    priceDiff: priceDiff.toString(),
                    profitPct: profitPct,
                    estimatedGrossProfit: estimatedGrossProfit.toString(),
                    tradeSize: tradeSize.toString(),
                    timestamp: Date.now(),
                };

                console.log(
                    `[Scanner] Opportunity found: ${pair.label} — Buy on ${buyDex.dexName} @ ${buyDex.price}, ` +
                    `Sell on ${sellDex.dexName} @ ${sellDex.price} — Profit: ${profitPct.toFixed(3)}%`
                );

                opportunities.push(opportunity);
            }
        }

        return opportunities;
    }

    /**
     * Get a snapshot of current prices for all pairs (useful for dashboard/API).
     */
    async getPriceSnapshot() {
        const snapshot = [];
        for (const pair of this.pairs) {
            const prices = await this.getPricesAcrossDEXes(pair);
            snapshot.push({ pair: pair.label, prices: prices.map(p => ({
                dex: p.dexName,
                price: p.price.toString(),
            }))});
        }
        return snapshot;
    }

    /**
     * Get all detected opportunities (cleared after read).
     */
    getOpportunities() {
        const ops = [...this.opportunities];
        this.opportunities = [];
        return ops;
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// ──────────────────────── Module Export ────────────────────────

module.exports = { Scanner, DEX_NAMES };

// ──────────────────────── CLI Entry ────────────────────────

if (require.main === module) {
    const scanner = new Scanner(process.env.RPC_URL);

    scanner.onOpportunity((opp) => {
        console.log("\n=== ARBITRAGE OPPORTUNITY ===");
        console.log(`Pair:         ${opp.pair.label}`);
        console.log(`Buy on:       ${opp.buyDex.dexName}`);
        console.log(`Sell on:      ${opp.sellDex.dexName}`);
        console.log(`Profit %:     ${opp.profitPct.toFixed(4)}%`);
        console.log(`Est. Profit:  ${ethers.formatEther(opp.estimatedGrossProfit)} units`);
        console.log(`Timestamp:    ${new Date(opp.timestamp).toISOString()}`);
        console.log("=============================\n");
    });

    scanner.start().catch(console.error);
}
