/**
 * executor.js
 * Gasless Flash-Loan Arbitrage Bot — Transaction Executor
 *
 * Builds and sends meta-transactions via ERC-4337. The executor:
 *   1. Takes a verified (simulated) opportunity from the simulator.
 *   2. Encodes the flash loan + arbitrage calldata.
 *   3. Builds a UserOperation with paymaster sponsorship.
 *   4. Signs and submits via the bundler (ERC-4337) and Flashbots.
 *   5. Monitors the transaction until confirmation.
 *
 * The user pays zero gas — the paymaster covers all gas costs.
 *
 * Dependencies: ethers v6
 */

const { ethers } = require("ethers");
const settings = require("../config/settings.json");
const { Bundler } = require("./bundler");
const { Relayer } = require("./relayer");

// ──────────────────────── ABIs ────────────────────────

const FLASH_LOAN_RECEIVER_ABI = [
    "function requestFlashLoan(address asset, uint256 amount, bytes params) external",
];

const ARBITRAGE_ABI = [
    "function executeArbitrage(address asset, uint256 amount, uint256 premium, bytes params) external returns (bool)",
    "function owner() view returns (address)",
    "function flashLoanReceiver() view returns (address)",
    "function paymaster() view returns (address)",
];

const PAYMASTER_ABI = [
    "function validatePaymasterUserOp(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, uint256 gasFees, bytes paymasterAndData, bytes signature) userOp, bytes32 userOpHash, uint256 maxCost) returns (bytes context, uint256 validationData)",
    "function whitelistedSenders(address) view returns (bool)",
    "function getDeposit() view returns (uint256)",
];

const ENTRY_POINT_ABI = [
    "function getNonce(address sender, uint192 key) view returns (uint256 nonce)",
    "function getUserOpHash(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, uint256 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)",
    "function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, uint256 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary) external",
];

const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
];

// ──────────────────────── UserOperation Type ────────────────────────

/**
 * UserOperation struct matching the ERC-4337 EntryPoint.
 * @typedef {Object} UserOperation
 * @property {string} sender - Sender account address
 * @property {string} nonce - Account nonce
 * @property {string} initCode - Account factory + init data (empty for existing accounts)
 * @property {string} callData - Calldata for the account execution
 * @property {string} accountGasLimits - Packed verification + execution gas limits
 * @property {string} preVerificationGas - Gas for pre-verification overhead
 * @property {string} gasFees - Packed max priority fee + max fee per gas
 * @property {string} paymasterAndData - Paymaster address + sponsorship data
 * @property {string} signature - UserOperation signature
 */

// ──────────────────────── Executor Class ────────────────────────

class Executor {
    constructor(rpcUrl, privateKey) {
        this.provider = new ethers.JsonRpcProvider(rpcUrl || settings.rpcUrl);
        this.wallet = new ethers.Wallet(privateKey || settings.executorPrivateKey, this.provider);
        this.bundler = new Bundler(rpcUrl);
        this.relayer = new Relayer(rpcUrl, privateKey);

        this.entryPointAddress = settings.contractAddresses.entryPoint;
        this.flashLoanReceiverAddress = settings.contractAddresses.flashLoanReceiver;
        this.arbitrageAddress = settings.contractAddresses.arbitrage;
        this.paymasterAddress = settings.contractAddresses.paymaster;

        this.entryPoint = new ethers.Contract(this.entryPointAddress, ENTRY_POINT_ABI, this.provider);
        this.flashLoanReceiver = new ethers.Contract(
            this.flashLoanReceiverAddress,
            FLASH_LOAN_RECEIVER_ABI,
            this.provider
        );
    }

    /**
     * Execute a verified arbitrage opportunity.
     * @param {Object} simulation - Verified simulation result from simulator.js
     * @returns {Object} Execution result with transaction hash and status.
     */
    async execute(simulation) {
        const { opportunity } = simulation;
        console.log(`[Executor] Building execution for ${opportunity.pair.label}...`);

        try {
            // ─── Step 1: Encode the flash loan calldata ───
            const flashLoanCallData = this.encodeFlashLoanCall(opportunity, simulation);
            console.log(`[Executor] Flash loan calldata encoded (${flashLoanCallData.length} chars)`);

            // ─── Step 2: Get current nonce from EntryPoint ───
            const sender = this.wallet.address;
            const nonce = await this.entryPoint.getNonce(sender, 0);
            console.log(`[Executor] Nonce: ${nonce}`);

            // ─── Step 3: Estimate gas limits ───
            const gasEstimates = await this.estimateGasLimits(simulation);
            console.log(`[Executor] Gas estimates: verification=${gasEstimates.verificationGas}, execution=${gasEstimates.callGasLimit}`);

            // ─── Step 4: Get current gas fees ───
            const gasFees = await this.getGasFees();
            console.log(`[Executor] Gas fees: maxFee=${ethers.formatUnits(gasFees.maxFeePerGas, "gwei")} gwei, priority=${ethers.formatUnits(gasFees.maxPriorityFeePerGas, "gwei")} gwei`);

            // ─── Step 5: Build paymasterAndData ───
            const paymasterAndData = this.buildPaymasterAndData(simulation);
            console.log(`[Executor] Paymaster data built (sponsored by ${this.paymasterAddress})`);

            // ─── Step 6: Build the UserOperation ───
            const userOp = {
                sender: sender,
                nonce: nonce.toString(),
                initCode: "0x",
                callData: flashLoanCallData,
                accountGasLimits: this.packAccountGasLimits(
                    gasEstimates.verificationGas,
                    gasEstimates.callGasLimit
                ),
                preVerificationGas: gasEstimates.preVerificationGas.toString(),
                gasFees: this.packGasFees(gasFees.maxPriorityFeePerGas, gasFees.maxFeePerGas),
                paymasterAndData: paymasterAndData,
                signature: "0x",
            };

            // ─── Step 7: Sign the UserOperation ───
            const userOpHash = await this.entryPoint.getUserOpHash(this.toUserOpTuple(userOp));
            userOp.signature = await this.wallet.signMessage(ethers.getBytes(userOpHash));
            console.log(`[Executor] UserOperation signed`);

            // ─── Step 8: Verify paymaster will sponsor ───
            const paymasterOk = await this.verifyPaymasterSponsorship(userOp, userOpHash);
            if (!paymasterOk) {
                throw new Error("Paymaster validation failed — gas not sponsored");
            }
            console.log(`[Executor] Paymaster sponsorship verified`);

            // ─── Step 9: Submit via bundler + Flashbots ───
            console.log(`[Executor] Submitting via ERC-4337 bundler + Flashbots...`);
            const txHash = await this.bundler.submitUserOperation(userOp, this.entryPointAddress);

            // ─── Step 10: Wait for confirmation ───
            console.log(`[Executor] Waiting for confirmation (tx: ${txHash})...`);
            const receipt = await this.waitForConfirmation(txHash);

            console.log(`[Executor] ✅ EXECUTED — Block: ${receipt.blockNumber}, Gas used: ${receipt.gasUsed}`);

            return {
                success: true,
                transactionHash: txHash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString(),
                netProfit: simulation.netProfit,
                opportunity: opportunity,
            };
        } catch (err) {
            console.error(`[Executor] ❌ Execution failed: ${err.message}`);
            return {
                success: false,
                error: err.message,
                opportunity: opportunity,
            };
        }
    }

    /**
     * Encode the flash loan request calldata.
     */
    encodeFlashLoanCall(opportunity, simulation) {
        const { pair, buyDex, sellDex, tradeSize } = opportunity;

        // Build ArbitrageParams
        const arbitrageParams = ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint8", "uint8", "address[]", "address[]", "uint256", "uint256"],
            [
                buyDex.dexId,
                sellDex.dexId,
                [pair.tokenA, pair.tokenB], // buyPath
                [pair.tokenB, pair.tokenA], // sellPath
                0, // minAmountOutA — 0 for testing; set with slippage in production
                0, // minAmountOutB
            ]
        );

        // Encode the requestFlashLoan call
        const callData = this.flashLoanReceiver.requestFlashLoan.interface.encodeFunctionData(
            "requestFlashLoan",
            [pair.tokenA, BigInt(tradeSize), arbitrageParams]
        );

        return callData;
    }

    /**
     * Estimate gas limits for the UserOperation.
     */
    async estimateGasLimits(simulation) {
        const gasEstimate = BigInt(simulation.gasEstimate || 500000);

        return {
            verificationGas: 100000n, // Standard for simple validation
            callGasLimit: (gasEstimate * 120n) / 100n, // 20% buffer
            preVerificationGas: 21000n, // Base transaction overhead
        };
    }

    /**
     * Get current EIP-1559 gas fees.
     */
    async getGasFees() {
        const feeData = await this.provider.getFeeData();

        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");
        const baseFee = feeData.gasPrice || ethers.parseUnits("20", "gwei");
        const maxFeePerGas = (baseFee * 2n) + maxPriorityFeePerGas; // 2x base fee + priority

        return {
            maxPriorityFeePerGas,
            maxFeePerGas,
        };
    }

    /**
     * Build the paymasterAndData field.
     * Format: address(paymaster) + abi.encode(expectedProfit, estimatedGasCost)
     */
    buildPaymasterAndData(simulation) {
        const expectedProfit = BigInt(simulation.netProfit || 0);
        const estimatedGasCost = BigInt(simulation.gasCostWei || 0);

        const paymasterData = ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256", "uint256"],
            [expectedProfit, estimatedGasCost]
        );

        // Prepend paymaster address (20 bytes)
        return this.paymasterAddress + paymasterData.slice(2);
    }

    /**
     * Pack verification gas and call gas limit into a single bytes32.
     * Format: bytes32 = uint128(verificationGas) << 128 | uint128(callGasLimit)
     */
    packAccountGasLimits(verificationGas, callGasLimit) {
        const packed = (BigInt(verificationGas) << 128n) | BigInt(callGasLimit);
        return ethers.zeroPadValue(ethers.toBeHex(packed), 32);
    }

    /**
     * Pack max priority fee and max fee per gas into a single bytes32.
     * Format: bytes32 = uint128(maxPriorityFeePerGas) << 128 | uint128(maxFeePerGas)
     */
    packGasFees(maxPriorityFeePerGas, maxFeePerGas) {
        const packed = (BigInt(maxPriorityFeePerGas) << 128n) | BigInt(maxFeePerGas);
        return ethers.zeroPadValue(ethers.toBeHex(packed), 32);
    }

    /**
     * Convert UserOperation object to tuple format for ABI encoding.
     */
    toUserOpTuple(userOp) {
        return [
            userOp.sender,
            userOp.nonce,
            userOp.initCode,
            userOp.callData,
            userOp.accountGasLimits,
            userOp.preVerificationGas,
            userOp.gasFees,
            userOp.paymasterAndData,
            userOp.signature,
        ];
    }

    /**
     * Verify that the paymaster will sponsor this operation.
     */
    async verifyPaymasterSponsorship(userOp, userOpHash) {
        try {
            const paymaster = new ethers.Contract(this.paymasterAddress, PAYMASTER_ABI, this.provider);

            // Check if sender is whitelisted
            const isWhitelisted = await paymaster.whitelistedSenders(userOp.sender);
            if (!isWhitelisted) {
                console.warn(`[Executor] Sender ${userOp.sender} not whitelisted on paymaster`);
                return false;
            }

            // Check paymaster has sufficient deposit
            const deposit = await paymaster.getDeposit();
            const maxCost = BigInt(userOp.preVerificationGas) * ethers.parseUnits("20", "gwei");
            if (deposit < maxCost) {
                console.warn(`[Executor] Paymaster deposit insufficient: ${deposit} < ${maxCost}`);
                return false;
            }

            return true;
        } catch (err) {
            console.warn(`[Executor] Paymaster verification error: ${err.message}`);
            return false;
        }
    }

    /**
     * Wait for transaction confirmation.
     */
    async waitForConfirmation(txHash) {
        const maxRetries = 120; // 10 minutes at 5s intervals
        const pollInterval = 5000;

        for (let i = 0; i < maxRetries; i++) {
            const receipt = await this.provider.getTransactionReceipt(txHash);
            if (receipt) {
                if (receipt.status === 0) {
                    throw new Error(`Transaction reverted: ${txHash}`);
                }
                return receipt;
            }
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }

        throw new Error(`Transaction confirmation timeout: ${txHash}`);
    }
}

// ──────────────────────── Module Export ────────────────────────

module.exports = { Executor };

// ──────────────────────── CLI Entry ────────────────────────

if (require.main === module) {
    const executor = new Executor(
        process.env.RPC_URL,
        process.env.EXECUTOR_PRIVATE_KEY
    );

    // Example: execute with a simulated result
    const exampleSimulation = {
        shouldExecute: true,
        opportunity: {
            pair: settings.tokenPairs[0],
            buyDex: { dexId: 0, dexName: "UniswapV2" },
            sellDex: { dexId: 2, dexName: "SushiSwap" },
            tradeSize: ethers.parseUnits("10", 18).toString(),
        },
        gasEstimate: "500000",
        gasCostWei: "10000000000000000",
        netProfit: "500000000000000000",
    };

    executor.execute(exampleSimulation).then((result) => {
        console.log("\n=== EXECUTION RESULT ===");
        console.log(JSON.stringify(result, null, 2));
        console.log("========================\n");
    }).catch(console.error);
}
