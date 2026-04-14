import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { isAddress } from 'viem'
import { paymentMiddlewareFromConfig } from '@x402/express'
import { HTTPFacilitatorClient } from '@x402/core/http'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { generateJwt } from '@coinbase/cdp-sdk/auth'
import { getReputation, debugReputation } from './reputation'
import { getOnChainHistory, debugOnChain } from './onchain'
import { scoreTrust } from './trust'
import { publicLimiter, debugLimiter, paidLimiter } from './rateLimiter'
import type { GateRequest } from './types'

const app = express()
const PORT = process.env.PORT ?? 3000

// Your wallet address — receives USDC payments per trust check
const RECIPIENT = (process.env.WALLET_ADDRESS ?? '0xYourWalletAddressHere') as `0x${string}`

// ── #4 Wallet address guard ──────────────────────────────────────

if (process.env.MOCK_MODE !== 'true') {
  if (!process.env.WALLET_ADDRESS || process.env.WALLET_ADDRESS === '0xYourWalletAddressHere') {
    throw new Error('WALLET_ADDRESS must be set to a real address when MOCK_MODE is not true')
  }
}

// ── Middleware ────────────────────────────────────────────────────

app.use(cors())
app.use(helmet())
app.use(express.json({ limit: '1kb' }))

// ── #5 Request timeout helper ────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

// ── #2 Input validation helpers ──────────────────────────────────

function validateAddress(address: string): string | null {
  if (typeof address !== 'string' || address.length > 1000) return 'Invalid Ethereum address'
  if (!isAddress(address)) return 'Invalid Ethereum address'
  return null
}

function validateGateBody(body: unknown): { error: string } | GateRequest {
  const b = body as Record<string, unknown>

  if (!b.address || typeof b.address !== 'string') return { error: 'address required' }
  if (String(b.address).length > 1000) return { error: 'Invalid Ethereum address' }

  const addrErr = validateAddress(String(b.address))
  if (addrErr) return { error: addrErr }

  if (b.threshold !== undefined) {
    const t = Number(b.threshold)
    if (!Number.isFinite(t) || t < 0 || t > 100) return { error: 'threshold must be a number between 0 and 100' }
  }

  if (b.minStake !== undefined) {
    const s = Number(b.minStake)
    if (!Number.isFinite(s) || s < 0 || s > 1_000_000) return { error: 'minStake must be a number between 0 and 1000000' }
  }

  return {
    address: String(b.address),
    threshold: b.threshold !== undefined ? Number(b.threshold) : undefined,
    minStake: b.minStake !== undefined ? Number(b.minStake) : undefined,
  }
}

// ── Free endpoints ────────────────────────────────────────────────

app.get('/health', publicLimiter, (_, res) => {
  res.json({
    ok: true,
    service: 'trust-gate',
    version: '0.1.0',
    mock_mode: process.env.MOCK_MODE === 'true'
  })
})

app.get('/', publicLimiter, (_, res) => {
  res.json({
    name: 'TrustGate',
    description: 'ERC-8004 trust scoring for AI agents. Pay $0.01 USDC per check.',
    endpoints: {
      'GET /trust/:address': 'Trust score for a wallet address — $0.01 USDC',
      'POST /gate': 'Allow/deny decision with custom thresholds — $0.01 USDC',
      'GET /health': 'Free health check'
    },
    pricing: '$0.01 USDC per request via x402 (Base network)',
    docs: 'https://github.com/your-repo/trust-gate'
  })
})

// ── Debug endpoint — hits real RPC regardless of MOCK_MODE ───────

app.get('/debug/:address', debugLimiter, async (req, res) => {
  const { address } = req.params
  const addrErr = validateAddress(address)
  if (addrErr) { res.status(400).json({ error: addrErr }); return }

  try {
    const [erc8004, onchain] = await Promise.allSettled([
      debugReputation(address),
      debugOnChain(address)
    ])

    res.json({
      address,
      erc8004: erc8004.status === 'fulfilled'
        ? erc8004.value
        : { error: 'ERC-8004 query failed' },
      onchain: onchain.status === 'fulfilled'
        ? onchain.value
        : { error: 'On-chain query failed' },
      queried_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('debug endpoint error:', err)
    res.status(500).json({ error: 'Request failed' })
  }
})

// ── x402 payment middleware — all routes below require $0.01 USDC ─

if (process.env.MOCK_MODE !== 'true') {
  const CDP_API_KEY = process.env.CDP_API_KEY
  const CDP_API_SECRET = process.env.CDP_API_SECRET
  if (!CDP_API_KEY || !CDP_API_SECRET) {
    throw new Error('CDP_API_KEY and CDP_API_SECRET must be set when MOCK_MODE is not true')
  }

  const facilitator = new HTTPFacilitatorClient({
    url: 'https://api.cdp.coinbase.com/platform/v2/x402',
    createAuthHeaders: async () => {
      const makeJwt = (method: string, path: string) =>
        generateJwt({
          apiKeyId: CDP_API_KEY,
          apiKeySecret: CDP_API_SECRET,
          requestMethod: method,
          requestHost: 'api.cdp.coinbase.com',
          requestPath: path,
        })

      const [verifyJwt, settleJwt, supportedJwt] = await Promise.all([
        makeJwt('POST', '/platform/v2/x402/verify'),
        makeJwt('POST', '/platform/v2/x402/settle'),
        makeJwt('GET', '/platform/v2/x402/supported'),
      ])

      return {
        verify: { Authorization: `Bearer ${verifyJwt}` },
        settle: { Authorization: `Bearer ${settleJwt}` },
        supported: { Authorization: `Bearer ${supportedJwt}` },
      }
    },
  })

  const paymentConfig = {
    scheme: 'exact',
    network: 'eip155:8453',
    payTo: RECIPIENT,
    price: '$0.01',
  }

  app.use(
    paymentMiddlewareFromConfig(
      {
        'GET /trust/:address': {
          accepts: paymentConfig,
          description: 'ERC-8004 reputation score for an agent wallet',
        },
        'POST /gate': {
          accepts: paymentConfig,
          description: 'Trust gate decision with configurable thresholds',
        },
      },
      facilitator,
      [{ network: 'eip155:8453', server: new ExactEvmScheme() }],
    )
  )
} else {
  console.log('Mock mode: skipping x402 payment middleware')
}

// ── Paid endpoints ────────────────────────────────────────────────

app.get('/trust/:address', paidLimiter, async (req, res) => {
  const { address } = req.params
  const addrErr = validateAddress(address)
  if (addrErr) { res.status(400).json({ error: addrErr }); return }

  const threshold = req.query.threshold !== undefined
    ? parseFloat(req.query.threshold as string) : undefined
  const minStake = req.query.minStake !== undefined
    ? parseFloat(req.query.minStake as string) : undefined

  try {
    const [rep, history] = await withTimeout(
      Promise.all([getReputation(address), getOnChainHistory(address)]),
      10_000,
    )
    const decision = scoreTrust(address, rep, history, threshold, minStake)
    res.json(decision)
  } catch (err) {
    console.error('trust endpoint error:', err)
    if (err instanceof Error && err.message === 'TIMEOUT') {
      res.status(504).json({ error: 'Request timed out' })
    } else {
      res.status(500).json({ error: 'Request failed' })
    }
  }
})

app.post('/gate', paidLimiter, async (req, res) => {
  const validated = validateGateBody(req.body)
  if ('error' in validated) { res.status(400).json({ error: validated.error }); return }

  const { address, threshold, minStake } = validated

  try {
    const [rep, history] = await withTimeout(
      Promise.all([getReputation(address), getOnChainHistory(address)]),
      10_000,
    )
    const decision = scoreTrust(address, rep, history, threshold, minStake)

    if (decision.trusted) {
      res.status(200).json(decision)
    } else {
      res.status(403).json(decision)
    }
  } catch (err) {
    console.error('gate endpoint error:', err)
    if (err instanceof Error && err.message === 'TIMEOUT') {
      res.status(504).json({ error: 'Request timed out' })
    } else {
      res.status(500).json({ error: 'Request failed' })
    }
  }
})

// ── Start ─────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`TrustGate running on port ${PORT}`)
  console.log(`Mock mode: ${process.env.MOCK_MODE === 'true'}`)
  console.log(`Recipient wallet: ${RECIPIENT}`)
})
