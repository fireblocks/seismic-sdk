import { SignedMessageAlgorithmEnum } from "@fireblocks/ts-sdk";
import { keccak256 } from "viem";
import { TokenInfo, TokenType } from "../types/index.js";

/**
 * Derivation path for Seismic (EVM-compatible chain).
 * Coin type 60 is the BIP44 standard for Ethereum and all EVM-compatible chains.
 */
export const derivationPath = {
  purpose: 44,
  coinType: 60, // EVM standard
  change: 0,
  addressIndex: 0,
};

export const signingAlgorithm = SignedMessageAlgorithmEnum.EcdsaSecp256K1;

/**
 * Fireblocks asset ID used for RAW signing.
 *
 * Seismic is not natively supported by Fireblocks, so we use RAW signing to sign
 * arbitrary payloads with the vault's secp256k1 key. RAW signing is a multi-asset
 * Fireblocks feature — the asset ID is a routing mechanism, not a cryptographic choice.
 * "BTC_TEST" is the standard Fireblocks asset for arbitrary RAW signing.
 */
export const FIREBLOCKS_RAW_SIGN_ASSET_ID = "BTC_TEST";

/**
 * Seismic network chain IDs.
 */
export const SEISMIC_CHAIN_ID = {
  testnet: 5124,
  // mainnet: not yet live
} as const;

/**
 * RPC and explorer endpoints for Seismic.
 */
export const api_constants = {
  mainnet_rpc: "", // Seismic mainnet not yet live
  testnet_rpc: "https://gcp-1.seismictest.net/rpc",
  testnet_explorer: "https://seismic-testnet.socialscan.io/",
  mainnet_explorer: "",
};

/**
 * Native coin info for Seismic.
 * Seismic's native asset is ETH — it is an EVM-compatible L1.
 */
export const chain_info = {
  coinDecimals: 18,
  coinSymbol: "ETH",
};

/**
 * Fixed 32-byte seed message used for deterministic encryption key derivation.
 *
 * Fireblocks MPC signatures are deterministic: signing the same message from the
 * same vault always returns the same signature without re-approval. We exploit this
 * to derive a reproducible encryptionSk (SHA-256 of the signature) that acts as the
 * client's private key for ECDH with the Seismic TEE — no persistent key storage needed.
 *
 * This constant must never change once deployed (changing it invalidates all derived keys).
 */
export const SEED_MESSAGE_HEX: `0x${string}` = keccak256(
  new TextEncoder().encode("Seismic Fireblocks Encryption Key Derivation")
);

export const pagination_defaults = {
  page: 0,
  limit: 50,
};

/**
 * SRC-20 token info.
 * Token type SRC20 represents Seismic's privacy-preserving ERC-20 variant
 * that stores balances as encrypted suint256 values on-chain.
 */
export const ftInfo: Partial<Record<TokenType, TokenInfo>> = {
  [TokenType.SRC20]: {
    tokenID: TokenType.SRC20,
    tokenName: "SRC20",
    decimals: 18,
  },
};
