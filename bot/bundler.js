/**
 * bundler.js — Clean Rewrite (Syntax‑Safe)
 */

const { ethers } = require("ethers");
const settings = require("../config/settings.json");

// Flashbots RPC map
const FLASHBOTS_RPC_URLS = {
    mainnet: "https://rpc.flashbots.net",
    goerli: "https://rpc-goerli.flashbots.net",
    sepolia: "https://rpc-sepolia.flashbots.net",
};

class Bundler {
    constructor(rpcUrl) {
        this.provider = new ethers.JsonRpcProvider(rpcUrl || settings.rpcUrl);
        this.bundlerRpcUrl = settings.bundlerRpcUrl || "";
        this.flashbotsRpcUrl = this.getFlashbotsUrl();
        this.entryPointAddress = settings.contractAddresses.entryPoint;
        this.maxRetries = 3;
        this.retryDelayMs = 2000;
    }

    getFlashbotsUrl() {
        if (settings.flashbotsRpcUrl) return settings.flashbotsRpcUrl;
        const chain = settings.chain || "mainnet";
        return FLASHBOTS_RPC_URLS[chain] || FLASHBOTS_RPC_URLS.mainnet;
    }

    async submitUserOperation(userOp, entryPointAddress) {
        if (this.bundlerRpcUrl) {
            try {
                const txHash = await this.submitViaBundlerRPC(userOp, entryPointAddress);
                if (txHash) {
                    console.log("[Bundler] Submitted via ERC‑4337 bundler:", txHash);
                    return txHash;
                }
            } catch (err) {
                console.warn("[Bundler] Bundler RPC failed:", err.message);
            }
        }

        try {
            const txHash = await this.submitViaFlashbots(userOp, entryPointAddress);
            if (txHash) {
                console.log("[Bundler] Submitted via Flashbots:", txHash);
                return txHash;
            }
        } catch (err) {
            console.warn("[Bundler] Flashbots failed:", err.message);
        }

        console.log("[Bundler] Falling back to direct submission...");
        const txHash = await this.submitDirect(userOp, entryPointAddress);
        console.log("[Bundler] Direct submission:", txHash);
        return txHash;
    }

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

        const response = await bundlerProvider.send("eth_sendUserOperation", [
            userOpSerialized,
            entryPointAddress,
        ]);

        if (response?.error) throw new Error(response.error.message);

        const userOpHash = response.result || response;
        console.log("[Bundler] UserOp accepted:", userOpHash);

        return await this.pollUserOperationReceipt(userOpHash);
    }

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

                if (receipt?.result?.transactionHash) {
                    return receipt.result.transactionHash;
                }

                if (receipt?.transactionHash) {
                    return receipt.transactionHash;
                }
            } catch (err) {
                if (err.message.includes("reverted")) throw err;
            }

            await new Promise((r) => setTimeout(r, pollInterval));
        }

        throw new Error("UserOperation receipt polling timeout");
    }

    async submitViaFlashbots(userOp, entryPointAddress) {
        const flashbotsProvider = new ethers.JsonRpcProvider(this.flashbotsRpcUrl);
        const handleOpsData = this.encodeHandleOps([userOp]);

        const latestBlock = await this.provider.getBlock("latest");
        const maxFeePerGas =
            latestBlock.baseFeePerGas * 2n + ethers.parseUnits("2", "gwei");

        const tx = {
            to: entryPointAddress,
            data: handleOpsData,
            maxFeePerGas,
            maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
            gasLimit: 2000000,
            chainId: latestBlock.chainId,
            type: 2,
        };

        const wallet = new ethers.Wallet(
            settings.relayerPrivateKey || settings.executorPrivateKey
        );

        const signedTx = await wallet.signTransaction(tx);

        try {
            const result = await flashbotsProvider.send("eth_sendPrivateTransaction", [
                {
                    tx: signedTx,
                    maxBlockNumber: latestBlock.number + 25,
                    preferences: {
                        fast: true,
                        privacy: { hints: ["contract_address", "calldata"] },
                    },
                },
            ]);

            if (result?.error) throw new Error(result.error.message);

            return ethers.keccak256(signedTx);
        } catch {
            const result = await flashbotsProvider.send("eth_sendRawTransaction", [
                signedTx,
            ]);

            if (result?.error) throw new Error(result.error.message);

            return ethers.keccak256(signedTx);
        }
    }

    async submitDirect(userOp, entryPointAddress) {
        const wallet = new ethers.Wallet(
            settings.relayerPrivateKey || settings.executorPrivateKey,
            this.provider
        );

        const handleOpsData = this.encodeHandleOps([userOp]);
        const latestBlock = await this.provider.getBlock("latest");

        const tx = await wallet.sendTransaction({
            to: entryPointAddress,
            data: handleOpsData,
            maxFeePerGas:
                latestBlock.baseFeePerGas * 2n + ethers.parseUnits("2", "gwei"),
            maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
            gasLimit: 2000000,
        });

        return tx.hash;
    }

    encodeHandleOps(userOps) {
        const entryPointInterface = new ethers.Interface([
            "function handleOps(tuple(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,uint256 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)",
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

            const gas = result.result || result;

            return {
                preVerificationGas: parseInt(gas.preVerificationGas || "0x5208", 16),
                verificationGasLimit: parseInt(gas.verificationGasLimit || "0x186A0", 16),
                callGasLimit: parseInt(gas.callGasLimit || "0x7A120", 16),
            };
        } catch (err) {
            console.warn("[Bundler] Gas estimation failed:", err.message);
            return {
                preVerificationGas: 21000,
                verificationGasLimit: 100000,
                callGasLimit: 500000,
            };
        }
    }

    async getSupportedEntryPoints() {
        if (!this.bundlerRpcUrl) return [this.entryPointAddress];

        try {
            const bundlerProvider = new ethers.JsonRpcProvider(this.bundlerRpcUrl);
            const result = await bundlerProvider.send("eth_supportedEntryPoints", []);
            return result.result || result || [this.entryPointAddress];
        } catch (err) {
            console.warn("[Bundler] Could not get supported entry points:", err.message);
            return [this.entryPointAddress];
        }
    }
}

module.exports = { Bundler, FLASHBOTS_RPC_URLS };

// CLI
if (require.main === module) {
    const b = new Bundler();
    console.log("[Bundler] Flashbots RPC URL:", b.flashbotsRpcUrl);
    console.log("[Bundler] Bundler RPC URL:", b.bundlerRpcUrl || "(not configured)");
    console.log("[Bundler] EntryPoint:", b.entryPointAddress);

    (async () => {
        const eps = await b.getSupportedEntryPoints();
        console.log("[Bundler] Supported entry points:", eps);
    })();
}
