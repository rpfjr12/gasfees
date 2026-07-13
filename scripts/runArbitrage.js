/**
 * runArbitrage.js
 * Gasless Flash-Loan Arbitrage Bot — Main Orchestrator
 *
 * Automates the full pipeline:
 *   Scanner → Simulator → Relayer Gate → Executor → Bundler/Flashbots
 *
 * Runs in continuous mode by default, scanning every N seconds and
 * executing any profitable opportunities automatically.
 *
 * Usage:
 *   npx hardhat run scripts/runArbitrage.js --network mainnet
 *   node scripts/runArbitrage.js                    (non-Hardhat mode)
 *   node scripts/runArbitrage.js --once              (single scan cycle)
 *   node scripts/runArbitrage.js --dry-run           (scan + simulate, no execution)
 *
 * Environment variables:
 *   RPC_URL                 - Ethereum RPC endpoint
 *   EXECUTOR_PRIVATE_KEY    - Wallet for signing UserOperations
 *   RELAYER_PRIVATE_KEY     - Wallet for gas-paying (paymaster funder)
 *   BUNDLER_RPC_URL         - ERC-4337 bundler endpoint
 *   FLASHBOTS_RPC_URL       - Flashbots private mempool endpoint
 */

const { ethers } = require("ethers");
const settings = require("../config/settings.json");

// ──────────────────────── Component Imports ────────────────────────

const { Scanner } = require("../bot/scanner");
const { Simulator } = require("../bot/simulator");
const { Executor } = require("../bot/executor");
const { Relayer } = require("../bot/relayer");

// ──────────────────────── Orchestrator Class ────────────────────────

class ArbitrageBot {
    constructor(options = {}) {
        this.rpcUrl = options.rpcUrl || process.env.RPC_URL || settings.rpcUrl;
        this.dryRun = options.dryRun || false;
        this.singleRun = options.singleRun || false;
        this.scanInterval = options.scanInterval || settings.scanIntervalMs || 10000;

        // Initialize components
        this.scanner = new Scanner(this.rpcUrl);
        this.simulator = new Simulator(this.rpcUrl);
        this.executor = new Executor(
            this.rpcUrl,
            process.env.EXECUTOR_PRIVATE_KEY
        );
        this.relayer = new Relayer(
            this.rpcUrl,
            process.env.RELAYER_PRIVATE_KEY
        );

        this.isRunning = false;
        this.stats = {
            scansCompleted: 0,
            opportunitiesFound: 0,
            simulationsRun: 0,
            executionsAttempted: 0,
            executionsSuccessful: 0,
            executionsFailed: 0,
            totalProfitWei: 0n,
            startTime: null,
        };
    }

    /**
     * Start the bot in continuous or single-run mode.
     */
    async start() {
        this.isRunning = true;
        this.stats.startTime = Date.now();

        console.log("═══════════════════════════════════════════════════");
        console.log("  Gasless Flash-Loan Arbitrage Bot — RUNNING");
        console.log("═══════════════════════════════════════════════════");
        console.log(`  Mode:        ${this.singleRun ? "Single scan" : "Continuous"}`);
        console.log(`  Dry run:     ${this.dryRun ? "YES (no execution)" : "NO (will execute)"}`);
        console.log(`  Scan interval: ${this.scanInterval / 1000}s`);
        console.log(`  RPC:         ${this.rpcUrl}`);
        console.log(`  Pairs:       ${settings.tokenPairs.length}`);
        console.log("───────────────────────────────────────────────────");

        // Display relayer status
        try {
            const status = await this.relayer.getStatus();
            console.log(`  Relayer wallet:    ${status.relayerWallet}`);
            console.log(`  Wallet balance:    ${status.walletBalance} ETH`);
            console.log(`  Paymaster deposit: ${status.paymasterDeposit} ETH`);
            console.log("───────────────────────────────────────────────────\n");
        } catch (err) {
            console.log(`  ⚠️ Could not get relayer status: ${err.message}\n`);
        }

        // Start paymaster deposit monitor in background (continuous mode only)
        if (!this.singleRun && !this.dryRun) {
            this.relayer.startMonitoring().catch((err) => {
                console.error("[Bot] Paymaster monitor error:", err.message);
            });
        }

        // Register scanner callback
        this.scanner.onOpportunity((opp) => this.handleOpportunity(opp));

        // Start scanning
        if (this.singleRun) {
            await this.runScanCycle();
            this.printStats();
        } else {
            while (this.isRunning) {
                await this.runScanCycle();
                await this.sleep(this.scanInterval);
            }
        }
    }

    /**
     * Stop the bot.
     */
    stop() {
        this.isRunning = false;
        this.scanner.stop();
        this.relayer.stopMonitoring();
        console.log("\n[Bot] Stopping...");
        this.printStats();
    }

    /**
     * Run a single scan cycle.
     */
    async runScanCycle() {
        this.stats.scansCompleted++;
        const timestamp = new Date().toISOString();
        console.log(`\n[Bot] Scan #${this.stats.scansCompleted} — ${timestamp}`);

        try {
            await this.scanner.scanAllPairs();
        } catch (err) {
            console.error(`[Bot] Scan error: ${err.message}`);
        }
    }

    /**
     * Handle an opportunity detected by the scanner.
     * Runs simulation → relayer gate → execution.
     */
    async handleOpportunity(opportunity) {
        this.stats.opportunitiesFound++;
        console.log(`\n[Bot] 📡 Opportunity detected: ${opportunity.pair.label}`);
        console.log(`[Bot]    Buy: ${opportunity.buyDex.dexName} | Sell: ${opportunity.sellDex.dexName}`);
        console.log(`[Bot]    Profit: ${opportunity.profitPct.toFixed(4)}%`);

        // ─── Phase 1: Simulate ───
        console.log(`[Bot] 🔬 Running off-chain simulation...`);
        this.stats.simulationsRun++;

        const simulation = await this.simulator.simulate(opportunity);

        if (!simulation.shouldExecute) {
            console.log(`[Bot] ❌ Simulation rejected: ${simulation.reason || "not profitable"}`);
            return;
        }

        console.log(`[Bot] ✅ Simulation passed — net profit: ${ethers.formatEther(simulation.netProfit)} units`);

        // ─── Phase 2: Dry run check ───
        if (this.dryRun) {
            console.log(`[Bot] 🏃 DRY RUN — skipping execution`);
            return;
        }

        // ─── Phase 3: Execute via relayer gate ───
        console.log(`[Bot] 🚀 Submitting for execution...`);
        this.stats.executionsAttempted++;

        const relayResult = await this.relayer.relayIfProfitable(
            simulation,
            async (sim) => this.executeOpportunity(sim)
        );

        if (relayResult.relayed && relayResult.result?.success) {
            this.stats.executionsSuccessful++;
            this.stats.totalProfitWei += BigInt(simulation.netProfit || 0);
            console.log(`[Bot] ✅ EXECUTION SUCCESSFUL — tx: ${relayResult.result.transactionHash}`);
        } else if (relayResult.relayed) {
            this.stats.executionsFailed++;
            console.log(`[Bot] ❌ EXECUTION FAILED — ${relayResult.result?.error || "unknown error"}`);
        } else {
            console.log(`[Bot] ⏭️ Execution skipped — ${relayResult.reason}`);
        }
    }

    /**
     * Execute an arbitrage opportunity via the executor.
     */
    async executeOpportunity(simulation) {
        return await this.executor.execute(simulation);
    }

    /**
     * Print running statistics.
     */
    printStats() {
        const uptime = this.stats.startTime
            ? Math.floor((Date.now() - this.stats.startTime) / 1000)
            : 0;
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = uptime % 60;

        console.log("\n═══════════════════════════════════════════════");
        console.log("  BOT STATISTICS");
        console.log("═══════════════════════════════════════════════");
        console.log(`  Uptime:              ${hours}h ${minutes}m ${seconds}s`);
        console.log(`  Scans completed:     ${this.stats.scansCompleted}`);
        console.log(`  Opportunities found: ${this.stats.opportunitiesFound}`);
        console.log(`  Simulations run:     ${this.stats.simulationsRun}`);
        console.log(`  Executions attempted:${this.stats.executionsAttempted}`);
        console.log(`  Executions success:  ${this.stats.executionsSuccessful}`);
        console.log(`  Executions failed:   ${this.stats.executionsFailed}`);
        console.log(`  Total profit:        ${ethers.formatEther(this.stats.totalProfitWei)} units`);
        console.log("═══════════════════════════════════════════════\n");
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// ──────────────────────── CLI Entry ────────────────────────

async function main() {
    // Parse CLI arguments
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const singleRun = args.includes("--once");

    const bot = new ArbitrageBot({
        dryRun,
        singleRun,
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => {
        console.log("\n[Bot] Received SIGINT, shutting down...");
        bot.stop();
        process.exit(0);
    });

    process.on("SIGTERM", () => {
        console.log("\n[Bot] Received SIGTERM, shutting down...");
        bot.stop();
        process.exit(0);
    });

    await bot.start();
}

main().catch((error) => {
    console.error("\n❌ Bot error:", error);
    process.exit(1);
});

// Export for testing
module.exports = { ArbitrageBot };
