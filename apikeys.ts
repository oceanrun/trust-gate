import { createClient, SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'

let supabase: SupabaseClient | null = null

if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
}

function generateKey(): string {
  return 'tg_' + crypto.randomBytes(16).toString('hex')
}

export async function createApiKey(name: string, owner: string) {
  if (!supabase) return { error: 'Database not configured' }

  const key = generateKey()
  const { error } = await supabase.from('api_keys').insert({ key, name, owner })
  if (error) return { error: error.message }

  return { key, name, owner, monthly_limit: 1000 }
}

export async function validateApiKey(key: string): Promise<{ valid: boolean; error?: string }> {
  if (!supabase) return { valid: false, error: 'Database not configured' }
  if (!key.startsWith('tg_')) return { valid: false, error: 'Invalid key format' }

  const { data, error } = await supabase
    .from('api_keys')
    .select('*')
    .eq('key', key)
    .single()

  if (error || !data) return { valid: false, error: 'Invalid API key' }
  if (!data.active) return { valid: false, error: 'API key deactivated' }
  if (data.used_this_month >= data.monthly_limit) return { valid: false, error: 'Monthly limit exceeded' }

  // Increment usage — fire and forget
  supabase.from('api_keys')
    .update({ used_this_month: data.used_this_month + 1 })
    .eq('key', key)
    .then(() => {})

  return { valid: true }
}

export async function getKeyUsage(key: string) {
  if (!supabase) return { error: 'Database not configured' }

  const { data, error } = await supabase
    .from('api_keys')
    .select('used_this_month, monthly_limit')
    .eq('key', key)
    .single()

  if (error || !data) return { error: 'Invalid API key' }

  return {
    used_this_month: data.used_this_month,
    monthly_limit: data.monthly_limit,
    remaining: data.monthly_limit - data.used_this_month,
  }
}
