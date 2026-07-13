/**
 * bundler.js
 * Gasless Flash-Loan Arbitrage Bot — ERC-4337 Bundler + Flashbots Submitter
 *
 * Handles submission of UserOperations via two channels:
 *   1. ERC-4337 Bundler RPC — submits UserOperations to the EntryPoint
 *      through a specialized bundler node (e.g. Stackup, Alchemy, Pimlico).
 *   2. Flashbots / MEV-Share — submits raw transactions to private mempools
 *      to avoid front-running and MEV extraction.
 *
 * The bundler tries the ERC-4337 RPC first, then falls back to direct
 * EntryPoint submission via Flashbots for maximum privacy.
 *
 * Dependencies: ethers v6
 */

const { ethers } = require("ethers");
const settings = require("../config/settings.json");

// ──────────────────────── Constants ────────────────────────

const FLASHBOTS_RPC_URLS = {
    mainnet: "https://rpc.flashbots.net",
    goerli: "https://rpc-goerli.flashbots.net",
    sepolia: "https://rpc-sepolia.flashbots.net",
};

// ──────────────────────── Bundler Class ────────────────────────

class Bundler {
    constructor(rpcUrl) {
        this.provider = new ethers.JsonRpcProvider(rpcUrl || settings.rpcUrl);
        this.bundlerRpcUrl = settings.bundlerRpcUrl || "";
        this.flashbotsRpcUrl = this.getFlashbotsUrl();
        this.entryPointAddress = settings.contractAddresses.entryPoint;
        this.maxRetries = 3;
        this.retryDelayMs = 2000;
    }

    /**
     * Get the appropriate Flashbots RPC URL based on the chain.
     */
    getFlashbotsUrl() {
        if (settings.flashbotsRpcUrl) {
            return settings.flashbotsRpcUrl;
        }
        const chain = settings.chain || "mainnet";
        return FLASHBOTS_RPC_URLS[chain] || FLASHBOTS_RPC_URLS.mainnet;
    }

    // ──────────────────────── ERC-4337 Bundler Methods ────────────────────────

    /**
     * Submit a UserOperation via the ERC-4337 bundler RPC.
     * Tries bundler first, falls back to Flashbots direct submission.
     *
     * @param {Object} userOp - The signed UserOperation.
     * @param {string} entryPointAddress - EntryPoint contract address.
     * @returns {string} Transaction hash.
     */
    async submitUserOperation(userOp, entryPointAddress) {
        // Strategy 1: Try ERC-4337 bundler RPC
        if (this.bundlerRpcUrl) {
            try {
                const txHash = await this.submitViaBundlerRPC(userOp, entryPointAddress);
                if (txHash) {
                    console.log(`[Bundler] ✅ Submitted via ERC-4337 bundler RPC: ${txHash}`);
                    return txHash;
                }
            } catch (err) {
                console.warn(`[Bundler] Bundler RPC failed: ${err.message}`);
            }
        }

        // Strategy 2: Flashbots private mempool submission
        try {
            const txHash = await this.submitViaFlashbots(userOp, entryPointAddress);
            if (txHash) {
                console.log(`[Bundler] ✅ Submitted via Flashbots: ${txHash}`);
                return txHash;
            }
        } catch (err) {
            console.warn(`[Bundler] Flashbots submission failed: ${err.message}`);
        }

        // Strategy 3: Fallback to direct on-chain submission
        console.log(`[Bundler] Falling back to direct submission...`);
        const txHash = await this.submitDirect(userOp, entryPointAddress);
        console.log(`[Bundler] ✅ Submitted via direct transaction: ${txHash}`);
        return txHash;
    }

    /**
     * Submit via ERC-4337 bundler JSON-RPC.
     * Uses the eth_sendUserOperation method.
     */
    async submitViaBundlerRPC(userOp, entryPointAddress) {
        const bundlerProvider = new ethers.JsonRpcProvider(this.bundlerRpcUrl);

        const userOpSerialized = {
            sender: userOp.sender,
            nonce: userOp.nonce,
            initCode: userOp.initCode,
            callData: userOp.callData,
            accountGasLimits: userOp.accountGasLimits,
            preVerificationGas: ethers.toQuantity(BigInt(userOp.preVerificationGas)),
            gasFees: userOp.gasFees,
            paymasterAndData: userOp.paymasterAndData,
            signature: userOp.signature,
        };

        // eth_sendUserOperation
        const response = await bundlerProvider.send("eth_sendUserOperation", [
            userOpSerialized,
            entryPointAddress,
        ]);

        if (response && response.error) {
            throw new Error(`Bundler error: ${response.error.message}`);
        }

        // The bundler returns a userOpHash; we need to poll for the tx hash
        const userOpHash = response.result || response;
        console.log(`[Bundler] UserOp accepted: ${userOpHash}`);

        // Poll for inclusion via eth_getUserOperationReceipt
        const txHash = await this.pollUserOperationReceipt(userOpHash);
        return txHash;
    }

    /**
     * Poll the bundler for the UserOperation receipt to get the tx hash.
     */
    async pollUserOperationReceipt(userOpHash) {
        const bundlerProvider = new ethers.JsonRpcProvider(this.bundlerRpcUrl);
        const maxPolls = 120;
        const pollInterval = 3000;

        for (let i = 0; i < maxPolls; i++) {
            try {
                const receipt = await bundlerProvider.send(
                    "eth_getUserOperationReceipt",
                    [userOpHash]
                );

                if (receipt && receipt.result) {
                    if (receipt.result.success === false) {
                        throw new Error(`UserOperation reverted: ${receipt.result.reason}`);
                    }
                    if (receipt.result.transactionHash) {
                        return receipt.result.transactionHash;
                    }
                }

                // Some bundlers return the receipt directly
                if (receipt && receipt.transactionHash) {
                    return receipt.transactionHash;
                }
            } catch (err) {
                if (err.message.includes("reverted")) {
                    throw err;
                }
            }

            await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }

        throw new Error("UserOperation receipt polling timeout");
    }

    // ──────────────────────── Flashbots Methods ────────────────────────

    /**
     * Submit via Flashbots private mempool to avoid front-running.
     * Builds a raw transaction calling EntryPoint.handleOps and sends it
     * through the Flashbots relay.
     */
    async submitViaFlashbots(userOp, entryPointAddress) {
        const flashbotsProvider = new ethers.JsonRpcProvider(this.flashbotsRpcUrl);

        // Build the handleOps call
        const handleOpsData = this.encodeHandleOps([userOp]);

        // Get the latest block for gas estimation
        const latestBlock = await this.provider.getBlock("latest");
        const maxFeePerGas = (latestBlock.baseFeePerGas * 2n) + ethers.parseUnits("2", "gwei");
        const maxPriorityFeePerGas = ethers.parseUnits("2", "gwei");

        // Create the transaction
        const tx = {
            to: entryPointAddress,
            data: handleOpsData,
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: maxPriorityFeePerGas,
            gasLimit: 2000000,
            chainId: latestBlock.chainId,
            type: 2, // EIP-1559
        };

        // Sign the transaction
        const wallet = new ethers.Wallet(settings.relayerPrivateKey || settings.executorPrivateKey);
        const signedTx = await wallet.signTransaction(tx);

        // Submit to Flashbots as a raw transaction
        // Flashbots uses eth_sendPrivateTransaction or the standard eth_sendRawTransaction
        try {
            const result = await flashbotsProvider.send("eth_sendPrivateTransaction", [
                {
                    tx: signedTx,
                    maxBlockNumber: latestBlock.number + 25, // Expires in ~5 minutes
                    preferences: {
                        fast: true,
                        privacy: {
                            hints: ["contract_address", "calldata"],
                        },
                    },
                },
            ]);

            if (result && result.error) {
                throw new Error(`Flashbots error: ${result.error.message}`);
            }

            const txHash = ethers.keccak256(signedTx);
            return txHash;
        } catch (err) {
            // Fall back to standard raw transaction submission through Flashbots relay
            const result = await flashbotsProvider.send("eth_sendRawTransaction", [signedTx]);
            if (result && result.error) {
                throw new Error(`Flashbots raw tx error: ${result.error.message}`);
            }
            const txHash = ethers.keccak256(signedTx);
            return txHash;
        }
    }

    // ──────────────────────── Direct Submission ────────────────────────

    /**
     * Submit directly via standard JSON-RPC (last resort).
     */
    async submitDirect(userOp, entryPointAddress) {
        const wallet = new ethers.Wallet(
            settings.relayerPrivateKey || settings.executorPrivateKey,
            this.provider
        );

        const handleOpsData = this.encodeHandleOps([userOp]);
        const latestBlock = await this.provider.getBlock("latest");
        const maxFeePerGas = (latestBlock.baseFeePerGas * 2n) + ethers.parseUnits("2", "gwei");

        const tx = await wallet.sendTransaction({
            to: entryPointAddress,
            data: handleOpsData,
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
            gasLimit: 2000000,
        });

        return tx.hash;
    }

    // ──────────────────────── Helpers ────────────────────────

    /**
     * Encode the EntryPoint.handleOps calldata.
     * handleOps(UserOperation[] ops, address beneficiary)
     */
    encodeHandleOps(userOps) {
        const entryPointInterface = new ethers.Interface([
            "function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, uint256 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary) external",
        ]);

        const ops = userOps.map((op) => [
            op.sender,
            op.nonce,
            op.initCode,
            op.callData,
            op.accountGasLimits,
            op.preVerificationGas,
            op.gasFees,
            op.paymasterAndData,
            op.signature,
        ]);

        const beneficiary = settings.relayerAddress || settings.ownerWallet;

        return entryPointInterface.encodeFunctionData("handleOps", [ops, beneficiary]);
    }

    /**
     * Estimate gas for a UserOperation via the bundler's estimation methods.
     */
    async estimateUserOperationGas(userOp, entryPointAddress) {
        if (!this.bundlerRpcUrl) {
            return {
                preVerificationGas: 21000,
                verificationGasLimit: 100000,
                callGasLimit: 500000,
            };
        }

        try {
            const bundlerProvider = new ethers.JsonRpcProvider(this.bundlerRpcUrl);
            const result = await bundlerProvider.send("eth_estimateUserOperationGas", [
                {
                    sender: userOp.sender,
                    nonce: userOp.nonce,
                    initCode: userOp.initCode,
                    callData: userOp.callData,
                    accountGasLimits: userOp.accountGasLimits,
                    preVerificationGas: ethers.toQuantity(BigInt(userOp.preVerificationGas)),
                    gasFees: userOp.gasFees,
                    paymasterAndData: userOp.paymasterAndData,
                    signature: userOp.signature,
                },
                entryPointAddress,
            ]);

            const gasEstimate = result.result || result;
            return {
                preVerificationGas: parseInt(gasEstimate.preVerificationGas || "0x5208", 16),
                verificationGasLimit: parseInt(gasEstimate.verificationGasLimit || "0x186A0", 16),
                callGasLimit: parseInt(gasEstimate.callGasLimit || "0x7A120", 16),
            };
        } catch (err) {
            console.warn(`[Bundler] Gas estimation failed, using defaults: ${err.message}`);
            return {
                preVerificationGas: 21000,
                verificationGasLimit: 100000,
                callGasLimit: 500000,
            };
        }
    }

    /**
     * Get supported entry points from the bundler.
     */
    async getSupportedEntryPoints() {
        if (!this.bundlerRpcUrl) return [this.entryPointAddress];

        try {
            const bundlerProvider = new ethers.JsonRpcProvider(this.bundlerRpcUrl);
            const result = await bundlerProvider.send("eth_supportedEntryPoints", []);
            return result.result || result || [this.entryPointAddress];
        } catch (err) {
            console.warn(`[Bundler] Could not get supported entry points: ${err.message}`);
            return [this.entryPointAddress];
        }
    }
}

// ──────────────────────── Module Export ────────────────────────

module.exports = { Bundler, FLASHBOTS_RPC_URLS };

// ──────────────────────── CLI Entry ────────────────────────

if (require.main === module) {
    console.log("[Bundler] Flashbots RPC URL:", new Bundler().flashbotsRpcUrl);
    console.log("[Bundler] Bundler RPC URL:", new Bundler().bundlerRpcUrl || "(not configured)");
    console.log("[Bundler] EntryPoint:", new Bundler().entryPointAddress);
    console.log("[Bundler] Supported entry points:", await new Bundler().getSupportedEntryPoints());
}
