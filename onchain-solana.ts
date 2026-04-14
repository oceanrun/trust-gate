import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import type { SolanaHistory } from './types'

const connection = new Connection(
  process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
  'confirmed'
)

export function isSolanaAddress(address: string): boolean {
  if (address.startsWith('0x')) return false
  if (address.length < 32 || address.length > 50) return false
  try {
    new PublicKey(address)
    return true
  } catch {
    return false
  }
}

export async function getSolanaHistory(address: string): Promise<SolanaHistory> {
  if (process.env.MOCK_MODE === 'true') {
    return mockSolanaHistory(address)
  }

  try {
    const pubkey = new PublicKey(address)

    const [accountInfo, balance, recentSigs] = await Promise.all([
      connection.getAccountInfo(pubkey),
      connection.getBalance(pubkey),
      connection.getSignaturesForAddress(pubkey, { limit: 10 }),
    ])

    const isProgram = accountInfo?.executable ?? false
    const solBalance = balance / LAMPORTS_PER_SOL

    let txCount = recentSigs.length
    let hasRecentActivity = false
    let walletAgeDays = 0

    if (recentSigs.length > 0) {
      const thirtyDaysAgo = Date.now() / 1000 - 30 * 86400
      hasRecentActivity = recentSigs.some(
        (s) => s.blockTime && s.blockTime > thirtyDaysAgo
      )

      // Walk back up to 3 batches to estimate tx count + age
      let oldestSig = recentSigs[recentSigs.length - 1]
      let lastSig = oldestSig.signature
      for (let i = 0; i < 3; i++) {
        try {
          const batch = await connection.getSignaturesForAddress(pubkey, {
            limit: 1000,
            before: lastSig,
          })
          if (batch.length === 0) break
          txCount += batch.length
          oldestSig = batch[batch.length - 1]
          lastSig = oldestSig.signature
          if (batch.length < 1000) break
        } catch {
          break
        }
      }

      if (oldestSig.blockTime) {
        walletAgeDays = Math.floor((Date.now() / 1000 - oldestSig.blockTime) / 86400)
      }

      // If we maxed out batches, age is likely much older — use tx count heuristic
      if (walletAgeDays === 0 && txCount > 0) {
        walletAgeDays = txCount > 500 ? 900
          : txCount > 100 ? 365
          : txCount > 20 ? 90
          : txCount > 5 ? 30
          : txCount > 0 ? 7 : 0
      }
    }

    return {
      chain: 'solana',
      walletAgeDays: Math.max(0, walletAgeDays),
      txCount,
      solBalance,
      hasRecentActivity,
      isProgram,
      source: 'rpc',
    }
  } catch (err) {
    console.warn('Solana history query failed, using mock:', err)
    return mockSolanaHistory(address)
  }
}

export async function debugSolana(address: string) {
  const pubkey = new PublicKey(address)

  const [accountInfo, balance, sigs] = await Promise.all([
    connection.getAccountInfo(pubkey),
    connection.getBalance(pubkey),
    connection.getSignaturesForAddress(pubkey, { limit: 10 }),
  ])

  return {
    solana: {
      ok: true,
      data: {
        exists: accountInfo !== null,
        executable: accountInfo?.executable ?? false,
        owner: accountInfo?.owner?.toBase58() ?? null,
        lamports: balance,
        solBalance: balance / LAMPORTS_PER_SOL,
        recentSignatures: sigs.length,
        oldestBlockTime: sigs.length > 0 ? sigs[sigs.length - 1].blockTime : null,
        newestBlockTime: sigs.length > 0 ? sigs[0].blockTime : null,
      },
    },
  }
}

function mockSolanaHistory(address: string): SolanaHistory {
  // Use last 8 chars of base58 address as seed
  let seed = 0
  for (let i = 0; i < Math.min(8, address.length); i++) {
    seed = seed * 31 + address.charCodeAt(i)
  }
  seed = Math.abs(seed)

  return {
    chain: 'solana',
    walletAgeDays: seed % 900,
    txCount: seed % 1000,
    solBalance: (seed % 500) / 10,
    hasRecentActivity: seed % 3 !== 0,
    isProgram: seed % 10 === 0,
    source: 'mock',
  }
}
