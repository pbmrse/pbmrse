# PBMReserves DApp

PBMReserves is a standalone Web3 application for BNB Smart Chain. The public source includes the user-facing DApp, wallet connectivity, staking, mining reserve, PGR/SOV reward, swap interfaces, public API handlers, database schema snapshot, and token contracts.

## Live applications

- Official website: https://pbmreserves.xyz
- DApp: https://app.pbmreserves.xyz
- Network: BNB Smart Chain (`chainId: 56`)

## Product areas

- USDT staking with dedicated deposit addresses
- PGR reward claims
- PGR mining-reserve purchases and SOV rewards
- PGR/SOV to USDT swaps
- Wallet-owned records and referral views
- Five-language interface

## Technology

- Next.js 15 and React 18
- TypeScript
- Wagmi, Viem, and Reown AppKit
- Cloudflare-compatible server handlers and D1 schema
- Solidity token contracts based on OpenZeppelin Contracts 5.6.1

## Local development

Requirements: Node.js 24 and npm.

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`.

The public repository contains no production credentials, provider accounts, private keys, database identifiers, or encrypted secrets. Set your own Reown project ID and deployment-specific runtime bindings before enabling wallet or server operations.

## Checks

```bash
npm run typecheck
npm run build
npm run contracts:compile
```

## Contracts

- PGR: `0x61250E93E71F353DCc0B10A8C79A6A4f918283b6`
- SOV: `0xf2Eb81A5cAF0e99dc7c278e62407468be9d07224`

Single-file verification sources and standard JSON inputs are available in [`contracts`](./contracts).

## Security

Never commit private keys, seed phrases, account tokens, database IDs, or production environment files. See [`SECURITY.md`](./SECURITY.md).

## License

See [`LICENSE`](./LICENSE).
