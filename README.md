# TrustGate

Layered trust scoring for x402 agent wallets — combines ERC-8004 reputation, on-chain wallet history, and x402 dispute rates into a single composite score.

## Why

There are 20M+ x402 transactions on Base with zero trust layer. Any wallet can call any x402 service. TrustGate sits between the payment and the response: before your service does work for an agent, check whether that agent is worth trusting.

## Scoring

TrustGate produces a 0-10 composite score from three layers:

**1. ERC-8004 reputation** (60% weight if available, 20% if not)
Reads from the on-chain [IdentityRegistry](https://etherscan.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) and [ReputationRegistry](https://etherscan.io/address/0x8004BAa17C55a88189AE136b182e5fdA19dE9b63). Checks whether the agent is registered, feedback count, and aggregate score from clients.

**2. On-chain wallet history** (40% weight, or 80% without ERC-8004)
Reads from Ethereum mainnet via RPC:
- Wallet age (0-2 pts)
- Transaction count / activity (0-2 pts)
- ETH balance (0-2 pts)
- EOA vs contract (0-2 pts)

**3. x402 payment history** (0-2 pts, part of on-chain score)
Scans USDC transfer logs on Base to/from the x402 facilitator contract. Counts payments and disputes. High dispute rates reduce the score; >5 disputes triggers a block.

## Live URL

```
https://trust-gate-production.up.railway.app
```

## Pricing

$0.01 USDC per request on Base mainnet via x402. The `/health`, `/debug/:address`, and `/` endpoints are free.

## API

### `GET /trust/:address`

Returns the full trust profile for a wallet address. Requires x402 payment.

```bash
curl https://trust-gate-production.up.railway.app/trust/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

Optional query params: `?threshold=5.0&minStake=200`

Response:

```json
{
  "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "trusted": true,
  "score": 5.4,
  "composite": {
    "final": 5.4,
    "erc8004": 3.8,
    "onchain": 7.8,
    "breakdown": {
      "walletAge": 2,
      "activity": 1.5,
      "balance": 2,
      "x402History": 1.5,
      "erc8004": 0.8
    }
  },
  "staked": 3138,
  "verified": true,
  "reasons": [
    "Composite score 5.4 passes threshold 4",
    "ERC-8004 stake $3138 meets minimum $100",
    "Wallet age 738 days",
    "x402: 18 payments, 0.0% dispute rate",
    "Identity verified via ERC-8004"
  ],
  "signals": {
    "walletAgeDays": 738,
    "txCount": 138,
    "hasRecentActivity": false,
    "isContract": false,
    "x402PaymentCount": 18,
    "x402DisputeCount": 0
  },
  "checked_at": "2026-04-14T18:58:11.644Z",
  "sources": ["erc8004", "rpc"]
}
```

### `POST /gate`

Allow/deny decision for inline use. Returns 200 if trusted, 403 if not. Requires x402 payment.

```bash
curl -X POST https://trust-gate-production.up.railway.app/gate \
  -H 'Content-Type: application/json' \
  -d '{"address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "threshold": 5.0, "minStake": 100}'
```

### `GET /debug/:address`

Raw chain data before scoring. Free, no payment required. Hits real RPCs regardless of `MOCK_MODE`.

```bash
curl https://trust-gate-production.up.railway.app/debug/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

### `GET /health`

```bash
curl https://trust-gate-production.up.railway.app/health
```

```json
{"ok": true, "service": "trust-gate", "version": "0.1.0", "mock_mode": false}
```

## Run locally

```bash
git clone https://github.com/oceanrun/trust-gate.git
cd trust-gate
npm install
cp .env.example .env
# Edit .env — set MOCK_MODE=true to start without CDP keys
npm run dev
```

`.env` variables:

| Variable | Required | Description |
|---|---|---|
| `MOCK_MODE` | yes | `true` for local dev, `false` for live |
| `WALLET_ADDRESS` | when live | Your Base wallet — receives USDC payments |
| `CDP_API_KEY` | when live | Coinbase CDP API key ID |
| `CDP_API_SECRET` | when live | Coinbase CDP API key secret |
| `ETH_RPC_URL` | no | Ethereum RPC (defaults to publicnode) |
| `BASE_RPC_URL` | no | Base RPC (defaults to publicnode) |

## Integration

If you're building an x402 service and want to gate responses on trust, call `/gate` before serving your paid response. In your middleware, after the x402 payment clears, extract the payer's wallet address and POST it to TrustGate. If the response is 200, serve the result. If 403, refund or reject. One HTTP call, one boolean — `trusted: true` or `trusted: false`. The `reasons` array tells the caller exactly why they were blocked, and the `composite.breakdown` gives granular scores if you want to set your own thresholds instead of using the defaults (score >= 4.0, stake >= $100).

## License

MIT
