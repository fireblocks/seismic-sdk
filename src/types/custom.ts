/**
 * Custom Types File
 *
 * This file is a placeholder for custom type definitions that are specific to your implementation.
 *
 * Examples of what you might add here:
 * - Custom blockchain-specific data structures
 * - API response types from third-party services
 * - Domain-specific models (tokens, NFTs, staking rewards, etc.)
 * - Integration-specific interfaces
 *
 * Guidelines:
 * - Keep types organized and well-documented
 * - Use clear, descriptive names
 * - Export all types that will be used across the codebase
 * - Consider grouping related types together
 *
 * Example:
 * ```typescript
 * export interface CustomTokenMetadata {
 *   name: string;
 *   symbol: string;
 *   decimals: number;
 *   totalSupply: string;
 * }
 *
 * export interface StakingReward {
 *   epoch: number;
 *   amount: string;
 *   claimed: boolean;
 * }
 * ```
 *
 */

// Add your custom types below this line (Below are some generic Request/Response types for SDK functions, adjusted as needed.)

import { type Hex } from "viem";
import { BasePath } from "@fireblocks/ts-sdk";
import { GetTransactionsHistoryOpts } from "./index.js";


export interface TokenBalance {
  contractAddress: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  balance?: number;
  rawBalance?: string;
}

export interface TokenBalancesResult {
  erc20?: TokenBalance[];
  src20?: TokenBalance[];
  erc20Error?: string;
  src20Error?: string;
}

/** Configuration options for initializing the Fireblocks SDK
 */
export interface FireblocksConfig {
  apiKey: string;
  apiSecret: string; // can be path or inline string
  basePath?: BasePath;
  testnet?: boolean;
}


export type GetTransactionHistoryFromIndexerOpts = {
  address: string;
  /**
   * Asset type to fetch:
   * - "native"  → ETH transfers (requires SOCIALSCAN_API_KEY; no logs on RPC)
   * - "erc20"   → Standard ERC-20 Transfer events
   * - "src20"   → Seismic SRC-20 Transfer events (encrypted amounts, requires contracts filter)
   * - "all"     → Native + ERC-20 merged (requires SOCIALSCAN_API_KEY for native)
   * Defaults to "erc20" (always available via eth_getLogs fallback).
   */
  type?: "native" | "erc20" | "src20" | "all";
  /** Hex block number or "earliest"/"latest". Defaults to "earliest". */
  fromBlock?: string;
  /** Hex block number or "earliest"/"latest". Defaults to "latest". */
  toBlock?: string;
  /**
   * Return transactions on or before this date (YYYY-MM-DD).
   * Converted internally to an approximate block number using the current block and ~120ms block time.
   * Overrides toBlock if both are provided.
   */
  before?: string;
  /**
   * Return transactions on or after this date (YYYY-MM-DD).
   * Converted internally to an approximate block number using the current block and ~120ms block time.
   * Overrides fromBlock if both are provided.
   */
  after?: string;
  /** Optional contract addresses to filter by. If omitted, scans all contracts. */
  contracts?: string[];
  limit?: number;
  offset?: number;
  /**
   * Vault's encryption private key (32-byte hex).
   * When provided for type "src20", each transaction's encrypted calldata is
   * decrypted client-side and the plaintext amount is returned instead of 0.
   * Derive this via MainSDK.deriveEncryptionKey(vaultId).
   */
  encryptionSk?: Hex;
  /**
   * AES viewing key (32-byte hex) registered in the Seismic Directory precompile.
   * When provided, amounts are decrypted directly from Transfer event data - no per-tx RPC calls.
   * Takes priority over encryptionSk. Derive via MainSDK.deriveViewingKey(vaultId).
   */
  viewingKey?: Hex;
};

export type GetTransactionHistoryParams =
  | GetTransactionHistoryFromIndexerOpts
  | GetTransactionsHistoryOpts;

/**
 * Generic unsigned transaction object returned by buildUnsignedTransaction / serializeTransaction.
 * Implementors should extend this with blockchain-specific fields.
 */
export interface EvmTxFields {
  from: string;
  to: string;
  value: string;
  data: string;
  nonce: string;
  gasPrice: string;
  gas: string;
}

export interface UnsignedTransaction {
  unsignedTx?: unknown;
  /** EIP-155 keccak256 hash of the RLP-encoded tx - this is what Fireblocks signs */
  signingHash?: string;
  /** Raw EVM transaction fields, needed to assemble the signed RLP after signing */
  evmTxFields?: EvmTxFields;
  signature?: unknown;
  [key: string]: unknown;
}

/**
 * Representation of a blockchain transaction, including type, sender, recipient, amount, and status.
 * this is a generic structure and can be extended with more fields as needed.
 */
export type Transaction = {
  type: TransactionType.Native | TransactionType.FungibleToken;
  tokenInfo?: TokenInfo;
  sender: string;
  recipient: string;
  amount: number;
  /** Raw AES-GCM ciphertext from a SRC-20 Transfer event. Present only for SRC-20 txs. */
  encryptedAmount?: string;
  transaction_hash: string;
  timestamp?: string; // ISO-8601 date string
  success: boolean;
};

export enum TransactionType {
  Native = "NATIVE",
  FungibleToken = "FUNGIBLE_TOKEN",
}

/**
 * Token types for Seismic.
 * SRC20 is Seismic's privacy-preserving ERC-20 variant - balances are stored
 * as encrypted suint256 values and require signed reads to query.
 */
export enum TokenType {
  Native = "NATIVE",
  SRC20 = "SRC20",
}

/** Information about a specific token, including its ID, name, and decimal precision.
 * add/remove fields as needed.
 */
export type TokenInfo = {
  tokenID: string | TokenType; // TokenType could be defined as the token identifier
  tokenName: string;
  decimals: number;
};
/**
 * Seismic network environments.
 * Only testnet (chain ID 5124) is currently live.
 */
export enum Networks {
  Mainnet = "seismic_mainnet",
  Testnet = "seismic_testnet",
}


/**
 * Per-vault identity state cached in MainSDK's vault map.
 * Populated lazily on first use of each vault account.
 * encryptionSk is derived once per session from a deterministic Fireblocks RAW signature
 * (SHA-256 of fullSig over SEED_MESSAGE) and cached in process memory only - never on disk.
 */
export interface VaultData {
  vaultAccountId: string;
  address: string;
  publicKey: string;
  encryptionSk?: string; // 32-byte hex; in-memory only, zeroed on shutdown
  viewingKey?: string; // keccak256(encryptionSk); in-memory only, zeroed on shutdown
  viewingKeyRegistered?: boolean; // cached Directory registration status
}

/**
 * Transfer type for POST /api/:vaultId/transfer.
 * ETH  - plain ETH transfer
 * ERC20 - standard plaintext ERC-20 transfer
 * SRC20 - Seismic shielded transfer (type 0x4A, AES-GCM encrypted calldata)
 */
export type TransferType = "ETH" | "ERC20" | "SRC20";

/**
 * Response types for getter methods that previously threw errors.
 * Standardized to return { success, data?, error? } for consistency.
 */
