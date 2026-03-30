// Use this file to define constants specific to the new blockchain

/**
 * Derivation Path Constants
 *
 * Adjust the values below to match the derivation path structure of the target blockchain.
 * The purpose, coinType, change, and addressIndex should be set according to the blockchain's standards.
 *
 * Example for Bitcoin:
 * {
 *   purpose: 44,
 *   coinType: 0, // Bitcoin's coin type
 *   change: 0,
 *   addressIndex: 0,
 * }
 *
 */

import { SignedMessageAlgorithmEnum } from "@fireblocks/ts-sdk";
import { TokenInfo, TokenType } from "../types/index.js";

/**
 * Derivation Path Structure
 *
 * Define the derivation path structure for generating addresses on the blockchain.
 * Adjust the values as necessary.
 */
export const derivationPath = {
  purpose: 44,
  coinType: "<PUT_BLOCKCHAIN_COIN_TYPE_HERE>", // As number
  change: 0,
  addressIndex: 0,
};

export const signingAlgorithm = SignedMessageAlgorithmEnum.EcdsaSecp256K1; // Adjust as needed, Put the appropriate SignedMessageAlgorithmEnum value here

/**
 * API and Chain Information Constants
 *
 * Define constants related to the blockchain's API endpoints and chain information.
 * Add more fields as necessary.
 */
export const api_constants = {
  mainnet_rpc: "",
  testnet_rpc: "",
  testnet_explorer: "", // if needed to fetch history
  mainnet_explorer: "", // if needed to fetch history
};

/**
 * Chain Information Constants
 *
 * Define constants related to the blockchain, such as decimals and symbol for native coin.
 * Adjust the values as necessary.
 */
export const chain_info = {
  coinDecimals: "<PUT_COIN_DECIMALS_HERE>", // As number
  coinSymbol: "",
};

/** Pagination Defaults
 *
 * Define default pagination settings for API requests.
 * Adjust the values as necessary.
 */
export const pagination_defaults = {
  // Adjust as needed
  page: 0,
  limit: 50,
};

/** Fungible Token Information
 *
 * Map of TokenType to TokenInfo for the supported fungible tokens on the blockchain.
 * Add or modify entries as necessary.
 * 
 * example: 
 * 
 * export const ftInfo: Partial<Record<TokenType, TokenInfo>> = {
  [TokenType.ShitCoinExample]: {
    tokenID: "kI3Y2ZsH8P7D5...",
    tokenName: "EXMPL",
    decimals: 6,
  },
};
 */
export const ftInfo: Partial<Record<TokenType, TokenInfo>> = {
  [TokenType.ShitCoinExample]: {
    tokenID: "<PUT_TOKEN_ID_HERE>",
    tokenName: "<PUT_TOKEN_NAME_HERE>",
    decimals: 0, // Placeholder, set actual decimals
  },
};
