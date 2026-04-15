import { createClient, SupabaseClient } from '@supabase/supabase-js'

export interface CheckEvent {
  address: string
  trusted: boolean
  score: number
  endpoint: string
  duration_ms: number
  payment_success: boolean
  composite_breakdown: Record<string, number>
}

let supabase: SupabaseClient | null = null

if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
}

// Layer 1: structured JSON to stdout
// Layer 2: fire-and-forget insert to Supabase
export function logCheck(event: CheckEvent): void {
  // Stdout log — Railway captures this
  console.log(JSON.stringify({
    event: 'trust_check',
    address: event.address,
    trusted: event.trusted,
    score: event.score,
    endpoint: event.endpoint,
    duration_ms: event.duration_ms,
    payment: event.payment_success ? 'success' : 'skipped',
    timestamp: new Date().toISOString(),
  }))

  // Supabase insert — never block the response
  if (supabase) {
    supabase.from('checks').insert({
      address: event.address,
      trusted: event.trusted,
      score: event.score,
      endpoint: event.endpoint,
      duration_ms: event.duration_ms,
      payment_success: event.payment_success,
      composite_breakdown: event.composite_breakdown,
    }).then(({ error }) => {
      if (error) console.error('analytics insert failed:', error.message)
    })
  }
}

// Layer 3: cached stats query
let statsCache: { data: unknown; expires: number } | null = null

export async function getStats(cacheHitRate: number, cacheStats: unknown) {
  if (statsCache && Date.now() < statsCache.expires) {
    return statsCache.data
  }

  if (!supabase) {
    return { error: 'Analytics not configured' }
  }

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()

  const [totals, today, paidCount, topReasons] = await Promise.all([
    supabase.rpc('get_check_totals'),
    supabase.from('checks').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),
    supabase.from('checks').select('id', { count: 'exact', head: true }).eq('payment_success', true),
    supabase.rpc('get_top_failing_reasons'),
  ])

  const t = totals.data ?? { total_checks: 0, trusted_count: 0, unique_addresses: 0, avg_score: 0 }
  const paid = paidCount.count ?? 0
  const cs = cacheStats as Record<string, unknown> | null

  const stats = {
    total_checks: t.total_checks,
    paid_checks: paid,
    trusted_rate: t.total_checks > 0 ? parseFloat((t.trusted_count / t.total_checks).toFixed(2)) : 0,
    unique_addresses: t.unique_addresses,
    avg_score: parseFloat(Number(t.avg_score).toFixed(1)),
    checks_today: today.count ?? 0,
    usdc_earned: parseFloat((paid * 0.01).toFixed(2)),
    cache_hit_rate: cacheHitRate,
    top_failing_reasons: topReasons.data ?? [],
    top_trusted: cs?.top_trusted ?? [],
    flagged_addresses: cs?.flagged ?? [],
  }

  statsCache = { data: stats, expires: Date.now() + 60_000 }
  return stats
}
