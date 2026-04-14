export interface ReputationData {
  score: number        // 0–10, from ERC-8004 registry
  staked: number       // USD value of staked tokens
  verified: boolean    // passed identity verification
  transactionCount: number
  raw: Record<string, unknown>
}

export interface OnChainHistory {
  walletAgeDays: number        // days since first tx
  txCount: number              // total transactions
  ethBalance: number           // current ETH balance
  hasRecentActivity: boolean   // tx in last 30 days
  isContract: boolean          // is it a contract not an EOA
  firstSeenBlock: number
  lastSeenBlock: number
  // x402-specific
  x402PaymentCount: number     // times paid via x402
  x402DisputeCount: number     // times disputed / charged back
  x402PaymentVolume: number    // total USDC paid via x402
  source: 'rpc' | 'mock'
}

export interface CompositeScore {
  final: number          // 0–10 weighted composite
  erc8004: number        // raw ERC-8004 score
  onchain: number        // derived on-chain score 0–10
  breakdown: {
    walletAge: number    // 0–2 pts
    activity: number     // 0–2 pts
    balance: number      // 0–2 pts
    x402History: number  // 0–2 pts
    erc8004: number      // 0–2 pts (normalised)
  }
}

export interface TrustDecision {
  address: string
  trusted: boolean
  composite: CompositeScore
  // top-level shortcuts for easy consumption
  score: number
  staked: number
  verified: boolean
  reasons: string[]
  signals: {
    walletAgeDays: number
    txCount: number
    hasRecentActivity: boolean
    isContract: boolean
    x402PaymentCount: number
    x402DisputeCount: number
  }
  checked_at: string
  sources: Array<'erc8004' | 'rpc' | 'mock'>
}

export interface GateRequest {
  address: string
  threshold?: number   // minimum composite score, default 4.0
  minStake?: number    // minimum stake in USD, default 100
}
