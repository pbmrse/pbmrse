# PBMReserves DApp

PBMReserves is a standalone Web3 interface for BNB Smart Chain. This repository contains the user-facing DApp, wallet connectivity, staking, mining reserve, PGR/SOV reward and swap interfaces, public market/news adapters, and public token contracts.

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
- Solidity token contracts based on OpenZeppelin Contracts 5.6.1

## Local development

Requirements: Node.js 24 and npm.

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`.

Set your own Reown project ID and public deployment addresses before running wallet interactions.

## Public-source boundary

Like established open-source DApp interfaces, this repository publishes the application UI, wallet interaction clients, public ABIs/contracts, localization, styling, and reproducible build configuration. Production administration, financial service implementations, signer services, custody recovery tooling, databases, operational automation, credentials, and deployment bindings are intentionally excluded.

The client source documents the public request/response integration points used by the interface. A production operator must supply independently secured services for any state-changing action.

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

Never commit credentials, account tokens, production identifiers, or production environment files. See [`SECURITY.md`](./SECURITY.md).

## License

See [`LICENSE`](./LICENSE).
