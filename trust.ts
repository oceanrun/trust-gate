import type {
  ReputationData,
  OnChainHistory,
  CompositeScore,
  TrustDecision
} from './types'

const DEFAULT_THRESHOLD = 4.0
const DEFAULT_MIN_STAKE = 100

// ── On-chain score — derived from wallet history (0–10) ──────────
//
// Points breakdown (max 10):
//   Wallet age      0–2 pts   (new wallets are risky)
//   Activity        0–2 pts   (inactive wallets are risky)
//   ETH balance     0–2 pts   (skin in the game signal)
//   x402 history    0–2 pts   (actual payment track record)
//   Not a contract  0–2 pts   (EOA vs contract agent)

export function scoreOnChain(history: OnChainHistory): number {
  let pts = 0

  // Wallet age (0–2)
  if (history.walletAgeDays > 365) pts += 2
  else if (history.walletAgeDays > 90) pts += 1.5
  else if (history.walletAgeDays > 30) pts += 1
  else if (history.walletAgeDays > 7) pts += 0.5

  // Activity (0–2)
  if (history.txCount > 500) pts += 2
  else if (history.txCount > 100) pts += 1.5
  else if (history.txCount > 20) pts += 1
  else if (history.txCount > 5) pts += 0.5
  if (history.hasRecentActivity) pts += 0.25
  pts = Math.min(pts, 2.25)

  // ETH balance (0–2)
  if (history.ethBalance > 1) pts += 2
  else if (history.ethBalance > 0.1) pts += 1.5
  else if (history.ethBalance > 0.01) pts += 1
  else if (history.ethBalance > 0) pts += 0.5

  // x402 history (0–2)
  const disputeRatio = history.x402PaymentCount > 0
    ? history.x402DisputeCount / history.x402PaymentCount : 0

  if (history.x402PaymentCount > 50 && disputeRatio < 0.01) pts += 2
  else if (history.x402PaymentCount > 10 && disputeRatio < 0.05) pts += 1.5
  else if (history.x402PaymentCount > 3 && disputeRatio < 0.1) pts += 1
  else if (history.x402PaymentCount > 0) pts += 0.5

  // EOA vs contract (0–2)
  if (!history.isContract) pts += 2
  else pts += 0.5

  // Hard disqualifiers
  if (history.isContract && history.x402DisputeCount > 5) pts = Math.min(pts, 2)
  if (history.walletAgeDays === 0) pts = Math.min(pts, 1)

  return Math.min(parseFloat(pts.toFixed(1)), 10)
}

// ── Composite score — weighted blend of ERC-8004 + on-chain ──────

export function buildComposite(
  rep: ReputationData,
  onchain: number,
  history: OnChainHistory
): CompositeScore {
  const hasERC8004 = rep.score > 0 && rep.transactionCount > 0
  const erc8004Weight = hasERC8004 ? 0.6 : 0.2
  const onchainWeight = hasERC8004 ? 0.4 : 0.8

  const final = parseFloat(
    (rep.score * erc8004Weight + onchain * onchainWeight).toFixed(1)
  )

  const walletAge = history.walletAgeDays > 365 ? 2
    : history.walletAgeDays > 90 ? 1.5
    : history.walletAgeDays > 30 ? 1
    : history.walletAgeDays > 7 ? 0.5 : 0

  const activity = Math.min(
    history.txCount > 500 ? 2 : history.txCount > 100 ? 1.5 : history.txCount > 20 ? 1 : 0.5, 2
  )

  const balance = history.ethBalance > 1 ? 2
    : history.ethBalance > 0.1 ? 1.5
    : history.ethBalance > 0.01 ? 1
    : history.ethBalance > 0 ? 0.5 : 0

  const disputeRatio = history.x402PaymentCount > 0
    ? history.x402DisputeCount / history.x402PaymentCount : 0
  const x402pts = history.x402PaymentCount > 50 && disputeRatio < 0.01 ? 2
    : history.x402PaymentCount > 10 ? 1.5
    : history.x402PaymentCount > 3 ? 1
    : history.x402PaymentCount > 0 ? 0.5 : 0

  return {
    final,
    erc8004: rep.score,
    onchain,
    breakdown: {
      walletAge,
      activity,
      balance,
      x402History: x402pts,
      erc8004: parseFloat((rep.score / 5).toFixed(1))
    }
  }
}

// ── Final trust decision ──────────────────────────────────────────

export function scoreTrust(
  address: string,
  rep: ReputationData,
  history: OnChainHistory,
  threshold = DEFAULT_THRESHOLD,
  minStake = DEFAULT_MIN_STAKE
): TrustDecision {
  const onchainScore = scoreOnChain(history)
  const composite = buildComposite(rep, onchainScore, history)
  const reasons: string[] = []
  let trusted = true

  if (composite.final < threshold) {
    trusted = false
    reasons.push(`Composite score ${composite.final} below threshold ${threshold}`)
  } else {
    reasons.push(`Composite score ${composite.final} passes threshold ${threshold}`)
  }

  if (rep.staked < minStake) {
    trusted = false
    reasons.push(`ERC-8004 stake $${rep.staked} below minimum $${minStake}`)
  } else {
    reasons.push(`ERC-8004 stake $${rep.staked} meets minimum $${minStake}`)
  }

  if (history.isContract) {
    reasons.push('Address is a smart contract — elevated scrutiny applied')
  }

  if (history.walletAgeDays === 0) {
    trusted = false
    reasons.push('Wallet created today — blocked pending history')
  } else if (history.walletAgeDays < 7) {
    reasons.push(`Wallet only ${history.walletAgeDays}d old — high risk`)
  } else {
    reasons.push(`Wallet age ${history.walletAgeDays} days`)
  }

  if (history.x402PaymentCount === 0) {
    reasons.push('No x402 payment history — unknown actor')
  } else {
    const disputeRate = ((history.x402DisputeCount / history.x402PaymentCount) * 100).toFixed(1)
    reasons.push(`x402: ${history.x402PaymentCount} payments, ${disputeRate}% dispute rate`)
    if (history.x402DisputeCount > 5) {
      trusted = false
      reasons.push('Excessive disputes on x402 — blocked')
    }
  }

  if (rep.verified) {
    reasons.push('Identity verified via ERC-8004')
  } else {
    reasons.push('Identity unverified — score weighted lower')
  }

  const sources: Array<'erc8004' | 'rpc' | 'mock'> = []
  if ((rep.raw as Record<string, unknown>).mock) sources.push('mock')
  else sources.push('erc8004')
  sources.push(history.source === 'rpc' ? 'rpc' : 'mock')

  return {
    address,
    trusted,
    composite,
    score: composite.final,
    staked: rep.staked,
    verified: rep.verified,
    reasons,
    signals: {
      walletAgeDays: history.walletAgeDays,
      txCount: history.txCount,
      hasRecentActivity: history.hasRecentActivity,
      isContract: history.isContract,
      x402PaymentCount: history.x402PaymentCount,
      x402DisputeCount: history.x402DisputeCount
    },
    checked_at: new Date().toISOString(),
    sources
  }
}
