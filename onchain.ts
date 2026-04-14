import { createPublicClient, http, isAddress, parseAbi } from 'viem'
import { base, mainnet } from 'viem/chains'
import type { OnChainHistory } from './types'

// x402 payments settle as USDC transfers on Base
// We scan for Transfer events to/from the x402 facilitator
const X402_FACILITATOR = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001' // x402ExactPermit2Proxy — same address on all EVM chains

const ERC20_TRANSFER_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)'
])

const ethClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_URL ?? 'https://ethereum.publicnode.com')
})

const baseClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL ?? 'https://base.publicnode.com')
})

// USDC on Base
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`

export async function getOnChainHistory(address: string): Promise<OnChainHistory> {
  if (!isAddress(address)) throw new Error(`Invalid address: ${address}`)

  if (process.env.MOCK_MODE === 'true') {
    return mockHistory(address)
  }

  try {
    const [ethHistory, baseHistory] = await Promise.allSettled([
      getEthHistory(address as `0x${string}`),
      getBaseX402History(address as `0x${string}`)
    ])

    const eth = ethHistory.status === 'fulfilled' ? ethHistory.value : mockEthHistory(address)
    const x402 = baseHistory.status === 'fulfilled' ? baseHistory.value : { payments: 0, disputes: 0, volume: 0 }

    return {
      ...eth,
      x402PaymentCount: x402.payments,
      x402DisputeCount: x402.disputes,
      x402PaymentVolume: x402.volume,
      source: 'rpc'
    }
  } catch {
    console.warn('On-chain history query failed, using mock')
    return mockHistory(address)
  }
}

// ── Ethereum mainnet: wallet age, tx count, balance ───────────────

async function getEthHistory(address: `0x${string}`) {
  const currentBlock = await ethClient.getBlockNumber()

  const [code, balance, txCount] = await Promise.all([
    ethClient.getBytecode({ address }),
    ethClient.getBalance({ address }),
    ethClient.getTransactionCount({ address })
  ])

  const isContract = code !== undefined && code !== '0x'

  // Estimate wallet age from nonce — no archive node needed
  // High nonce + balance = established wallet; heuristic, not exact
  const estimatedAgeDays = txCount > 500 ? 900
    : txCount > 100 ? 365
    : txCount > 20 ? 90
    : txCount > 5 ? 30
    : txCount > 0 ? 7 : 0

  const hasRecentActivity = txCount > 0

  return {
    walletAgeDays: estimatedAgeDays,
    txCount,
    ethBalance: Number(balance) / 1e18,
    hasRecentActivity,
    isContract,
    firstSeenBlock: 0,
    lastSeenBlock: Number(currentBlock),
  }
}

// ── Base: x402 payment history via USDC transfer events ──────────

// Chunked log scan — public Base RPCs cap at ~50k blocks per call
async function getLogsChunked(
  args: Parameters<typeof baseClient.getLogs>[0] & { fromBlock: bigint; toBlock: bigint }
) {
  const chunkSize = 45000n
  const allLogs: Awaited<ReturnType<typeof baseClient.getLogs>> = []

  for (let from = args.fromBlock; from <= args.toBlock; from += chunkSize) {
    const to = from + chunkSize - 1n > args.toBlock ? args.toBlock : from + chunkSize - 1n
    const logs = await baseClient.getLogs({ ...args, fromBlock: from, toBlock: to })
    allLogs.push(...logs)
  }

  return allLogs
}

async function getBaseX402History(address: `0x${string}`) {
  const currentBlock = await baseClient.getBlockNumber()
  // Scan last ~7 days of Base blocks (≈ 300k blocks at 2s/block)
  const fromBlock = currentBlock > 300000n ? currentBlock - 300000n : 0n

  const [outgoing, refunds] = await Promise.all([
    getLogsChunked({
      address: USDC_BASE,
      event: ERC20_TRANSFER_ABI[0],
      args: { from: address, to: X402_FACILITATOR as `0x${string}` },
      fromBlock,
      toBlock: currentBlock,
    }),
    getLogsChunked({
      address: USDC_BASE,
      event: ERC20_TRANSFER_ABI[0],
      args: { from: X402_FACILITATOR as `0x${string}`, to: address },
      fromBlock,
      toBlock: currentBlock,
    }),
  ])

  const totalVolume = outgoing.reduce((sum, log) => {
    const value = (log.args as { value?: bigint }).value ?? 0n
    return sum + Number(value)
  }, 0) / 1e6 // USDC has 6 decimals

  return {
    payments: outgoing.length,
    disputes: refunds.length,
    volume: totalVolume
  }
}

// Raw chain query — always hits RPC, ignores MOCK_MODE
export async function debugOnChain(address: string) {
  if (!isAddress(address)) throw new Error(`Invalid address: ${address}`)

  const [ethHistory, baseHistory] = await Promise.allSettled([
    getEthHistory(address as `0x${string}`),
    getBaseX402History(address as `0x${string}`)
  ])

  return {
    eth: ethHistory.status === 'fulfilled'
      ? { ok: true, data: ethHistory.value }
      : { ok: false, error: String(ethHistory.reason) },
    x402: baseHistory.status === 'fulfilled'
      ? { ok: true, data: baseHistory.value }
      : { ok: false, error: String(baseHistory.reason) },
  }
}

// ── Mock helpers ──────────────────────────────────────────────────

function mockHistory(address: string): OnChainHistory {
  const seed = parseInt(address.slice(2, 10), 16)
  return {
    ...mockEthHistory(address),
    x402PaymentCount: seed % 80,
    x402DisputeCount: seed % 3,
    x402PaymentVolume: (seed % 500) * 0.01,
    source: 'mock'
  }
}

function mockEthHistory(address: string) {
  const seed = parseInt(address.slice(2, 10), 16)
  return {
    walletAgeDays: seed % 900,
    txCount: seed % 1000,
    ethBalance: (seed % 500) / 100,
    hasRecentActivity: seed % 3 !== 0,
    isContract: seed % 10 === 0,
    firstSeenBlock: 14000000 + (seed % 5000000),
    lastSeenBlock: 19000000 + (seed % 500000),
  }
}
