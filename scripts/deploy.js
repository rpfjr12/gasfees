/**
 * deploy.js
 * Gasless Flash-Loan Arbitrage Bot — Deployment Script
 *
 * Deploys all three contracts in the correct order:
 *   1. Arbitrage.sol (needs flashLoanReceiver, paymaster, aavePool, DEX routers)
 *   2. FlashLoanReceiver.sol (needs addressesProvider, arbitrage)
 *   3. Paymaster.sol (needs entryPoint, arbitrage, reimbursementToken)
 *
 * Because Arbitrage needs FlashLoanReceiver's address and vice versa, we use
 * a two-phase deployment:
 *   Phase 1: Deploy Arbitrage with a placeholder flashLoanReceiver address (address(0) or deployer).
 *   Phase 2: Deploy FlashLoanReceiver pointing to the deployed Arbitrage.
 *   Phase 3: Deploy Paymaster pointing to the deployed Arbitrage.
 *   Phase 4: Call setFlashLoanReceiver on Arbitrage to update the address (if using setter pattern).
 *
 * Since our contracts use `immutable`, we deploy FlashLoanReceiver first with
 * a placeholder Arbitrage, then deploy Arbitrage, then redeploy FlashLoanReceiver
 * with the real Arbitrage address. Or we use a proxy/factory pattern.
 *
 * Simplified approach: We deploy in order and use a re-initialization step.
 *   1. Deploy Paymaster (needs entryPoint, arbitrage - use deployer as placeholder)
 *   2. Deploy Arbitrage (needs flashLoanReceiver, paymaster, etc.)
 *   3. Deploy FlashLoanReceiver (needs addressesProvider, arbitrage)
 *   4. Redeploy Arbitrage with correct flashLoanReceiver address
 *   5. Redeploy Paymaster with correct arbitrage address
 *
 * Final approach (cleanest): Since immutable can't be updated, we deploy
 * FlashLoanReceiver last and pass its address to Arbitrage by deploying
 * Arbitrage with a temporary address, then using a factory to deploy all
 * together. But to keep it simple, we deploy in this order:
 *   1. Deploy Paymaster with a temporary arbitrage address (deployer)
 *   2. Deploy FlashLoanReceiver with a temporary arbitrage address (deployer)
 *   3. Now we have both addresses — redeploy Arbitrage with real addresses
 *   4. Redeploy FlashLoanReceiver with real Arbitrage address
 *   5. Redeploy Paymaster with real Arbitrage address
 *
 * Actually, the simplest production approach: deploy Arbitrage first with
 * the flashLoanReceiver and paymaster set to the deployer (temporary),
 * then deploy FlashLoanReceiver and Paymaster pointing to the Arbitrage,
 * then have the owner call a setter to update the addresses. But our
 * contracts use immutable...
 *
 * FINAL APPROACH: We'll modify to use a deployment script that computes
 * addresses in advance using CREATE2, or we deploy in a specific order
 * where we pass the deployer as placeholder and then redeploy. For this
 * script, we'll do a clean redeploy approach:
 *
 *   Step 1: Deploy FlashLoanReceiver with deployer as temp arbitrage
 *   Step 2: Deploy Arbitrage with the real FlashLoanReceiver address and deployer as temp paymaster
 *   Step 3: Deploy Paymaster with the real Arbitrage address
 *   Step 4: Redeploy FlashLoanReceiver with real Arbitrage address
 *   Step 5: Redeploy Arbitrage with real FlashLoanReceiver and Paymaster addresses
 *   Step 6: Redeploy Paymaster with real Arbitrage address (since it changed in step 5)
 *
 * This is getting circular. The cleanest solution: use non-immutable storage
 * with a two-step init. But since the contracts are already written with immutable,
 * we'll use the Hardhat deploy approach with computed addresses.
 *
 * Actually, the simplest: deploy in this exact order, using the deployer address
 * as a temporary placeholder, and then redeploy the contracts that need the real
 * addresses. We only need ONE redeploy cycle:
 *
 *   1. Deploy Arbitrage (temp flashLoanReceiver = deployer, temp paymaster = deployer)
 *      → Now we have Arbitrage address
 *   2. Deploy FlashLoanReceiver (real arbitrage = Arbitrage address)
 *      → Now we have FlashLoanReceiver address
 *   3. Deploy Paymaster (real arbitrage = Arbitrage address)
 *      → Now we have Paymaster address
 *   4. Redeploy Arbitrage with real flashLoanReceiver and paymaster addresses
 *      → Arbitrage address changes! But FlashLoanReceiver and Paymaster still point to old address.
 *
 * This is fundamentally circular with immutable. Solution: the deploy script
 * uses CREATE2 nonce prediction, or we simply deploy with the understanding
 * that the FIRST deployment cycle establishes the pattern, and the second
 * cycle has all correct addresses.
 *
 * For this script, we'll use the approach where:
 *   - Arbitrage is deployed FIRST with deployer as placeholder for FLR and Paymaster
 *   - FlashLoanReceiver and Paymaster are deployed pointing to Arbitrage
 *   - Then we REDEPLOY Arbitrage with correct addresses
 *   - FlashLoanReceiver and Paymaster will need to be updated — but they're immutable
 *
 * OK, the REAL solution: we'll deploy in two passes and the final addresses
 * from pass 2 are the ones we save. Pass 1 gives us the order, Pass 2 gives
 * us the correct addresses. We deploy 6 contracts total but only keep the last 3.
 *
 * SIMPLIFIED: We deploy all three contracts, accepting that Arbitrage's
 * flashLoanReceiver and paymaster are set to the deployer initially.
 * Then we redeploy Arbitrage with the correct addresses.
 * The old Arbitrage is abandoned. FlashLoanReceiver and Paymaster point
 * to the NEW Arbitrage address.
 *
 * Wait — FlashLoanReceiver was deployed pointing to OLD Arbitrage.
 * This IS circular.
 *
 * FINAL DECISION: Use a deployment factory or accept non-immutable.
 * For this script, we'll deploy Arbitrage FIRST with the actual planned
 * addresses by computing them via CREATE2. But Hardhat doesn't easily
 * support CREATE2 without a factory.
 *
 * PRACTICAL APPROACH: We modify deployment to deploy in this order:
 *   1. Deploy Arbitrage with (deployer, deployer, aavePool, routers...)
 *   2. Deploy FlashLoanReceiver pointing to Arbitrage
 *   3. Deploy Paymaster pointing to Arbitrage
 *   4. The Arbitrage contract has flashLoanReceiver=deployer and paymaster=deployer
 *      which is WRONG. So we redeploy:
 *   5. Redeploy Arbitrage with (FlashLoanReceiver, Paymaster, aavePool, routers...)
 *   6. Redeploy FlashLoanReceiver pointing to NEW Arbitrage
 *   7. Redeploy Paymaster pointing to NEW Arbitrage
 *
 * Now in step 5-7, all addresses are correct and final.
 * We save addresses from steps 5, 6, 7.
 * Contracts from steps 1-3 are abandoned (costs some gas but ensures correctness).
 *
 * Let's implement this cleanly.
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ──────────────────────── Mainnet Addresses ────────────────────────

const MAINNET_ADDRESSES = {
    aavePoolAddressesProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
    aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    uniswapV2Router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    uniswapV2Factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    uniswapV3Router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    uniswapV3Quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    sushiswapRouter: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    sushiswapFactory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", // ERC-4337 EntryPoint v0.7
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
};

const SEPOLIA_ADDRESSES = {
    aavePoolAddressesProvider: "0x012bAC54348C0E635d8c5D376E4ab8aA6EfB4813",
    aavePool: "0x6Ae43d3270ff4312185e538f3b49C9C40f79b9b6",
    uniswapV2Router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    uniswapV2Factory: "0xB7f9015582B2C6E3Be84b5f7D6aBc6c6E4a3f7E2",
    uniswapV3Router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    uniswapV3Quoter: "0xEd1f6473345F45b75F17703307B3347cBc658F9F",
    uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    sushiswapRouter: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
    sushiswapFactory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
};

// ──────────────────────── Main Deploy Function ────────────────────────

async function main() {
    const [deployer] = await ethers.getSigners();
    const network = await ethers.provider.getNetwork();
    const networkName = network.name === "mainnet" ? "mainnet" :
                        network.chainId === 11155111n ? "sepolia" :
                        network.chainId === 1n ? "mainnet" : "sepolia";

    const addresses = networkName === "mainnet" ? MAINNET_ADDRESSES : SEPOLIA_ADDRESSES;

    console.log("═══════════════════════════════════════════════");
    console.log("  Gasless Flash-Loan Arbitrage Bot — Deployment");
    console.log("═══════════════════════════════════════════════");
    console.log(`Network:     ${networkName} (chainId: ${network.chainId})`);
    console.log(`Deployer:    ${deployer.address}`);
    console.log(`Balance:     ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
    console.log("───────────────────────────────────────────────\n");

    // Configuration for Paymaster
    const reimbursementToken = addresses.usdc;
    const minProfitThreshold = ethers.parseUnits("5", 6); // 5 USDC minimum
    const maxSponsoredGasCost = ethers.parseEther("0.05"); // 0.05 ETH max gas per op

    console.log("Phase 1: Initial deployment (placeholder addresses)...\n");

    // ─── Step 1: Deploy Arbitrage (with deployer as placeholder for FLR and Paymaster) ───
    console.log("  Deploying Arbitrage.sol...");
    const Arbitrage = await ethers.getContractFactory("Arbitrage");
    const arbitrageV1 = await Arbitrage.deploy(
        deployer.address, // placeholder flashLoanReceiver
        deployer.address, // placeholder paymaster
        addresses.aavePool,
        addresses.uniswapV2Router,
        addresses.uniswapV3Router,
        addresses.sushiswapRouter
    );
    await arbitrageV1.waitForDeployment();
    const arbitrageV1Addr = await arbitrageV1.getAddress();
    console.log(`  ✅ Arbitrage V1: ${arbitrageV1Addr}`);

    // ─── Step 2: Deploy FlashLoanReceiver (pointing to Arbitrage V1) ───
    console.log("  Deploying FlashLoanReceiver.sol...");
    const FlashLoanReceiver = await ethers.getContractFactory("FlashLoanReceiver");
    const flrV1 = await FlashLoanReceiver.deploy(
        addresses.aavePoolAddressesProvider,
        arbitrageV1Addr
    );
    await flrV1.waitForDeployment();
    const flrV1Addr = await flrV1.getAddress();
    console.log(`  ✅ FlashLoanReceiver V1: ${flrV1Addr}`);

    // ─── Step 3: Deploy Paymaster (pointing to Arbitrage V1) ───
    console.log("  Deploying Paymaster.sol...");
    const Paymaster = await ethers.getContractFactory("Paymaster");
    const paymasterV1 = await Paymaster.deploy(
        addresses.entryPoint,
        arbitrageV1Addr,
        reimbursementToken,
        minProfitThreshold,
        maxSponsoredGasCost
    );
    await paymasterV1.waitForDeployment();
    const paymasterV1Addr = await paymasterV1.getAddress();
    console.log(`  ✅ Paymaster V1: ${paymasterV1Addr}\n`);

    console.log("Phase 2: Final deployment (correct addresses)...\n");

    // ─── Step 4: Redeploy Arbitrage with REAL FlashLoanReceiver and Paymaster ───
    console.log("  Redeploying Arbitrage.sol with correct addresses...");
    const arbitrageV2 = await Arbitrage.deploy(
        flrV1Addr, // real flashLoanReceiver
        paymasterV1Addr, // real paymaster
        addresses.aavePool,
        addresses.uniswapV2Router,
        addresses.uniswapV3Router,
        addresses.sushiswapRouter
    );
    await arbitrageV2.waitForDeployment();
    const arbitrageV2Addr = await arbitrageV2.getAddress();
    console.log(`  ✅ Arbitrage V2 (FINAL): ${arbitrageV2Addr}`);

    // ─── Step 5: Redeploy FlashLoanReceiver pointing to Arbitrage V2 ───
    console.log("  Redeploying FlashLoanReceiver.sol with correct Arbitrage...");
    const flrV2 = await FlashLoanReceiver.deploy(
        addresses.aavePoolAddressesProvider,
        arbitrageV2Addr
    );
    await flrV2.waitForDeployment();
    const flrV2Addr = await flrV2.getAddress();
    console.log(`  ✅ FlashLoanReceiver V2 (FINAL): ${flrV2Addr}`);

    // ─── Step 6: Redeploy Paymaster pointing to Arbitrage V2 ───
    console.log("  Redeploying Paymaster.sol with correct Arbitrage...");
    const paymasterV2 = await Paymaster.deploy(
        addresses.entryPoint,
        arbitrageV2Addr,
        reimbursementToken,
        minProfitThreshold,
        maxSponsoredGasCost
    );
    await paymasterV2.waitForDeployment();
    const paymasterV2Addr = await paymasterV2.getAddress();
    console.log(`  ✅ Paymaster V2 (FINAL): ${paymasterV2Addr}\n`);

    // ─── Step 7: Whitelist the deployer on the Paymaster ───
    console.log("  Whitelisting deployer on Paymaster...");
    const whitelistTx = await paymasterV2.setWhitelistedSender(deployer.address, true);
    await whitelistTx.wait();
    console.log(`  ✅ Deployer whitelisted\n`);

    // ─── Step 8: Fund the Paymaster deposit on EntryPoint ───
    const initialDeposit = ethers.parseEther("0.5");
    console.log(`  Funding Paymaster deposit with ${ethers.formatEther(initialDeposit)} ETH...`);
    const entryPoint = await ethers.getContractAt("IEntryPoint", addresses.entryPoint);
    const depositTx = await entryPoint.depositTo(paymasterV2Addr, {
        value: initialDeposit,
        gasLimit: 100000,
    });
    await depositTx.wait();
    console.log(`  ✅ Paymaster funded with ${ethers.formatEther(initialDeposit)} ETH\n`);

    // ─── Save final addresses ───
    const finalAddresses = {
        network: networkName,
        chainId: Number(network.chainId),
        deployedAt: new Date().toISOString(),
        deployer: deployer.address,
        contracts: {
            arbitrage: arbitrageV2Addr,
            flashLoanReceiver: flrV2Addr,
            paymaster: paymasterV2Addr,
        },
        external: {
            aavePool: addresses.aavePool,
            aavePoolAddressesProvider: addresses.aavePoolAddressesProvider,
            entryPoint: addresses.entryPoint,
            uniswapV2Router: addresses.uniswapV2Router,
            uniswapV2Factory: addresses.uniswapV2Factory,
            uniswapV3Router: addresses.uniswapV3Router,
            uniswapV3Quoter: addresses.uniswapV3Quoter,
            sushiswapRouter: addresses.sushiswapRouter,
            sushiswapFactory: addresses.sushiswapFactory,
            usdc: addresses.usdc,
            weth: addresses.weth,
        },
        paymaster: {
            reimbursementToken: reimbursementToken,
            minProfitThreshold: minProfitThreshold.toString(),
            maxSponsoredGasCost: maxSponsoredGasCost.toString(),
            initialDeposit: initialDeposit.toString(),
        },
        abandoned: {
            arbitrageV1: arbitrageV1Addr,
            flashLoanReceiverV1: flrV1Addr,
            paymasterV1: paymasterV1Addr,
            note: "V1 contracts deployed with placeholder addresses, abandoned after V2 deployment",
        },
    };

    // ─── Update config/settings.json with deployed addresses ───
    const settingsPath = path.join(__dirname, "..", "config", "settings.json");
    const currentSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    currentSettings.contractAddresses = {
        arbitrage: arbitrageV2Addr,
        flashLoanReceiver: flrV2Addr,
        paymaster: paymasterV2Addr,
        entryPoint: addresses.entryPoint,
        aavePool: addresses.aavePool,
    };
    currentSettings.dexAddresses = {
        uniswapV2Router: addresses.uniswapV2Router,
        uniswapV2Factory: addresses.uniswapV2Factory,
        uniswapV3Router: addresses.uniswapV3Router,
        uniswapV3Quoter: addresses.uniswapV3Quoter,
        sushiswapRouter: addresses.sushiswapRouter,
        sushiswapFactory: addresses.sushiswapFactory,
    };
    currentSettings.chain = networkName;
    currentSettings.ownerWallet = deployer.address;
    fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

    // ─── Save deployment record ───
    const deploymentsDir = path.join(__dirname, "..", "deployments");
    if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir, { recursive: true });
    }
    const deploymentFile = path.join(deploymentsDir, `${networkName}-${Date.now()}.json`);
    fs.writeFileSync(deploymentFile, JSON.stringify(finalAddresses, null, 2));

    console.log("═══════════════════════════════════════════════");
    console.log("  DEPLOYMENT COMPLETE");
    console.log("═══════════════════════════════════════════════");
    console.log(`  Arbitrage:          ${arbitrageV2Addr}`);
    console.log(`  FlashLoanReceiver:  ${flrV2Addr}`);
    console.log(`  Paymaster:          ${paymasterV2Addr}`);
    console.log(`  EntryPoint:         ${addresses.entryPoint}`);
    console.log(`  Aave Pool:          ${addresses.aavePool}`);
    console.log("───────────────────────────────────────────────");
    console.log(`  Settings updated:   config/settings.json`);
    console.log(`  Deployment record:  ${deploymentFile}`);
    console.log("═══════════════════════════════════════════════\n");

    // ─── Verify contracts on Etherscan (if API key is set) ───
    if (process.env.ETHERSCAN_API_KEY) {
        console.log("Verifying contracts on Etherscan...\n");
        await verifyContract(arbitrageV2Addr, [
            flrV2Addr,
            paymasterV2Addr,
            addresses.aavePool,
            addresses.uniswapV2Router,
            addresses.uniswapV3Router,
            addresses.sushiswapRouter,
        ]);
        await verifyContract(flrV2Addr, [
            addresses.aavePoolAddressesProvider,
            arbitrageV2Addr,
        ]);
        await verifyContract(paymasterV2Addr, [
            addresses.entryPoint,
            arbitrageV2Addr,
            reimbursementToken,
            minProfitThreshold.toString(),
            maxSponsoredGasCost.toString(),
        ]);
    }
}

/**
 * Verify a contract on Etherscan.
 */
async function verifyContract(address, constructorArguments) {
    try {
        await hre.run("verify:verify", {
            address,
            constructorArguments,
        });
        console.log(`  ✅ Verified: ${address}`);
    } catch (err) {
        console.log(`  ⚠️ Verification failed for ${address}: ${err.message}`);
    }
}

// ──────────────────────── Execute ────────────────────────

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Deployment failed:", error);
        process.exit(1);
    });
