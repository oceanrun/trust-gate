import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { TrustDecision } from './types'

let supabase: SupabaseClient | null = null

if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
}

let cacheHits = 0
let cacheMisses = 0

export function getCacheHitRate() {
  const total = cacheHits + cacheMisses
  return total > 0 ? parseFloat((cacheHits / total).toFixed(2)) : 0
}

export async function getCached(address: string): Promise<TrustDecision & { cache_hit: true } | null> {
  if (!supabase) return null

  const { data, error } = await supabase
    .from('trust_cache')
    .select('*')
    .eq('address', address)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (error || !data) {
    cacheMisses++
    return null
  }

  cacheHits++
  return {
    address: data.address,
    score: data.score,
    trusted: data.trusted,
    composite: data.composite,
    signals: data.signals,
    sources: data.sources,
    checked_at: data.checked_at,
    staked: data.composite?.erc8004 ?? 0,
    verified: false,
    reasons: [],
    cache_hit: true,
  }
}

export function writeCache(decision: TrustDecision): void {
  if (!supabase) return

  supabase.from('trust_cache').upsert({
    address: decision.address,
    score: decision.score,
    trusted: decision.trusted,
    composite: decision.composite,
    signals: decision.signals,
    sources: decision.sources,
    checked_at: decision.checked_at,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }, { onConflict: 'address' }).then(({ error }) => {
    if (error) console.error('cache write failed:', error.message)
  })
}

export function incrementPassCount(address: string): void {
  if (!supabase) return
  supabase.from('trust_cache').select('pass_count').eq('address', address).single()
    .then(({ data }) => {
      if (data) {
        supabase!.from('trust_cache')
          .update({ pass_count: data.pass_count + 1 })
          .eq('address', address).then(() => {})
      }
    })
}

export function incrementDisputeCount(address: string): void {
  if (!supabase) return
  supabase.from('trust_cache').select('dispute_count').eq('address', address).single()
    .then(({ data }) => {
      if (data) {
        supabase!.from('trust_cache')
          .update({ dispute_count: data.dispute_count + 1 })
          .eq('address', address).then(({ error }) => {
            if (error) console.error('dispute increment failed:', error.message)
          })
      }
    })
}

export async function getCacheStats() {
  if (!supabase) return null
  const { data } = await supabase.rpc('get_cache_stats')
  return data
}
