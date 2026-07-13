# Gasless Flash-Loan Arbitrage Bot

A production-ready Ethereum arbitrage bot that uses **Aave V3 flash loans** for capital, **ERC-4337 paymaster** for zero-gas execution, **off-chain simulation** for profit verification, and **Flashbots private mempool** for front-running protection.

All profit is routed to your wallet. You pay zero gas.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Repository Structure](#repository-structure)
- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Running the Bot](#running-the-bot)
- [Profit Routing](#profit-routing)
- [Contract Documentation](#contract-documentation)
- [Bot Module Documentation](#bot-module-documentation)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Security Considerations](#security-considerations)
- [License](#license)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        OFF-CHAIN (Bot)                               │
│                                                                      │
│  ┌──────────┐    ┌────────────┐    ┌──────────┐    ┌──────────────┐ │
│  │ Scanner  │───▶│ Simulator  │───▶│ Relayer  │───▶│   Executor   │ │
│  │          │    │            │    │  (Gate)  │    │              │ │
│  │ Scans    │    │ Simulates  │    │ Verifies │    │ Builds &     │ │
│  │ DEX      │    │ profit,    │    │ profit,  │    │ signs UserOp │ │
│  │ prices   │    │ gas, fees  │    │ deposit  │    │              │ │
│  └──────────┘    └────────────┘    └──────────┘    └──────┬───────┘ │
│                                                           │         │
│                                              ┌────────────▼───────┐ │
│                                              │     Bundler        │ │
│                                              │                    │ │
│                                              │ ERC-4337 Bundler   │ │
│                                              │    + Flashbots     │ │
│                                              └────────────┬───────┘ │
└───────────────────────────────────────────────────────────┼─────────┘
                                                            │
┌───────────────────────────────────────────────────────────┼─────────┐
│                        ON-CHAIN (Ethereum)                │         │
│                                                           ▼         │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────────┐  │
│  │  EntryPoint  │───▶│    Paymaster     │    │  FlashLoanReceiver│  │
│  │  (ERC-4337)  │    │                  │    │                   │  │
│  │              │    │ Sponsors gas     │    │ Aave V3 callback  │  │
│  │ Verifies     │    │ Validates profit │    │ Triggers arbitrage│  │
│  │ UserOps      │    │ Reimburses self  │    └────────┬──────────┘  │
│  └──────────────┘    └──────────────────┘             │             │
│                                                        ▼             │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      Arbitrage                                │   │
│  │                                                               │   │
│  │  1. Swap on DEX A (buy low)                                   │   │
│  │  2. Swap on DEX B (sell high)                                 │   │
│  │  3. Repay flash loan (amount + 0.05% premium)                │   │
│  │  4. Reimburse Paymaster for gas                               │   │
│  │  5. Send remaining profit to owner wallet                     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ Aave V3 │  │ Uniswap  │  │ Uniswap  │  │ SushiSwap│            │
│  │  Pool   │  │    V2    │  │    V3    │  │          │            │
│  └─────────┘  └──────────┘  └──────────┘  └──────────┘            │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Design Principles

1. **Zero gas for the user** — The ERC-4337 Paymaster sponsors all gas costs. The user never holds ETH for gas.
2. **Full atomic execution** — The entire arbitrage (borrow → swap → swap → repay → distribute) happens in a single transaction. If any step fails, everything reverts.
3. **Off-chain simulation** — The bot simulates the full transaction before submitting, computing exact gas costs, flash loan premiums, and net profit.
4. **Flashbots protection** — Transactions are submitted through Flashbots private mempool, preventing front-running and MEV extraction.
5. **Self-sustaining paymaster** — The Paymaster is reimbursed from arbitrage profits within the same atomic transaction, creating a sustainable gas-sponsorship loop.

---

## Repository Structure

```
gasless-flashloan-arbitrage-bot/
│
├── contracts/                        # Solidity smart contracts
│   ├── interfaces/
│   │   ├── IAaveV3.sol               # Aave V3 flash loan interfaces
│   │   ├── IDEX.sol                  # Uniswap V2/V3, SushiSwap interfaces
│   │   └── IERC4337.sol              # ERC-4337 EntryPoint + Paymaster interfaces
│   ├── Arbitrage.sol                 # Core arbitrage execution logic
│   ├── FlashLoanReceiver.sol         # Aave V3 flash loan receiver
│   └── Paymaster.sol                 # ERC-4337 gas sponsor
│
├── bot/                              # Off-chain bot modules (Node.js)
│   ├── scanner.js                    # DEX price scanner
│   ├── simulator.js                  # Off-chain profit simulator
│   ├── executor.js                   # Meta-transaction builder & signer
│   ├── bundler.js                    # ERC-4337 bundler + Flashbots submitter
│   └── relayer.js                    # Gas-paying relayer with profit gating
│
├── scripts/                          # Deployment & automation scripts
│   ├── deploy.js                     # Deploy all contracts
│   ├── test.js                       # Full simulation test
│   └── runArbitrage.js               # Main orchestrator (scanner → simulator → executor)
│
├── config/
│   └── settings.json                 # Bot configuration (pairs, thresholds, addresses)
│
├── hardhat.config.js                 # Hardhat configuration
├── package.json                      # Node.js dependencies
├── .env.example                      # Environment variable template
├── .gitignore
└── README.md                         # This file
```

---

## How It Works

### Step-by-step execution flow

1. **Scanner** polls Uniswap V2, Uniswap V3, and SushiSwap for token prices on configured pairs.
2. When a price discrepancy exceeds the minimum profit percentage, an **opportunity** is emitted.
3. **Simulator** takes the opportunity and:
   - Simulates both swaps using on-chain `eth_call` / quoter contracts
   - Computes the Aave flash loan premium (0.05%)
   - Estimates gas cost using EIP-1559 fee data
   - Computes paymaster reimbursement (10% of gross profit)
   - Calculates net profit after all costs
   - Returns a **go/no-go** decision
4. **Relayer** acts as a gatekeeper — it only relays if:
   - Simulation says `shouldExecute: true`
   - Net profit is positive
   - Paymaster deposit is sufficient
   - Profit exceeds the paymaster's minimum threshold
5. **Executor** builds the ERC-4337 UserOperation:
   - Encodes the flash loan + arbitrage calldata
   - Packs gas limits and fees
   - Builds `paymasterAndData` with profit/cost data
   - Signs the UserOperation
   - Verifies paymaster will sponsor
6. **Bundler** submits the signed UserOperation:
   - First tries the ERC-4337 bundler RPC (Stackup/Alchemy/Pimlico)
   - Falls back to Flashbots private mempool
   - Final fallback: direct on-chain submission
7. On-chain, the **EntryPoint** calls the **Paymaster** to validate, then executes the **FlashLoanReceiver** which triggers the **Arbitrage** contract.
8. **Arbitrage** contract executes atomically:
   - Borrows from Aave (already done by this point)
   - Swaps on DEX A (buy low)
   - Swaps on DEX B (sell high)
   - Repays flash loan (amount + premium)
   - Reimburses Paymaster for gas
   - Sends all remaining profit to the owner wallet

---

## Prerequisites

- **Node.js** v18 or later
- **npm** or **yarn**
- An Ethereum wallet with:
  - ETH for contract deployment (~0.1 ETH on Sepolia, more on mainnet)
  - ETH for the relayer/paymaster deposit (~0.5–1 ETH)
- An RPC endpoint (Alchemy, Infura, Blast API, or your own node)
- Optional: Flashbots relay access, ERC-4337 bundler account

---

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/gasless-flashloan-arbitrage-bot.git
cd gasless-flashloan-arbitrage-bot

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your values
nano .env
```

---

## Configuration

### Environment Variables (`.env`)

| Variable | Description | Required |
|---|---|---|
| `RPC_URL` | Ethereum RPC endpoint | ✅ |
| `SEPOLIA_RPC_URL` | Sepolia testnet RPC (for testnet deployment) | Optional |
| `DEPLOYER_PRIVATE_KEY` | Private key for contract deployment (owner) | ✅ |
| `EXECUTOR_PRIVATE_KEY` | Private key for signing UserOperations | ✅ |
| `RELAYER_PRIVATE_KEY` | Private key for gas-paying (paymaster funder) | ✅ |
| `RELAYER_ADDRESS` | Relayer wallet address | Optional |
| `BUNDLER_RPC_URL` | ERC-4337 bundler RPC endpoint | Recommended |
| `FLASHBOTS_RPC_URL` | Flashbots private mempool endpoint | Recommended |
| `ETHERSCAN_API_KEY` | Etherscan API key for contract verification | Optional |

> **Security**: Never commit your `.env` file. The `.gitignore` already excludes it.

### Settings File (`config/settings.json`)

| Setting | Description | Default |
|---|---|---|
| `chain` | Target blockchain network | `"sepolia"` |
| `rpcUrl` | Fallback RPC URL | Sepolia public RPC |
| `scanIntervalMs` | Time between scans (milliseconds) | `10000` |
| `minProfitPct` | Minimum profit percentage to trigger | `0.5` |
| `minProfitThresholdUsd` | Minimum profit in USD | `"5"` |
| `minNetProfitUsd` | Minimum net profit after all costs | `"2"` |
| `tradeSizeUsd` | Default trade size in USD | `"10000"` |
| `paymasterReimbursementBps` | Paymaster reimbursement (bps of profit) | `1000` (10%) |
| `relayerMinDepositEth` | Minimum paymaster deposit before top-up | `"0.5"` |
| `relayerTopUpAmountEth` | Amount to top up paymaster deposit | `"1.0"` |
| `tokenPairs` | Array of token pairs to monitor | 6 pairs (see file) |

### Adding Custom Token Pairs

Edit `config/settings.json` → `tokenPairs`:

```json
{
  "label": "UNI/WETH",
  "tokenA": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  "tokenB": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "decimalsA": 18,
  "decimalsB": 18
}
```

---

## Deployment

### 1. Compile Contracts

```bash
npm run compile
```

### 2. Deploy to Sepolia (Testnet)

```bash
npm run deploy:sepolia
```

### 3. Deploy to Mainnet

```bash
npm run deploy:mainnet
```

### Deployment Output

The deploy script:
1. Deploys all three contracts in the correct order (handling the circular `immutable` dependency by deploying in two phases).
2. Whitelists the deployer address on the Paymaster.
3. Funds the Paymaster deposit on the EntryPoint with 0.5 ETH.
4. Saves contract addresses to `config/settings.json`.
5. Saves a deployment record to `deployments/<network>-<timestamp>.json`.
6. Verifies contracts on Etherscan (if `ETHERSCAN_API_KEY` is set).

### Deployment Record

After deployment, check `deployments/` for a JSON file with all addresses:

```json
{
  "network": "sepolia",
  "contracts": {
    "arbitrage": "0x...",
    "flashLoanReceiver": "0x...",
    "paymaster": "0x..."
  }
}
```

---

## Running the Bot

### Dry Run (Scan + Simulate, No Execution)

Test the scanner and simulator without sending transactions:

```bash
npm run run:dry
```

### Single Scan Cycle

Run one complete scan-simulate-execute cycle:

```bash
npm run run:once
```

### Continuous Mode (Mainnet)

Run the bot continuously, scanning every 10 seconds:

```bash
npm run run:mainnet
```

### Continuous Mode (Sepolia)

```bash
npm run run:sepolia
```

### Price Scanner Only

Run just the price scanner to monitor DEX prices:

```bash
npm run scan
```

### Command-Line Options

| Flag | Description |
|---|---|
| `--dry-run` | Scan and simulate only; do not execute transactions |
| `--once` | Run a single scan cycle and exit |

---

## Profit Routing

Profit flows through the system as follows:

```
Flash Loan (Aave V3)
    │
    ▼
Swap on DEX A (buy low)
    │
    ▼
Swap on DEX B (sell high)
    │
    ▼
Repay Flash Loan (amount + 0.05% premium)
    │
    ▼
┌─────────────────────────────────────────┐
│         Remaining Profit                │
│                                         │
│  ┌─────────────────┐  ┌──────────────┐ │
│  │ Paymaster       │  │ Owner Wallet │ │
│  │ Reimbursement   │  │ (Your Wallet)│ │
│  │ (10% of profit) │  │ (90% of profit)│
│  └─────────────────┘  └──────────────┘ │
└─────────────────────────────────────────┘
```

- **Flash loan premium**: 0.05% of borrowed amount (Aave V3 standard)
- **Paymaster reimbursement**: 10% of gross profit (configurable via `paymasterReimbursementBps`)
- **Your wallet**: Receives 100% of the remaining profit after loan repayment and paymaster reimbursement
- **Gas**: Paid by the Paymaster from its EntryPoint deposit, reimbursed from profit

### Adjusting Profit Splits

Edit `config/settings.json`:

```json
{
  "paymasterReimbursementBps": 500   // 5% instead of 10%
}
```

---

## Contract Documentation

### Arbitrage.sol

The core arbitrage execution contract. Called by `FlashLoanReceiver` during the flash loan callback.

**Key Functions:**
- `executeArbitrage(asset, amount, premium, params)` — Called by FlashLoanReceiver. Executes the full arbitrage path, repays the loan, reimburses the paymaster, sends profit to owner.
- `rescueTokens(token, to, amount)` — Emergency token rescue (owner only).

**ArbitrageParams struct:**
| Field | Type | Description |
|---|---|---|
| `dexA` | `uint8` | DEX ID for first swap (0=UniV2, 1=UniV3, 2=Sushi) |
| `dexB` | `uint8` | DEX ID for second swap |
| `buyPath` | `address[]` | Token path for first swap |
| `sellPath` | `address[]` | Token path for second swap |
| `minAmountOutA` | `uint256` | Minimum output for swap A (slippage) |
| `minAmountOutB` | `uint256` | Minimum output for swap B (slippage) |

### FlashLoanReceiver.sol

Implements Aave V3's `IFlashLoanSimpleReceiver` interface. Acts as the entry point for flash loan operations.

**Key Functions:**
- `requestFlashLoan(asset, amount, params)` — Initiates a flash loan from Aave V3. Owner only.
- `executeOperation(...)` — Aave callback. Delegates to Arbitrage contract. Pool only.
- `rescueTokens(token, to, amount)` — Emergency token rescue (owner only).

### Paymaster.sol

ERC-4337 Paymaster that sponsors gas for the user's arbitrage operations.

**Key Functions:**
- `validatePaymasterUserOp(userOp, userOpHash, maxCost)` — Validates the UserOperation (sender whitelist, profit threshold, gas limit). Called by EntryPoint.
- `postOp(mode, context, actualGasCost)` — Called after execution. Logs results and tracks reimbursements.
- `addDeposit()` — Fund the paymaster deposit with ETH (owner only).
- `withdrawTo(to, amount)` — Withdraw ETH from the deposit (owner only).
- `setWhitelistedSender(sender, status)` — Add/remove sender from whitelist (owner only).
- `setMinProfitThreshold(threshold)` — Update minimum profit threshold (owner only).
- `setMaxSponsoredGasCost(maxCost)` — Update maximum gas cost per operation (owner only).

---

## Bot Module Documentation

### scanner.js

Continuously polls DEX prices using on-chain reserves and quoter contracts. Supports Uniswap V2 (constant product formula), Uniswap V3 (Quoter contract with multiple fee tiers), and SushiSwap.

**Class:** `Scanner`
- `new Scanner(rpcUrl)` — Create a scanner instance.
- `scanner.onOpportunity(callback)` — Register a callback for detected opportunities.
- `scanner.start()` — Begin continuous scanning.
- `scanner.getPricesAcrossDEXes(pair)` — Get prices for a pair across all DEXes.
- `scanner.getPriceSnapshot()` — Get a one-time price snapshot for all pairs.

### simulator.js

Simulates the full arbitrage transaction off-chain using `eth_call` and quoter contracts. Computes exact costs and profit.

**Class:** `Simulator`
- `new Simulator(rpcUrl)` — Create a simulator instance.
- `simulator.simulate(opportunity)` — Run full simulation. Returns `{ shouldExecute, netProfit, gasEstimate, ... }`.
- `simulator.simulateSwap(dexId, tokenIn, tokenOut, amountIn)` — Simulate a single swap.
- `simulator.estimateGas(opportunity)` — Estimate gas for the full transaction.
- `simulator.buildArbitrageParams(opportunity)` — Build the on-chain params struct.

### executor.js

Builds and signs ERC-4337 UserOperations. Handles gas estimation, fee packing, and paymaster data encoding.

**Class:** `Executor`
- `new Executor(rpcUrl, privateKey)` — Create an executor instance.
- `executor.execute(simulation)` — Build, sign, and submit a UserOperation for a verified opportunity.
- `executor.encodeFlashLoanCall(opportunity, simulation)` — Encode the flash loan calldata.
- `executor.buildPaymasterAndData(simulation)` — Build the paymasterAndData field.

### bundler.js

Handles submission through ERC-4337 bundler RPC and Flashbots private mempool.

**Class:** `Bundler`
- `new Bundler(rpcUrl)` — Create a bundler instance.
- `bundler.submitUserOperation(userOp, entryPointAddress)` — Submit via bundler RPC → Flashbots → direct (fallback chain).
- `bundler.estimateUserOperationGas(userOp, entryPointAddress)` — Estimate gas via bundler RPC.
- `bundler.getSupportedEntryPoints()` — Get supported EntryPoint addresses from the bundler.

### relayer.js

Manages the gas-paying wallet. Monitors paymaster deposit balance and only relays when profitable.

**Class:** `Relayer`
- `new Relayer(rpcUrl, privateKey)` — Create a relayer instance.
- `relayer.startMonitoring()` — Start paymaster deposit monitoring.
- `relayer.relayIfProfitable(simulation, executeFn)` — Gatekeeper: only relays if all checks pass.
- `relayer.checkAndTopUpDeposit()` — Check and top up paymaster deposit.
- `relayer.setWhitelistedSender(sender, status)` — Whitelist a sender on the paymaster.
- `relayer.getStatus()` — Get relayer status summary.

---

## Testing

### Full Simulation Test

Run a complete scan + simulate cycle without executing on-chain:

```bash
# Local Hardhat network (forks mainnet if configured)
npm run test:sim

# Mainnet
npm run test:mainnet

# Sepolia
npm run test:sepolia
```

The test script will:
1. Scan all configured token pairs across all DEXes
2. Detect arbitrage opportunities
3. Simulate each opportunity (gas, fees, profit)
4. Check contract integration (owner, links, paymaster deposit)
5. Print a detailed summary report

### Local Fork Testing

To test against a mainnet fork locally:

1. Edit `hardhat.config.js` and uncomment the `forking` section with your RPC URL.
2. Start a local Hardhat node:
   ```bash
   npx hardhat node
   ```
3. In another terminal, deploy:
   ```bash
   npm run deploy:localhost
   ```
4. Run the test:
   ```bash
   npx hardhat run scripts/test.js --network localhost
   ```

### Contract Compilation Test

Verify all contracts compile without errors:

```bash
npm run compile
```

---

## Troubleshooting

### Common Issues

#### 1. "insufficient funds for gas" on deployment

The deployer wallet needs ETH for gas. On Sepolia, get test ETH from a faucet:
- https://sepoliafaucet.com
- https://www.alchemy.com/faucets/ethereum-sepolia

#### 2. "FlashLoanReceiver: pool not repaid"

This means the arbitrage wasn't profitable enough to cover the flash loan repayment. The simulator should catch this before execution. If it happens:
- Increase `minProfitPct` in settings.json
- Decrease `tradeSizeUsd` to reduce flash loan premium
- Check that DEX liquidity is sufficient for your trade size

#### 3. "Paymaster: sender not whitelisted"

The sender address (executor wallet) must be whitelisted on the Paymaster. Run:
```javascript
// In Hardhat console
const paymaster = await ethers.getContractAt("Paymaster", "PAYMASTER_ADDRESS");
await paymaster.setWhitelistedSender("YOUR_ADDRESS", true);
```

#### 4. "Paymaster: gas cost exceeds limit"

The gas cost for the operation exceeds `maxSponsoredGasCost`. Either:
- Increase `maxSponsoredGasCost` on the Paymaster contract
- Optimize the arbitrage path (fewer hops)
- Wait for lower gas prices

#### 5. "Paymaster: profit below threshold"

The expected profit doesn't meet the `minProfitThreshold`. Either:
- Lower the threshold via `paymaster.setMinProfitThreshold(newThreshold)`
- Wait for better arbitrage opportunities
- Increase `tradeSizeUsd` for larger absolute profits

#### 6. Flashbots submission not working

Flashbots operates differently from standard RPCs:
- Mainnet: Use `https://rpc.flashbots.net`
- Sepolia: Use `https://rpc-sepolia.flashbots.net`
- Transactions may take several blocks to be included
- Flashbots doesn't guarantee inclusion — it only guarantees privacy

#### 7. Bundler RPC errors

If the ERC-4337 bundler fails, the system automatically falls back to Flashbots, then to direct on-chain submission. Common bundler issues:
- Invalid UserOperation format — check gas limits and fee packing
- Unsupported EntryPoint — verify the bundler supports your EntryPoint version
- Rate limiting — reduce scan frequency

#### 8. "Caller is not pool" error

The `executeOperation` function can only be called by the Aave Pool. If you see this error, someone is trying to call the flash loan callback directly. This should never happen in normal operation.

#### 9. Arbitrage always reverts on-chain but simulates as profitable

This usually indicates slippage. The `minAmountOut` values in the calldata may be too strict or too loose. In production:
- Set `minAmountOutA` and `minAmountOutB` with appropriate slippage tolerance (e.g., 0.5%)
- The simulator should encode these values based on simulated outputs minus slippage buffer

#### 10. Paymaster deposit running out

The relayer monitors the deposit and tops it up automatically. If it runs out:
- Check relayer wallet ETH balance
- Increase `relayerTopUpAmountEth` in settings.json
- Monitor the paymaster deposit manually: `paymaster.getDeposit()`

---

## Security Considerations

### Smart Contract Security

1. **Access Control**: All admin functions are gated by `onlyOwner`. The `executeArbitrage` function is gated by `onlyFlashLoanReceiver`. The Paymaster functions are gated by `onlyEntryPoint`.

2. **Reentrancy Protection**: The atomic nature of flash loans means the entire operation completes in one transaction. The Aave Pool verifies repayment before finalizing.

3. **Slippage Protection**: `minAmountOut` parameters in `ArbitrageParams` protect against sandwich attacks. Always set these to reasonable values based on simulation.

4. **Immutable Addresses**: Critical contract addresses (flashLoanReceiver, paymaster, aavePool, DEX routers) are `immutable`, preventing post-deployment modification.

### Operational Security

1. **Private Keys**: Never expose private keys. Use environment variables. The `.gitignore` excludes `.env`.

2. **Whitelist**: Only whitelisted addresses can use the Paymaster. Add your executor address after deployment.

3. **Flashbots**: Using Flashbots private mempool prevents front-running and sandwich attacks.

4. **Gas Limits**: The Paymaster enforces `maxSponsoredGasCost` to prevent gas griefing attacks.

5. **Audit**: Before mainnet deployment with significant capital, have the contracts professionally audited.

### Known Risks

- **DEX liquidity changes**: Prices can shift between simulation and execution. The `minAmountOut` slippage parameters protect against this.
- **Flash loan availability**: Aave V3 may pause flash loans during emergencies. The transaction will revert safely.
- **EntryPoint upgrades**: If the ERC-4337 EntryPoint is upgraded, the Paymaster address must be updated (requires contract redeployment since it's immutable).
- **Network congestion**: High gas prices reduce profitability. The simulator accounts for current gas prices in its decision.

---

## License

MIT License — see the SPDX license identifier in each Solidity file.

---

## Disclaimer

This software is for educational and research purposes. Arbitrage trading carries financial risk. Flash loans can result in loss if transactions revert (you lose gas fees). Always test on testnet first. The authors are not responsible for any financial losses.
