# cfpay instructions

`cfmail-agent` Worker (Hono + Durable Objects + viem) served at pay.openaimp.com. Not `cfagent`, which is a separate repo.

## Commands
- PowerShell blocks `npm.ps1`; use `npm.cmd`.
- `npm.cmd run typecheck`, `npm.cmd run dev`. There is no test suite.

## Payments
- `src/api.ts`: x402 challenge, claim parsing, verification, PAYMENT-RESPONSE headers.
- `src/payments.ts`: payment config, on-chain testnet verification, viem chain map.
- Networks use CAIP-2 IDs (e.g. `eip155:84532`) in `PAYMENT_CONFIG` (`wrangler.jsonc`).
- Verification must fail closed. Payments are recorded `confirmed` only after verification.
- Multi-user support is a deferred enhancement; do not add it unprompted.
