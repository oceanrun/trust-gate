import { createPublicClient, http, isAddress, parseAbi } from 'viem'
import { mainnet } from 'viem/chains'
import type { ReputationData } from './types'

// ERC-8004 deployed contracts (same address across all networks)
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const
const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as const

const IDENTITY_ABI = parseAbi([
  'event Registered(uint256 indexed agentId, address indexed wallet, string agentURI)',
  'function getAgentWallet(uint256 agentId) external view returns (address)',
])

const REPUTATION_ABI = parseAbi([
  'function getSummary(uint256 agentId, address[] calldata clientAddresses, string tag1, string tag2) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
  'function getClients(uint256 agentId) external view returns (address[])',
])

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_URL ?? 'https://ethereum.publicnode.com'),
})

// Resolve wallet address → agentId with a hard 5s timeout
// Most addresses aren't registered — fail fast rather than scan slowly
async function resolveAgentId(address: `0x${string}`): Promise<bigint | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))

  const scan = async (): Promise<bigint | null> => {
    const currentBlock = await client.getBlockNumber()
    const startBlock = currentBlock > 2_000_000n ? currentBlock - 2_000_000n : 19_000_000n

    // Fire two range queries in parallel
    const mid = startBlock + (currentBlock - startBlock) / 2n
    const [recent, older] = await Promise.allSettled([
      client.getLogs({
        address: IDENTITY_REGISTRY, event: IDENTITY_ABI[0],
        args: { wallet: address }, fromBlock: mid, toBlock: currentBlock,
      }),
      client.getLogs({
        address: IDENTITY_REGISTRY, event: IDENTITY_ABI[0],
        args: { wallet: address }, fromBlock: startBlock, toBlock: mid,
      }),
    ])

    // Check recent first (most registrations are recent)
    if (recent.status === 'fulfilled' && recent.value.length > 0) {
      return (recent.value[recent.value.length - 1].args as { agentId: bigint }).agentId
    }
    if (older.status === 'fulfilled' && older.value.length > 0) {
      return (older.value[older.value.length - 1].args as { agentId: bigint }).agentId
    }
    return null
  }

  return Promise.race([scan(), timeout])
}

export async function getReputation(address: string): Promise<ReputationData> {
  if (!isAddress(address)) throw new Error(`Invalid address: ${address}`)

  if (process.env.MOCK_MODE === 'true') {
    return mockReputation(address)
  }

  try {
    const agentId = await resolveAgentId(address as `0x${string}`)

    if (agentId === null) {
      return {
        score: 0,
        staked: 0,
        verified: false,
        transactionCount: 0,
        raw: { registered: false, address },
      }
    }

    // Get all clients who left feedback, then get the overall summary
    const clients = await client.readContract({
      address: REPUTATION_REGISTRY,
      abi: REPUTATION_ABI,
      functionName: 'getClients',
      args: [agentId],
    })

    const [count, summaryValue, valueDecimals] = await client.readContract({
      address: REPUTATION_REGISTRY,
      abi: REPUTATION_ABI,
      functionName: 'getSummary',
      args: [agentId, clients as `0x${string}`[], '', ''],
    })

    // Normalize summary value to 0–10 scale
    const divisor = 10 ** Number(valueDecimals)
    const rawScore = Number(summaryValue) / divisor
    const score = Math.max(0, Math.min(10, rawScore))

    return {
      score: parseFloat(score.toFixed(1)),
      staked: 0, // ERC-8004 doesn't have staking — placeholder for future
      verified: Number(count) > 0,
      transactionCount: Number(count),
      raw: {
        agentId: Number(agentId),
        feedbackCount: Number(count),
        rawSummaryValue: Number(summaryValue),
        valueDecimals: Number(valueDecimals),
        clientCount: (clients as `0x${string}`[]).length,
      },
    }
  } catch (err) {
    console.warn('ERC-8004 registry query failed, using mock:', err)
    return mockReputation(address)
  }
}

// Raw chain query — always hits RPC, ignores MOCK_MODE
export async function debugReputation(address: string) {
  if (!isAddress(address)) throw new Error(`Invalid address: ${address}`)

  const agentId = await resolveAgentId(address as `0x${string}`)

  if (agentId === null) {
    return { registered: false, address, agentId: null, clients: [], summary: null }
  }

  const clients = await client.readContract({
    address: REPUTATION_REGISTRY,
    abi: REPUTATION_ABI,
    functionName: 'getClients',
    args: [agentId],
  })

  const [count, summaryValue, valueDecimals] = await client.readContract({
    address: REPUTATION_REGISTRY,
    abi: REPUTATION_ABI,
    functionName: 'getSummary',
    args: [agentId, clients as `0x${string}`[], '', ''],
  })

  return {
    registered: true,
    address,
    agentId: Number(agentId),
    clients: (clients as `0x${string}`[]).map(String),
    summary: {
      feedbackCount: Number(count),
      rawSummaryValue: Number(summaryValue),
      valueDecimals: Number(valueDecimals),
      normalizedScore: Number(summaryValue) / (10 ** Number(valueDecimals)),
    },
  }
}

function mockReputation(address: string): ReputationData {
  const seed = parseInt(address.slice(2, 10), 16)
  return {
    score: parseFloat(((seed % 100) / 10).toFixed(1)),
    staked: seed % 5000,
    verified: seed % 4 !== 0,
    transactionCount: seed % 200,
    raw: { mock: true, seed },
  }
}
