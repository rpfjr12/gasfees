/**
 * hardhat.config.js
 * Gasless Flash-Loan Arbitrage Bot — Hardhat Configuration
 *
 * Supports:
 *   - Solidity compilation (v0.8.20)
 *   - Mainnet and Sepolia deployment
 *   - Etherscan contract verification
 *   - Local fork testing
 */

require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// ──────────────────────── Network Configuration ────────────────────────

const MAINNET_RPC_URL = process.env.RPC_URL || "https://eth-mainnet.public.blastapi.io";
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "https://eth-sepolia.public.blastapi.io";
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || process.env.EXECUTOR_PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

// ──────────────────────── Hardhat Config ────────────────────────

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        version: "0.8.20",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
            viaIR: true,
        },
    },

    networks: {
        hardhat: {
            chainId: 31337,
            // For local fork testing: uncomment and set your RPC
            // forking: {
            //     url: MAINNET_RPC_URL,
            //     blockNumber: 19000000,
            // },
        },
        mainnet: {
            url: MAINNET_RPC_URL,
            chainId: 1,
            accounts: [PRIVATE_KEY],
            gasPrice: "auto",
        },
        sepolia: {
            url: SEPOLIA_RPC_URL,
            chainId: 11155111,
            accounts: [PRIVATE_KEY],
            gasPrice: "auto",
        },
        localhost: {
            url: "http://127.0.0.1:8545",
            chainId: 31337,
        },
    },

    etherscan: {
        apiKey: {
            mainnet: ETHERSCAN_API_KEY,
            sepolia: ETHERSCAN_API_KEY,
        },
    },

    paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts",
    },

    mocha: {
        timeout: 120000,
    },
};
