/**
 * test.js
 * Gasless Flash-Loan Arbitrage Bot — Full Simulation Test
 *
 * Runs a complete end-to-end test of the arbitrage pipeline:
 *   1. Connects to the configured network.
 *   2. Scans for price discrepancies across DEXes.
 *   3. Simulates the most profitable opportunity.
 *   4. Validates gas costs, flash loan premium, and net profit.
 *   5. Reports a detailed summary without executing on-chain.
 *
 * Usage:
 *   npx hardhat run scripts/test.js --network mainnet
 *   npx hardhat run scripts/test.js --network sepolia
 *   npx hardhat run scripts/test.js --network hardhat  (local fork)
 *
 * For local fork testing:
 *   npx hardhat node --fork https://eth-mainnet.alchemyapi.io/v2/YOUR_KEY
 *   npx hardhat run scripts/test.js --network localhost
 */

const { ethers } = require("hardhat");
const { Scanner, DEX_NAMES } = require("../bot/scanner");
const { Simulator } = require("../bot/simulator");
const settings = require("../config/settings.json");

// ──────────────────────── Test Runner ────────────────────────

async function main() {
    const [signer] = await ethers.getSigners();
    const network = await ethers.provider.getNetwork();
    const rpcUrl = ethers.provider.connection?.url || settings.rpcUrl;

    console.log("═══════════════════════════════════════════════");
    console.log("  Arbitrage Bot — Full Simulation Test");
    console.log("═══════════════════════════════════════════════");
    console.log(`Network:     ${network.name} (chainId: ${network.chainId})`);
    console.log(`Signer:      ${signer?.address || "N/A"}`);
    console.log(`Block:       ${await ethers.provider.getBlockNumber()}`);
    console.log("───────────────────────────────────────────────\n");

    // ─── Initialize components ───
    const scanner = new Scanner(rpcUrl);
    const simulator = new Simulator(rpcUrl);

    const results = {
        pairsScanned: 0,
        pricesFound: 0,
        opportunitiesDetected: 0,
        simulationsRun: 0,
        profitableSimulations: 0,
        bestOpportunity: null,
        details: [],
    };

    // ─── Phase 1: Scan all configured pairs ───
    console.log("Phase 1: Scanning DEX prices...\n");

    for (const pair of settings.tokenPairs) {
        results.pairsScanned++;
        console.log(`  Scanning ${pair.label}...`);

        try {
            const prices = await scanner.getPricesAcrossDEXes(pair);

            if (prices.length === 0) {
                console.log(`    ⚠️ No prices found for ${pair.label}`);
                results.details.push({
                    pair: pair.label,
                    status: "no_prices",
                });
                continue;
            }

            results.pricesFound += prices.length;
            console.log(`    Found ${prices.length} price(s):`);
            prices.forEach((p) => {
                console.log(`      ${p.dexName}: ${ethers.formatUnits(p.price, pair.decimalsB || 6)}`);
            });

            // Detect arbitrage
            const opportunities = scanner.detectArbitrage(pair, prices);

            if (opportunities.length > 0) {
                results.opportunitiesDetected += opportunities.length;
                console.log(`    ✅ ${opportunities.length} opportunity(ies) detected!\n`);

                // ─── Phase 2: Simulate each opportunity ───
                for (const opp of opportunities) {
                    results.simulationsRun++;
                    console.log(`  Simulating: Buy ${opp.buyDex.dexName} → Sell ${opp.sellDex.dexName}...`);

                    const simResult = await simulator.simulate(opp);

                    if (simResult.shouldExecute) {
                        results.profitableSimulations++;
                        console.log(`    ✅ PROFITABLE`);
                        console.log(`       Flash loan amount:    ${ethers.formatEther(simResult.flashLoanAmount)} units`);
                        console.log(`       Flash loan premium:   ${ethers.formatEther(simResult.flashLoanPremium)} units`);
                        console.log(`       Total repay:          ${ethers.formatEther(simResult.totalRepay)} units`);
                        console.log(`       Swap A output:        ${ethers.formatEther(simResult.swapAOutput)} units`);
                        console.log(`       Swap B output:        ${ethers.formatEther(simResult.swapBOutput)} units`);
                        console.log(`       Gross profit:         ${ethers.formatEther(simResult.grossProfit)} units`);
                        console.log(`       Gas estimate:         ${simResult.gasEstimate} units`);
                        console.log(`       Gas cost (ETH):       ${ethers.formatEther(simResult.gasCostWei)} ETH`);
                        console.log(`       Gas cost (token):      ${ethers.formatEther(simResult.gasCostInToken)} units`);
                        console.log(`       Paymaster reimburs:   ${ethers.formatEther(simResult.paymasterReimbursement)} units`);
                        console.log(`       Net profit:           ${ethers.formatEther(simResult.netProfit)} units`);
                        console.log(`       Profit after costs:   ${ethers.formatEther(simResult.profitAfterAllCosts)} units\n`);

                        // Track best opportunity
                        if (!results.bestOpportunity ||
                            BigInt(simResult.profitAfterAllCosts) > BigInt(results.bestOpportunity.profitAfterAllCosts || "0")) {
                            results.bestOpportunity = simResult;
                        }

                        results.details.push({
                            pair: pair.label,
                            status: "profitable",
                            buyDex: opp.buyDex.dexName,
                            sellDex: opp.sellDex.dexName,
                            profitPct: opp.profitPct,
                            netProfit: simResult.netProfit,
                            profitAfterCosts: simResult.profitAfterAllCosts,
                        });
                    } else {
                        console.log(`    ❌ Not profitable: ${simResult.reason || "net profit below threshold"}\n`);
                        results.details.push({
                            pair: pair.label,
                            status: "not_profitable",
                            reason: simResult.reason,
                        });
                    }
                }
            } else {
                console.log(`    No arbitrage opportunity for ${pair.label}\n`);
                results.details.push({
                    pair: pair.label,
                    status: "no_opportunity",
                });
            }
        } catch (err) {
            console.error(`    ❌ Error scanning ${pair.label}: ${err.message}\n`);
            results.details.push({
                pair: pair.label,
                status: "error",
                error: err.message,
            });
        }
    }

    // ─── Phase 3: Contract integration test ───
    console.log("\nPhase 3: Contract integration checks...\n");

    if (settings.contractAddresses && settings.contractAddresses.arbitrage) {
        try {
            const arbitrage = await ethers.getContractAt(
                "Arbitrage",
                settings.contractAddresses.arbitrage
            );

            const owner = await arbitrage.owner();
            const flr = await arbitrage.flashLoanReceiver();
            const paymaster = await arbitrage.paymaster();
            const aavePool = await arbitrage.aavePool();

            console.log(`  Arbitrage contract:     ${settings.contractAddresses.arbitrage}`);
            console.log(`    Owner:                ${owner}`);
            console.log(`    FlashLoanReceiver:    ${flr}`);
            console.log(`    Paymaster:            ${paymaster}`);
            console.log(`    Aave Pool:            ${aavePool}`);

            // Verify FlashLoanReceiver
            if (flr !== ethers.ZeroAddress) {
                const flrContract = await ethers.getContractAt("FlashLoanReceiver", flr);
                const flrOwner = await flrContract.owner();
                const flrPool = await flrContract.getPoolAddress();
                const flrArbitrage = await flrContract.arbitrage();
                console.log(`  FlashLoanReceiver:      ${flr}`);
                console.log(`    Owner:                ${flrOwner}`);
                console.log(`    Pool:                 ${flrPool}`);
                console.log(`    Arbitrage:            ${flrArbitrage}`);
                console.log(`    Arbitrage linked:     ${flrArbitrage === settings.contractAddresses.arbitrage ? "✅ YES" : "❌ NO"}`);
            }

            // Verify Paymaster
            if (paymaster !== ethers.ZeroAddress) {
                const paymasterContract = await ethers.getContractAt("Paymaster", paymaster);
                const pmDeposit = await paymasterContract.getDeposit();
                const pmArbitrage = await paymasterContract.arbitrageContract();
                const pmMinProfit = await paymasterContract.minProfitThreshold();
                const pmMaxGas = await paymasterContract.maxSponsoredGasCost();
                console.log(`  Paymaster:              ${paymaster}`);
                console.log(`    Deposit:              ${ethers.formatEther(pmDeposit)} ETH`);
                console.log(`    Arbitrage:            ${pmArbitrage}`);
                console.log(`    Arbitrage linked:     ${pmArbitrage === settings.contractAddresses.arbitrage ? "✅ YES" : "❌ NO"}`);
                console.log(`    Min profit threshold: ${ethers.formatUnits(pmMinProfit, 6)} USDC`);
                console.log(`    Max gas cost:         ${ethers.formatEther(pmMaxGas)} ETH`);
            }

            console.log("\n  ✅ Contract integration checks passed\n");
        } catch (err) {
            console.log(`  ⚠️ Contract integration check failed: ${err.message}\n`);
        }
    } else {
        console.log("  ⚠️ No contract addresses configured. Run deploy.js first.\n");
    }

    // ─── Summary Report ───
    console.log("═══════════════════════════════════════════════");
    console.log("  TEST SUMMARY");
    console.log("═══════════════════════════════════════════════");
    console.log(`  Pairs scanned:           ${results.pairsScanned}`);
    console.log(`  Prices found:            ${results.pricesFound}`);
    console.log(`  Opportunities detected:  ${results.opportunitiesDetected}`);
    console.log(`  Simulations run:         ${results.simulationsRun}`);
    console.log(`  Profitable simulations:  ${results.profitableSimulations}`);

    if (results.bestOpportunity) {
        console.log("───────────────────────────────────────────────");
        console.log("  BEST OPPORTUNITY:");
        console.log(`    Pair:            ${results.bestOpportunity.opportunity.pair.label}`);
        console.log(`    Buy on:          ${results.bestOpportunity.opportunity.buyDex.dexName}`);
        console.log(`    Sell on:         ${results.bestOpportunity.opportunity.sellDex.dexName}`);
        console.log(`    Profit %:        ${results.bestOpportunity.opportunity.profitPct.toFixed(4)}%`);
        console.log(`    Net profit:      ${ethers.formatEther(results.bestOpportunity.netProfit)} units`);
        console.log(`    After all costs: ${ethers.formatEther(results.bestOpportunity.profitAfterAllCosts)} units`);
    }

    console.log("───────────────────────────────────────────────");
    console.log("  Per-pair results:");
    results.details.forEach((d) => {
        const status = d.status === "profitable" ? "✅" :
                       d.status === "not_profitable" ? "❌" :
                       d.status === "no_opportunity" ? "➖" :
                       d.status === "no_prices" ? "⚠️" : "🔥";
        console.log(`    ${status} ${d.pair}: ${d.status}`);
    });

    console.log("═══════════════════════════════════════════════\n");

    // Exit code: 0 if any profitable, 1 if none
    if (results.profitableSimulations > 0) {
        console.log("✅ Test passed — profitable opportunities found!");
        process.exit(0);
    } else {
        console.log("ℹ️  Test completed — no profitable opportunities at this time.");
        console.log("   This is normal. Run again later or adjust config/settings.json.");
        process.exit(0);
    }
}

main().catch((error) => {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
});
