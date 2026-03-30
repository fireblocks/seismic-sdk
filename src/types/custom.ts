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

import { BasePath } from "@fireblocks/ts-sdk";
import { GetTransactionsHistoryOpts } from "./index.js";

/**
 * Response type for getting native balance
 */
export type GetNativeBalanceResponse = {
  success: boolean;
  balance?: number;
  error?: string;
};

/**
 * Response type for getting fungible token balances
 */
export type GetFtBalancesResponse = {
  success: boolean;
  data?: {
    token: TokenType;
    balance: number;
  }[];
  error?: string;
};

/** Configuration options for initializing the Fireblocks SDK
 */
export interface FireblocksConfig {
  apiKey: string;
  apiSecret: string; // can be path or inline string
  basePath?: BasePath;
  testnet?: boolean;
}

/** Response type for creating a transaction,
 * if successful includes the transaction hash that was created, else includes an error message.
 */
export type CreateTransactionResponse = {
  success: boolean;
  txHash?: string;
  error?: string;
};

/**
 * Response type for getting transaction history
 * Includes an array of transactions (if successful) or an error message.
 */
export type GetTransactionHistoryResponse = {
  success: boolean;
  data?: Transaction[];
  error?: string;
};

export type GetTransactionHistoryFromIndexerOpts = {
  address: string;
  limit?: number;
  offset?: number;
};

export type GetTransactionHistoryParams =
  | GetTransactionHistoryFromIndexerOpts
  | GetTransactionsHistoryOpts;

/**
 * Generic unsigned transaction object returned by buildUnsignedTransaction / serializeTransaction.
 * Implementors should extend this with blockchain-specific fields.
 */
export interface UnsignedTransaction {
  unsignedTx?: unknown;
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
  transaction_hash: string;
  timestamp?: string | number;
  success: boolean;
};

export enum TransactionType {
  Native = "NATIVE",
  FungibleToken = "FUNGIBLE_TOKEN",
}

/**
 * Token types enumeration for different blockchain assets, including native coins and custom tokens.
 * can be names or identifiers depending on the blockchain, adjust as needed.
 */
export enum TokenType {
  Native = "NATIVE", // Represents the blockchain's native coin, e.g., ETH for Ethereum, BTC for Bitcoin, adjust name as needed
  ShitCoinExample = "RANDOM_SHITCOIN_EXAMPLE", // Example of a custom fungible token type for the blockchain, adjust as needed
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
 * Enumeration for different blockchain network environments.
 * Some blockchains need the network name or identifier to be specified with API requests.
 * Adjust names as needed based on supported networks.
 */
export enum Networks {
  Mainnet = "example_mainnet", // Adjust name as needed
  Testnet = "example_testnet", // Adjust name as needed
}

export type SDKResponse =
  | GetNativeBalanceResponse
  | string
  | CreateTransactionResponse
  | GetTransactionHistoryResponse;

/**
 * Per-vault identity state cached in MainSDK's vault map.
 * Populated lazily on first use of each vault account.
 */
export interface VaultData {
  vaultAccountId: string;
  address: string;
  publicKey: string;
}
