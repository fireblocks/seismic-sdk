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

/**
 * Fireblocks asset ID used for RAW signing.
 *
 * Seismic is not natively supported by Fireblocks, so we use RAW signing to sign
 * arbitrary payloads with the vault's secp256k1 key. RAW signing is a multi-asset
 * Fireblocks feature - the asset ID is a routing mechanism, not a cryptographic choice.
 * "BTC_TEST" is the standard Fireblocks asset for arbitrary RAW signing.
 */
export const FIREBLOCKS_RAW_SIGN_ASSET_ID = "BTC_TEST";

/**
 * Seismic network chain IDs.
 */
export const SEISMIC_CHAIN_ID = {
  testnet: 5124,
  mainnet: 0, // placeholder, update when Seismic mainnet launches
} as const;

/**
 * RPC and explorer endpoints for Seismic.
 */
export const api_constants = {
  mainnet_rpc: "", // Seismic mainnet not yet live
  testnet_rpc: "https://gcp-1.seismictest.net/rpc",
};

/**
 * Native coin info for Seismic.
 * Seismic's native asset is ETH - it is an EVM-compatible L1.
 */
export const chain_info = {
  coinDecimals: 18,
  coinSymbol: "ETH",
};

/**
 * Fixed 32-byte seed message used for deterministic encryption key derivation.
 *
 * Fireblocks signatures are deterministic: signing the same message from the
 * same vault always returns the same signature without re-approval.
 * We derive a reproducible encryptionSk (SHA-256 of the signature) that acts as the
 * client's private key for ECDH with the Seismic TEE - no persistent key storage needed.
 *
 * This constant must never change once deployed (changing it invalidates all derived keys).
 */
export const SEED_MESSAGE_HEX: `0x${string}` = keccak256(
  new TextEncoder().encode("Seismic Fireblocks Encryption Key Derivation")
);

/**
 * Default token decimals for ERC-20 contracts that don't implement decimals()
 * or when the caller doesn't specify. 18 is the ERC-20 standard default.
 */
export const DEFAULT_TOKEN_DECIMALS = 18;

/**
 * Standard ERC-20 function selectors (keccak256 of the function signature, first 4 bytes).
 * Used for raw eth_call construction without importing a full ABI.
 */
/**
 * ERC-20 Transfer event topic: keccak256("Transfer(address,address,uint256)")
 * Used as topics[0] filter in eth_getLogs to find token transfer events.
 */
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * SRC-20 Transfer event topic: keccak256("Transfer(address,address,bytes32,bytes)")
 * Seismic's privacy-preserving ERC-20 emits a different Transfer signature - the amount
 * is AES-GCM encrypted and stored as bytes. Standard ERC-20 indexers (tokentx) will not
 * pick up SRC-20 transfers; use getLogs with this topic instead.
 */
export const SRC20_TRANSFER_TOPIC = keccak256(
  new TextEncoder().encode("Transfer(address,address,bytes32,bytes)")
);

/**
 * SocialScan Explorer API base URLs.
 * Supports: txlist (native ETH), txlistinternal, tokentx (ERC-20), getLogs (SRC-20).
 * Requires SOCIALSCAN_API_KEY env var (get a key at developer.socialscan.io).
 *
 * NOTE: Only testnet is currently available - mainnet URL is a placeholder for when
 * Seismic mainnet launches and SocialScan adds support.
 */
export const SOCIALSCAN_API_URL = {
  testnet: "https://api.socialscan.io/seismic-testnet/v1/developer/api",
  mainnet: "", // not yet available
} as const;

export const ERC20_SELECTORS = {
  name: "0x06fdde03", // name()
  symbol: "0x95d89b41", // symbol()
  decimals: "0x313ce567", // decimals()
  totalSupply: "0x18160ddd", // totalSupply()
  balanceOf: "0x70a08231", // balanceOf(address)
  transfer: "0xa9059cbb", // transfer(address,uint256)
} as const;

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
