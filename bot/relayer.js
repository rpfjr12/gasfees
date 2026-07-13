/**
 * relayer.js
 * Gasless Flash-Loan Arbitrage Bot — Meta-Transaction Relayer
 *
 * The relayer manages the gas-paying wallet and only relays transactions
 * when the simulator confirms profitability. It:
 *   1. Holds the gas-paying wallet (funds the paymaster deposit).
 *   2. Monitors paymaster deposit balance and tops up when needed.
 *   3. Signs and relays meta-transactions through Flashbots.
 *   4. Only relays when simulation shows positive net profit.
 *
 * In the gasless model, the relayer wallet pays gas to the EntryPoint,
 * but is reimbursed by the Arbitrage contract during execution.
 * The end user pays zero gas.
 *
 * Dependencies: ethers v6
 */

const { ethers } = require("ethers");
const settings = require("../config/settings.json");

// ──────────────────────── ABIs ────────────────────────

const PAYMASTER_ABI = [
    "function getDeposit() view returns (uint256)",
    "function addDeposit() payable",
    "function whitelistedSenders(address) view returns (bool)",
    "function setWhitelistedSender(address, bool) external",
    "function minProfitThreshold() view returns (uint256)",
    "function maxSponsoredGasCost() view returns (uint256)",
];

const ENTRY_POINT_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function depositTo(address) payable",
    "function getNonce(address, uint192) view returns (uint256)",
];

const FLASH_LOAN_RECEIVER_ABI = [
    "function owner() view returns (address)",
    "function requestFlashLoan(address, uint256, bytes) external",
];

// ──────────────────────── Relayer Class ────────────────────────

class Relayer {
    constructor(rpcUrl, privateKey) {
        this.provider = new ethers.JsonRpcProvider(rpcUrl || settings.rpcUrl);
        this.wallet = new ethers.Wallet(
            privateKey || settings.relayerPrivateKey,
            this.provider
        );

        this.paymasterAddress = settings.contractAddresses.paymaster;
        this.entryPointAddress = settings.contractAddresses.entryPoint;
        this.flashLoanReceiverAddress = settings.contractAddresses.flashLoanReceiver;

        this.paymaster = new ethers.Contract(this.paymasterAddress, PAYMASTER_ABI, this.wallet);
        this.entryPoint = new ethers.Contract(this.entryPointAddress, ENTRY_POINT_ABI, this.wallet);

        // Configuration
        this.minDepositThreshold = ethers.parseEther(
            settings.relayerMinDepositEth || "0.5"
        );
        this.topUpAmount = ethers.parseEther(
            settings.relayerTopUpAmountEth || "1.0"
        );
        this.monitorInterval = settings.relayerMonitorIntervalMs || 60000;

        this.isMonitoring = false;
    }

    /**
     * Start monitoring the paymaster deposit and top up when needed.
     */
    async startMonitoring() {
        this.isMonitoring = true;
        console.log(`[Relayer] Starting paymaster deposit monitor (wallet: ${this.wallet.address})`);

        while (this.isMonitoring) {
            try {
                await this.checkAndTopUpDeposit();
            } catch (err) {
                console.error(`[Relayer] Monitor error: ${err.message}`);
            }
            await this.sleep(this.monitorInterval);
        }
    }

    /**
     * Stop monitoring.
     */
    stopMonitoring() {
        this.isMonitoring = false;
        console.log("[Relayer] Stopped monitoring.");
    }

    /**
     * Check the paymaster deposit balance and top up if below threshold.
     */
    async checkAndTopUpDeposit() {
        const deposit = await this.paymaster.getDeposit();
        const depositEth = ethers.formatEther(deposit);

        console.log(`[Relayer] Paymaster deposit: ${depositEth} ETH`);

        if (deposit < this.minDepositThreshold) {
            console.log(`[Relayer] Deposit below threshold, topping up ${ethers.formatEther(this.topUpAmount)} ETH...`);
            await this.topUpPaymasterDeposit(this.topUpAmount);
        }
    }

    /**
     * Top up the paymaster deposit on the EntryPoint.
     * @param {bigint} amount - Amount in wei to deposit.
     */
    async topUpPaymasterDeposit(amount) {
        try {
            // Check relayer wallet balance
            const walletBalance = await this.provider.getBalance(this.wallet.address);
            if (walletBalance < amount) {
                throw new Error(
                    `Relayer wallet insufficient balance: ${ethers.formatEther(walletBalance)} ETH < ${ethers.formatEther(amount)} ETH`
                );
            }

            // Deposit to EntryPoint for the paymaster
            const tx = await this.entryPoint.depositTo(this.paymasterAddress, {
                value: amount,
                gasLimit: 100000,
            });

            console.log(`[Relayer] Deposit tx submitted: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`[Relayer] ✅ Deposit confirmed in block ${receipt.blockNumber}`);

            return receipt;
        } catch (err) {
            console.error(`[Relayer] ❌ Deposit top-up failed: ${err.message}`);
            throw err;
        }
    }

    /**
     * Whitelist a sender address on the paymaster.
     * @param {string} sender - Address to whitelist.
     * @param {boolean} status - True to whitelist, false to remove.
     */
    async setWhitelistedSender(sender, status) {
        const tx = await this.paymaster.setWhitelistedSender(sender, status);
        console.log(`[Relayer] Whitelist tx: ${tx.hash}`);
        return tx.wait();
    }

    /**
     * Check if a sender is whitelisted on the paymaster.
     * @param {string} sender - Address to check.
     * @returns {boolean}
     */
    async isWhitelisted(sender) {
        return await this.paymaster.whitelistedSenders(sender);
    }

    /**
     * Relay a meta-transaction only if the simulation shows profit.
     * This is the core gatekeeping function.
     *
     * @param {Object} simulation - Simulation result from simulator.js
     * @param {Function} executeFn - Execution function from executor.js
     * @returns {Object} Relay result
     */
    async relayIfProfitable(simulation, executeFn) {
        // ─── Gate 1: Check simulation verdict ───
        if (!simulation.shouldExecute) {
            console.log(`[Relayer] ❌ Skipping — simulation says do not execute: ${simulation.reason || "not profitable"}`);
            return {
                relayed: false,
                reason: simulation.reason || "simulation rejected",
            };
        }

        // ─── Gate 2: Verify profit is positive ───
        if (BigInt(simulation.netProfit || 0) <= 0n) {
            console.log(`[Relayer] ❌ Skipping — net profit is not positive`);
            return {
                relayed: false,
                reason: "net profit not positive",
            };
        }

        // ─── Gate 3: Check paymaster deposit ───
        const deposit = await this.paymaster.getDeposit();
        const estimatedGasCost = BigInt(simulation.gasCostWei || 0);

        if (deposit < estimatedGasCost) {
            console.log(`[Relayer] ⚠️ Paymaster deposit low, topping up before relay...`);
            try {
                await this.topUpPaymasterDeposit(this.topUpAmount);
            } catch (err) {
                console.error(`[Relayer] ❌ Cannot top up deposit: ${err.message}`);
                return {
                    relayed: false,
                    reason: "insufficient paymaster deposit and top-up failed",
                };
            }
        }

        // ─── Gate 4: Check profit threshold on paymaster ───
        const minProfitThreshold = await this.paymaster.minProfitThreshold();
        if (BigInt(simulation.netProfit) < minProfitThreshold) {
            console.log(`[Relayer] ❌ Skipping — profit below paymaster threshold`);
            return {
                relayed: false,
                reason: "profit below paymaster minimum threshold",
            };
        }

        // ─── All gates passed — relay the transaction ───
        console.log(`[Relayer] ✅ All gates passed — relaying meta-transaction`);
        console.log(`[Relayer] Expected net profit: ${ethers.formatEther(simulation.netProfit)} units`);
        console.log(`[Relayer] Estimated gas cost: ${ethers.formatEther(simulation.gasCostWei || "0")} ETH`);

        const result = await executeFn(simulation);

        if (result.success) {
            console.log(`[Relayer] ✅ Relay successful — tx: ${result.transactionHash}`);
        } else {
            console.error(`[Relayer] ❌ Relay failed — ${result.error}`);
        }

        return {
            relayed: true,
            result: result,
        };
    }

    /**
     * Get the relayer wallet's ETH balance.
     * @returns {bigint} Balance in wei.
     */
    async getRelayerBalance() {
        return await this.provider.getBalance(this.wallet.address);
    }

    /**
     * Get the paymaster's deposit balance on the EntryPoint.
     * @returns {bigint} Deposit in wei.
     */
    async getPaymasterDeposit() {
        return await this.paymaster.getDeposit();
    }

    /**
     * Get relayer status summary.
     */
    async getStatus() {
        const walletBalance = await this.getRelayerBalance();
        const deposit = await this.getPaymasterDeposit();
        const minThreshold = await this.paymaster.minProfitThreshold();
        const maxGas = await this.paymaster.maxSponsoredGasCost();

        return {
            relayerWallet: this.wallet.address,
            walletBalance: ethers.formatEther(walletBalance),
            paymasterDeposit: ethers.formatEther(deposit),
            minDepositThreshold: ethers.formatEther(this.minDepositThreshold),
            paymasterMinProfit: ethers.formatUnits(minThreshold, 6),
            paymasterMaxGasCost: ethers.formatEther(maxGas),
            isMonitoring: this.isMonitoring,
        };
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// ──────────────────────── Module Export ────────────────────────

module.exports = { Relayer };

// ──────────────────────── CLI Entry ────────────────────────

if (require.main === module) {
    const relayer = new Relayer(process.env.RPC_URL, process.env.RELAYER_PRIVATE_KEY);

    relayer.getStatus().then((status) => {
        console.log("\n=== RELAYER STATUS ===");
        console.log(JSON.stringify(status, null, 2));
        console.log("======================\n");
    }).catch(console.error);
}
