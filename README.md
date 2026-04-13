# Fireblocks × Seismic SDK

A Node.js SDK for integrating [Fireblocks](https://www.fireblocks.com/) MPC wallets with [Seismic](https://seismic.systems/) - a privacy-preserving, EVM-compatible blockchain that encrypts transaction calldata inside a TEE.

---

## Overview

Seismic is fully EVM-compatible (chain ID 5124, native ETH, secp256k1) with one key difference: shielded transactions use type `0x4A` with AES-256-GCM encrypted calldata. Balances of `suint256` tokens (SRC-20) are stored ciphertext on-chain and require authenticated reads to decrypt.

Fireblocks vaults never expose raw private keys. This SDK bridges the gap:

- **Encryption key derivation**: signs a fixed seed message via Fireblocks RAW signing → SHA-256(signature) → deterministic `encryptionSk`. Reproducible across sessions, never written to disk.
- **SRC-20 balance reads**: Fireblocks signs an EIP-191 message off-chain; the SRC-20 contract verifies via `ecrecover` before decrypting the shielded balance.
- **Shielded transfers**: [`seismic-viem`](https://www.npmjs.com/package/seismic-viem) uses `encryptionSk` for ECDH with the Seismic TEE and emits type-0x4A transactions with encrypted calldata.

---

## Quick Start

```bash
npm install
cp .env.example .env   # fill in your Fireblocks credentials and RPC_URL
npm run dev            # watch build + auto-restart server
```

The server starts on `http://localhost:8000` (configurable via `PORT`).

---

## Environment Variables

| Variable                              | Required | Description                                                        |
| ------------------------------------- | -------- | ------------------------------------------------------------------ |
| `FIREBLOCKS_API_USER_KEY`             | ✓        | Fireblocks API key                                                 |
| `FIREBLOCKS_API_USER_SECRET_KEY_PATH` | ✓        | Path to Fireblocks RSA private key file                            |
| `BASE_PATH`                           |          | `US` \| `EU` \| `SANDBOX` (default: `US`)                          |
| `RPC_URL`                             |          | Seismic RPC endpoint (default: `https://node.seismictest.net/rpc`) |
| `PORT`                                |          | HTTP server port (default: `8000`)                                 |
| `LOG_LEVEL`                           |          | `DEBUG` \| `INFO` \| `WARN` \| `ERROR` (default: `INFO`)           |

---

## REST API

All routes are mounted at `/api`.

### Seismic routes

| Method | Route                                          | Description                                               |
| ------ | ---------------------------------------------- | --------------------------------------------------------- |
| `GET`  | `/api/:vaultId/address`                        | Vault's Seismic/ETH address (derived from MPC public key) |
| `GET`  | `/api/:vaultId/public-key`                     | Vault's compressed secp256k1 MPC public key               |
| `GET`  | `/api/:vaultId/balance`                        | Native ETH balance                                        |
| `GET`  | `/api/:vaultId/erc20-balances?contracts=0x...` | ERC-20 balances (comma-separated contracts)               |
| `GET`  | `/api/:vaultId/src20-balances?contracts=0x...` | SRC-20 shielded balances (Fireblocks-signed read)         |
| `GET`  | `/api/:vaultId/transactions?limit=N&offset=N`  | Transaction history                                       |
| `GET`  | `/api/:vaultId/transactions/:txHash`           | Single transaction details                                |
| `POST` | `/api/:vaultId/transfer`                       | Submit ETH / ERC-20 / SRC-20 transfer                     |
| `GET`  | `/api/metrics`                                 | Prometheus metrics (stub)                                 |
| `GET`  | `/health`                                      | Health check                                              |

### Transfer body

```json
{
  "type": "SRC20",
  "recipient": "0x...",
  "amount": 1.5,
  "contractAddress": "0x...",
  "note": "optional label"
}
```

`type` must be `"ETH"`, `"ERC20"`, or `"SRC20"`. `contractAddress` is required for ERC-20 and SRC-20.

---

## Library Usage

```typescript
import { MainSDK } from "@fireblocks/seismic-sdk";
import { BasePath } from "@fireblocks/ts-sdk";

const sdk = new MainSDK({
  apiKey: process.env.FIREBLOCKS_API_USER_KEY!,
  apiSecret: process.env.FIREBLOCKS_API_USER_SECRET_KEY_PATH!,
  basePath: BasePath.US,
  testnet: true,
});

// Resolve and cache vault identity (lazy - runs on first use)
const address = await sdk.getSeismicAddress("0");
const balance = await sdk.getBalance("0");

// SRC-20 shielded balance - Fireblocks signs the read authorization
const src20 = await sdk.getSrc20Balance("0", "0xContractAddress");

// Shielded transfer - encryptionSk derived once, then cached
const tx = await sdk.createShieldedTransaction(
  "0", // vaultId
  "0xRecipient",
  1.5, // amount in whole units
  "0xContract",
  "optional note"
);

await sdk.shutdown();
```

---

## How It Works

### Session lifecycle

1. **Vault init (lazy)** - on first use, `getPublicKeyByVaultID` fetches the vault's compressed secp256k1 public key from Fireblocks. The Seismic/ETH address is derived via `keccak256(uncompressed_pubkey)[last 20 bytes]` and cached in memory.

2. **Encryption key derivation** - `deriveEncryptionKey(vaultId)` signs a fixed 32-byte seed (`keccak256("Seismic Fireblocks Encryption Key Derivation")`) via Fireblocks RAW signing, then computes `SHA-256(fullSig)` to produce a 32-byte `encryptionSk`. Because Fireblocks MPC signatures are deterministic, the same key is re-derived on every session restart without re-approval. Stored in process memory only.

3. **TEE session** - `seismic-viem`'s `createShieldedWalletClient` fetches the Seismic TEE public key once per client instance. The `encryptionSk` is used for ECDH with the TEE to derive the AES-256-GCM calldata encryption key.

4. **Shutdown** - `sdk.shutdown()` zeroes all `encryptionSk` values before clearing the vault cache.

### SRC-20 balance reads

Standard `eth_call` returns zero for shielded `suint256` storage. The `balanceOfSigned(owner, expiry, signature)` function solves this:

1. Build `keccak256(abi.encodePacked("SRC20_BALANCE_READ", owner, expiry))` → EIP-191 wrap
2. Fireblocks RAW-signs the 32-byte hash (proves vault identity without raw key exposure)
3. Pack `r || s || v` into 65-byte Ethereum signature
4. The contract calls `ecrecover` and decrypts the balance if the signature is valid

One Fireblocks sign authorizes balance reads on any SRC-20 contract until the expiry (default: 1 hour).

### Shielded transfers

`createShieldedTransaction` uses `encryptionSk` as both the wallet signing key and the seismic-viem encryption key. `seismic-viem` automatically:

1. ABI-encodes `transfer(address, suint256)` calldata
2. Encrypts it via ECDH(encryptionSk, TEE pubkey) + HKDF → AES-256-GCM
3. Constructs a type-0x4A transaction with SeismicElements metadata
4. Signs and broadcasts

The transfer amount is never visible in public transaction data.

---

## Project Structure

```
src/
  MainSDK.ts                    Primary entry point
  services/
    fireblocks.service.ts       Fireblocks SDK wrapper
    fireblocksSigner.ts         RAW signing, signature packing, vault address derivation
    blockchain.api.service.ts   Seismic RPC + seismic-viem operations
  crypto/
    key-derivation.ts           SHA-256(Fireblocks fullSig) → encryptionSk
  seismic/
    abi.ts                      SRC-20 ABI (balance, balanceOfSigned, transfer)
    signature.ts                EIP-191 message builder for balanceOfSigned
  api/
    router.ts                   Express routes (HLD spec)
    controllers/controller.ts   Route handlers
    validation/schemas.ts       Zod schemas (params, query, body)
  utils/
    constants.ts                Chain ID, RPC URL, SEED_MESSAGE_HEX, derivation path
  types/
    custom.ts                   VaultData, TokenType, TransferType, etc.
```

---

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch build + auto-restart server
npm start            # Run compiled server
npm run typecheck    # Type-check without emitting
npm run lint         # ESLint
npm run format       # Prettier
npm run docs         # Generate TypeDoc API docs → docs/
```

---

## Seismic Testnet

- **Chain ID**: 5124
- **RPC**: `https://node.seismictest.net/rpc`
- **Explorer**: `https://seismic-testnet.socialscan.io/`
- **Native asset**: ETH (18 decimals)
