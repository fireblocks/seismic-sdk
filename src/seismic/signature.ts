import { type Hex, type Address, keccak256, encodePacked } from "viem";

/**
 * Builds the 32-byte message hash for a SRC-20 signed balance read.
 *
 * SRC-20 balances are stored as encrypted suint256 on-chain. Standard eth_call
 * returns zero because the TEE cannot verify caller identity over an unauthenticated
 * RPC call. The contract's balanceOfSigned() function solves this: the client signs
 * a hash of (owner, expiry) off-chain, and the contract uses ecrecover to verify
 * that the signature came from the owner's address before decrypting the balance.
 *
 * The message is EIP-191 personal_sign wrapped so the contract can use a standard
 * ecrecover implementation without a custom prefix.
 *
 * Message construction (mirrors the Solidity contract):
 *   inner  = keccak256(abi.encodePacked("SRC20_BALANCE_READ", owner, expiry))
 *   outer  = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner))
 *
 * The outer hash is what Fireblocks must sign - the contract runs the same derivation
 * and calls ecrecover(outer, v, r, s) to recover the signer address.
 *
 * The signature is token-agnostic: one Fireblocks sign authorizes balance reads on
 * any SRC-20 contract until expiry.
 *
 * @param owner  - Address whose balance is being read
 * @param expiry - Unix timestamp (seconds) after which the signature is invalid
 * @returns 32-byte EIP-191 signed hash - pass this directly to FireblocksSigner.rawSign()
 */
export const buildBalanceReadMessage = (owner: Address, expiry: bigint): Hex => {
  const inner = keccak256(
    encodePacked(["string", "address", "uint256"], ["SRC20_BALANCE_READ", owner, expiry])
  );

  return keccak256(
    encodePacked(["string", "bytes32"], ["\x19Ethereum Signed Message:\n32", inner])
  );
};

/**
 * Creates an expiry timestamp for a signed balance read.
 * Default is 1 hour from now, which is generous for a single SDK operation.
 *
 * @param hoursFromNow - How many hours until the signature expires (default 1)
 * @returns Unix timestamp as bigint
 */
export const createExpiry = (hoursFromNow: number = 1): bigint => {
  return BigInt(Math.floor(Date.now() / 1000) + hoursFromNow * 3600);
};
