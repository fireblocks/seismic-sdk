# Fireblocks × Seismic SDK

A Node.js SDK for integrating [Fireblocks](https://www.fireblocks.com/) MPC wallets with [Seismic](https://seismic.systems/) - a privacy-preserving, EVM-compatible blockchain that encrypts transaction calldata inside a TEE.

---

## Overview

Seismic is fully EVM-compatible (chain ID 5124, native ETH, secp256k1) with one key difference: shielded transactions use type `0x4A` with AES-256-GCM encrypted calldata. Balances of `suint256` tokens (SRC-20) are stored as ciphertext on-chain and require authenticated reads to decrypt.

Fireblocks vaults never expose raw private keys. This SDK bridges the gap:

- **Encryption key derivation**: signs a fixed seed message via Fireblocks RAW signing → SHA-256(signature) → stable `encryptionSk`. Reproducible across sessions thanks to [Fireblocks signature caching](https://developers.fireblocks.com/reference/caching-signatures#caching-signatures) (backend-cached, no TTL); never written to disk.
- **SRC-20 balance reads**: Fireblocks signs an EIP-191 message off-chain (no transaction nonce); the SRC-20 contract verifies via `ecrecover` before decrypting the shielded balance.
- **Shielded transfers**: [`seismic-viem`](https://www.npmjs.com/package/seismic-viem) uses `encryptionSk` for ECDH with the Seismic TEE and emits type-0x4A transactions with encrypted calldata.
- **SRC-20 viewing key**: register a stable AES key in the Seismic Directory precompile so all incoming Transfer events are encrypted to it - enables zero-N+1 transaction history with decrypted amounts for both sent and received transfers.

---

## Quick Start

### Local (Node.js)

```bash
npm install
cp .env.example .env   # fill in your Fireblocks credentials
npm run dev            # watch build + auto-restart server
```

### Docker

```bash
cp .env.example .env   # fill in your Fireblocks credentials
docker build -t seismic-sdk .
docker run -d \
  --name seismic-sdk \
  -p 8000:8000 \
  --env-file .env \
  -v $(pwd)/fireblocks_secret.key:/usr/src/app/fireblocks_secret.key:ro \
  seismic-sdk
```

The server starts on `http://localhost:8000` (configurable via `PORT`).  
Swagger UI: `http://localhost:8000/api-docs` (REST API endpoints)  
TypeDoc: `http://localhost:8000/docs` (SDK library API docs - run `npm run docs` first)

---

## Environment Variables

| Variable                              | Required | Description                                                                                                                                                                                                                                               |
| ------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIREBLOCKS_API_USER_KEY`             | ✓        | Fireblocks API key                                                                                                                                                                                                                                        |
| `FIREBLOCKS_API_USER_SECRET_KEY_PATH` | ✓        | Path to Fireblocks RSA private key file                                                                                                                                                                                                                   |
| `BASE_PATH`                           |          | `US` \| `EU` \| `SANDBOX` (default: `US`)                                                                                                                                                                                                                 |
| `NETWORK`                             |          | `testnet` (default — opt-out) \| `mainnet` (not yet live, will throw at startup). Omitting `NETWORK` selects testnet. Set `NETWORK=mainnet` only once Seismic mainnet is live.                                                                            |
| `RPC_URL`                             |          | Seismic RPC endpoint (defaults: testnet=`https://testnet-1.seismictest.net/rpc`, mainnet=pending)                                                                                                                                                         |
| `PORT`                                |          | HTTP server port (default: `8000`)                                                                                                                                                                                                                        |
| `LOG_LEVEL`                           |          | `DEBUG` \| `INFO` \| `WARN` \| `ERROR` \| `NONE` (case-insensitive, default: `INFO`)                                                                                                                                                                      |
| `SKIP_DETERMINISM_CHECK`              |          | Skip signature-caching verification at startup (default: `false`). Only set to `true` if you have confirmed your Fireblocks workspace has [signature caching](https://developers.fireblocks.com/reference/caching-signatures#caching-signatures) enabled. |
| `SOCIALSCAN_API_KEY`                  |          | SocialScan Explorer API key - required for ERC-20 transaction history. Get one at [developer.socialscan.io](https://developer.socialscan.io)                                                                                                              |
| `TX_LOG_DIR`                          |          | Directory where `tx-log.ndjson` is written on every broadcast (default: `.`). Each line: `{ timestamp, vault, type, to, amount, contract?, nonce?, txHash }`                                                                                              |
| `HTTP_TIMEOUT`                        |          | HTTP client timeout in milliseconds (default: `30000`)                                                                                                                                                                                                    |
| `HTTP_USER_AGENT`                     |          | HTTP `User-Agent` header (default: `@fireblocks/seismic-sdk/<version>`)                                                                                                                                                                                   |

---

## REST API

All routes are mounted at `/api`. Full interactive docs at `GET /api-docs` (Swagger UI).

### Vault

| Method | Route                      | Description                                               |
| ------ | -------------------------- | --------------------------------------------------------- |
| `GET`  | `/api/:vaultId/address`    | Vault's Seismic/ETH address (derived from MPC public key) |
| `GET`  | `/api/:vaultId/public-key` | Vault's compressed secp256k1 MPC public key               |

### Balances

| Method | Route                          | Description                                         |
| ------ | ------------------------------ | --------------------------------------------------- |
| `GET`  | `/api/:vaultId/token-balances` | sUSDC + ERC-20 + SRC-20 balances (see params below) |

**Query parameters for `/token-balances`:**

| Param       | Default | Description                                                                                                                    |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `type`      | `all`   | `erc20` \| `src20` \| `all`                                                                                                    |
| `contracts` |         | Optional comma-separated contract addresses. If omitted, auto-discovers: ERC-20 via SocialScan, SRC-20 via `eth_getLogs` scan. |

**Response shape:**

```json
{
  "success": true,
  "data": {
    "sUSDC": {
      "contractAddress": "0x790701048922e265105fd6a4467a2901c2201c43",
      "name": "Shielded USD Coin",
      "symbol": "SUSDC",
      "decimals": 6,
      "balance": "250"
    },
    "erc20": [
      {
        "contractAddress": "0x...",
        "name": "USDC",
        "symbol": "USDC",
        "decimals": 6,
        "balance": "100"
      }
    ],
    "src20": [
      {
        "contractAddress": "0x...",
        "name": "TSRC",
        "symbol": "TSRC",
        "decimals": 18,
        "balance": "9139"
      }
    ]
  }
}
```

`sUSDC` is always fetched separately (it's the gas token; balance uses `balanceOfSigned` - no gas required). When `type=all`, each type is fetched in parallel and fails independently - partial results returned with `erc20Error`/`src20Error` on failure.

### SRC-20 Viewing Key

| Method | Route                              | Description                                                      |
| ------ | ---------------------------------- | ---------------------------------------------------------------- |
| `POST` | `/api/:vaultId/src20/register-key` | Register vault's AES viewing key in the Seismic Directory (once) |
| `GET`  | `/api/:vaultId/src20/key-status`   | Check if viewing key is registered                               |

### Transaction History

| Method | Route                                | Description                            |
| ------ | ------------------------------------ | -------------------------------------- |
| `GET`  | `/api/:vaultId/transactions`         | Transaction history (see params below) |
| `GET`  | `/api/:vaultId/transactions/:txHash` | Single transaction by hash             |

**Query parameters for `/transactions`:**

| Param       | Default | Description                                                                                                                                                                            |
| ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`      | `erc20` | `erc20` \| `src20` \| `all`. `erc20` and `all` require `SOCIALSCAN_API_KEY` for full history. For sUSDC history use `type=src20&contracts=0x790701048922e265105fd6a4467a2901c2201c43`. |
| `contracts` |         | Comma-separated contract addresses to filter by. Required for `type=src20`.                                                                                                            |
| `limit`     | `50`    | Max results per page.                                                                                                                                                                  |
| `offset`    | `0`     | Results to skip (for pagination).                                                                                                                                                      |
| `before`    |         | Return transactions on or before this date (`YYYY-MM-DD`). Converts to an approximate block using ~120ms block time.                                                                   |
| `after`     |         | Return transactions on or after this date (`YYYY-MM-DD`). Converts to an approximate block using ~120ms block time.                                                                    |
| `fromBlock` |         | Hex start block. Only used for explicit `eth_getLogs` range; overridden by `after` if both are provided.                                                                               |
| `toBlock`   |         | Hex end block. Only used for explicit `eth_getLogs` range; overridden by `before` if both are provided.                                                                                |

> **Date range notes**: dates are converted to block numbers via `currentBlock - (now - date) / 120ms`. History depth is ~41 days (300 windows × 99k blocks × 120ms). Requests for older data include a `warning` in the response meta.

**Response shape:**

```json
{
  "success": true,
  "data": [
    /* Transaction[] */
  ],
  "meta": {
    "source": "eth_getLogs-viewing-key",
    "scannedFromBlock": "0x301baf9",
    "scannedToBlock": "0x315adf2",
    "count": 10,
    "total": 42,
    "limit": 10,
    "offset": 0,
    "hasMore": true,
    "warning": "optional - present when date is out of history range"
  }
}
```

### Transfers

| Method | Route                    | Description                             |
| ------ | ------------------------ | --------------------------------------- |
| `POST` | `/api/:vaultId/transfer` | Submit SUSDC / ERC-20 / SRC-20 transfer |

**Transfer body:**

```json
{
  "type": "SUSDC",
  "recipient": "0x...",
  "amount": "1.5",
  "note": "optional label"
}
```

`type` must be `"SUSDC"`, `"ERC20"`, or `"SRC20"`.

- `SUSDC` - sUSDC shielded transfer; contract address is baked in, no need to supply it.
- `ERC20` / `SRC20` - `contractAddress` required.

Use `recipient` (direct address) or `destinationVaultId` (Fireblocks vault ID, resolved automatically).

### Contracts

| Method | Route                             | Description                                    |
| ------ | --------------------------------- | ---------------------------------------------- |
| `GET`  | `/api/contracts/:contractAddress` | ERC-20 token metadata (name, symbol, decimals) |

### Observability

| Method | Route          | Description                                      |
| ------ | -------------- | ------------------------------------------------ |
| `GET`  | `/api/metrics` | Prometheus metrics (CPU, memory, event loop lag) |
| `GET`  | `/health`      | Health check                                     |

---

## Library Usage

```typescript
import { MainSDK, createHttpClient } from "@fireblocks/seismic-sdk";
import { BasePath } from "@fireblocks/ts-sdk";

// Create and initialize the SDK with deterministic signing verification
const sdk = await MainSDK.create({
  apiKey: process.env.FIREBLOCKS_API_USER_KEY!,
  apiSecret: process.env.FIREBLOCKS_API_USER_SECRET_KEY_PATH!,
  basePath: BasePath.US,
  testnet: true,
  // Optional: customize the HTTP client (timeout, User-Agent, interceptors, etc.)
  httpClient: createHttpClient({ timeout: 10_000, userAgent: "MyApp/1.0" }),
});

// Vault identity (lazy - runs on first use)
const address = await sdk.getSeismicAddress("0");

// Token balances - sUSDC is always returned separately (it's the gas token)
const balances = await sdk.getTokenBalances("0", "all");
// balances.sUSDC.balance  → "250"
// balances.src20          → [...other SRC-20 tokens]

// SRC-20 shielded balance (any SRC-20 contract, including sUSDC)
const src20 = await sdk.getSrc20Balance("0", "0xContractAddress");

// Register viewing key (one-time per vault address)
await sdk.registerViewingKey("0");

// Check registration status
const registered = await sdk.checkViewingKeyRegistered("0");

// Transaction history with decrypted SRC-20 amounts
const history = await sdk.getTransactionHistory({
  vaultId: "0",
  type: "src20",
  contracts: ["0xContractAddress"],
  limit: 20,
  offset: 0,
});

// sUSDC transfer - contract address baked in, no need to supply it
const susdcTx = await sdk.createSUsdcTransaction("0", "0xRecipient", "1.5");

// Any other SRC-20 shielded transfer
const tx = await sdk.createShieldedTransaction(
  "0", // vaultId
  "0xRecipient",
  "1.5", // amount in whole units
  "0xContract"
);

await sdk.shutdown();
```

---

## How It Works

### Session lifecycle

1. **SDK initialization** - `MainSDK.create()` constructs the SDK instance then verifies your Fireblocks workspace has [signature caching](https://developers.fireblocks.com/reference/caching-signatures#caching-signatures) enabled by signing `SEED_MESSAGE_HEX` twice and comparing the results. MPC ECDSA is not inherently deterministic - Fireblocks achieves reproducibility via backend signature caching (no TTL): identical payloads always return the same cached signature. If the two signatures differ, the SDK fails to initialize with a `DETERMINISTIC_SIGNING_REQUIRED` error, since stable encryption key derivation requires this feature. This check can be skipped with `skipDeterminismCheck: true` if you have already confirmed caching is active for your workspace.

2. **Vault init (lazy)** - on first use, `getPublicKeyByVaultID` fetches the vault's compressed secp256k1 public key from Fireblocks. The Seismic/ETH address is derived via `keccak256(uncompressed_pubkey)[last 20 bytes]` and cached in memory.

3. **Encryption key derivation** - `deriveEncryptionKey(vaultId)` signs a fixed 32-byte seed (`keccak256("Seismic Fireblocks Encryption Key Derivation")`) via Fireblocks RAW signing, then computes `SHA-256(fullSig)` → 32-byte `encryptionSk`. The same key is re-derived on every session restart without re-approval because Fireblocks' signature caching returns the same cached signature for the same payload - not because MPC ECDSA is cryptographically deterministic. Stored in process memory only.

4. **TEE session** - `seismic-viem`'s `createShieldedWalletClient` fetches the Seismic TEE public key once per client instance. `encryptionSk` is used for ECDH with the TEE to derive the AES-256-GCM calldata encryption key.

5. **Shutdown** - `sdk.shutdown()` zeroes all `encryptionSk` and `viewingKey` values before clearing the vault cache.

### SRC-20 balance reads

Standard `eth_call` returns zero for shielded `suint256` storage. The `balanceOfSigned(owner, expiry, signature)` function solves this:

1. Build `keccak256(abi.encodePacked("SRC20_BALANCE_READ", owner, expiry))` → EIP-191 wrap
2. Fireblocks RAW-signs the 32-byte hash (proves vault identity without raw key exposure)
3. Pack `r || s || v` into 65-byte Ethereum signature
4. The contract calls `ecrecover` and decrypts the balance if the signature is valid

One Fireblocks sign authorizes balance reads on any SRC-20 contract until the expiry (default: 1 hour).

### SRC-20 viewing key

A vault can register a deterministic AES-256 key in the Seismic Directory precompile (`0x1000000000000000000000000000000000000004`). After registration:

- All incoming SRC-20 `Transfer` events have `encryptedAmount` encrypted to this key
- Transaction history decrypts amounts directly from event data - no per-tx `eth_getTransactionByHash` calls
- Both sent and received transfers are decryptable (ECDH-only decryption only works for sent txs)

The viewing key is derived as `keccak256(encryptionSk)` - no extra Fireblocks round-trip after the first derivation.

### Transaction nonce strategy

On-chain transactions (sUSDC, ERC-20, SRC-20 transfers) use `eth_getTransactionCount` with the `"pending"` tag to fetch the current account nonce from the blockchain. This ensures:

- Nonces are correct across session restarts (no in-memory state drift)
- Multiple concurrent processes using the same vault don't create nonce conflicts
- Nonces increment predictably with each on-chain transaction

Off-chain signed reads (like `getSrc20Balance`) use EIP-191 message signing and **do not use transaction nonces**. This prevents nonce collision between off-chain reads and on-chain transactions.

### Transaction history sources

| Type    | Source                                        | Notes                                                                                                                                                          |
| ------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `erc20` | SocialScan `tokentx` → fallback `eth_getLogs` | Requires `SOCIALSCAN_API_KEY` for full history.                                                                                                                |
| `src20` | `eth_getLogs` + viewing key decryption        | Always uses RPC directly. Pass `contracts=<sUSDC addr>` to filter sUSDC-only. Viewing key path: zero N+1, both sent & received. Fallback ECDH path: sent only. |
| `all`   | ERC-20 + SRC-20 merged                        | Requires `SOCIALSCAN_API_KEY` for ERC-20.                                                                                                                      |

`eth_getLogs` paths scan backwards in 99,000-block windows (≈3.3 hours on Seismic testnet's 120ms blocks), stopping when enough results are collected or 10 consecutive empty windows are seen. `before`/`after` date params set the window bounds.

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
  MainSDK.ts                    Primary entry point - vault lifecycle, all SDK operations
  services/
    seismic.service.ts          Seismic RPC + seismic-viem operations + transaction history
    explorer.service.ts         SocialScan Explorer API client (native/ERC-20 history)
    fireblocks.service.ts       Fireblocks SDK wrapper
    fireblocksSigner.ts         RAW signing, signature packing, vault address derivation
  crypto/
    key-derivation.ts           SHA-256(Fireblocks fullSig) → encryptionSk
  seismic/
    abi.ts                      SRC-20 ABI (balance, balanceOfSigned, transfer)
    signature.ts                EIP-191 message builder for balanceOfSigned
  api/
    router.ts                   Express routes
    controllers/controller.ts   Route handlers
    validation/schemas.ts       Zod schemas (params, query, body)
  utils/
    constants.ts                Chain ID, RPC URLs, SEED_MESSAGE_HEX, SocialScan URLs
  types/
    custom.ts                   VaultData, Transaction, TransferType, etc.
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
npm run docs         # Generate TypeDoc API docs → served at http://localhost:8000/docs
```

---

## Seismic Testnet

- **Chain ID**: 5124
- **RPC**: `https://testnet-1.seismictest.net/rpc`
- **WSS**: `wss://testnet-1.seismictest.net/ws`
- **Faucet**: `https://faucet.seismictest.net/` (drips sUSDC; whitelist via Seismic team for unlimited requests)
- **Explorer**: `https://seismic-testnet.socialscan.io/`
- **Native asset**: SIZE (18 decimals) - not user-facing; sUSDC (`0x790701048922e265105fd6a4467a2901c2201c43`, 6 decimals) is the gas and value token in practice
- **Block time**: ~120ms (~720k blocks/day)
