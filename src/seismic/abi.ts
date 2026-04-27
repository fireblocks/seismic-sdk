/**
 * ABI for SRC-20 contracts on Seismic.
 *
 * SRC-20 is Seismic's privacy-preserving ERC-20 variant. Balances are stored as
 * encrypted suint256 values on-chain; only the Seismic TEE can decrypt them during
 * execution.
 *
 * Key differences from standard ERC-20:
 * - `balance()` returns the caller's own balance via a signed read (TEE verifies caller identity)
 * - `balanceOfSigned(owner, expiry, signature)` allows MPC wallets without a raw private key
 *   to prove ownership via an off-chain Fireblocks signature (ecrecover-verified)
 * - `transfer(to, suint256 amount)` encrypts the amount in calldata (type-0x4A transaction)
 */
export const SRC20Abi = [
  {
    type: "function",
    name: "balance",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOfSigned",
    inputs: [
      { name: "owner", type: "address", internalType: "address" },
      { name: "expiry", type: "uint256", internalType: "uint256" },
      { name: "signature", type: "bytes", internalType: "bytes" },
    ],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address", internalType: "address" },
      { name: "amount", type: "suint256", internalType: "suint256" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;
