import { type Hex, bytesToHex, hexToBytes } from "viem";
import { sha256 } from "@noble/hashes/sha256";

/**
 * Derives a deterministic AES-256 encryption key from a Fireblocks RAW signature.
 *
 * The key is computed as SHA-256(fullSig bytes) where fullSig is the concatenated
 * r + s + v signature returned by Fireblocks (65 bytes / 130 hex chars).
 *
 * **Why this works as a key derivation mechanism:**
 * Fireblocks MPC signatures are deterministic — signing the same message from the
 * same vault always produces the same signature without re-approval (Fireblocks caches
 * the result). So SHA-256(sig) is also deterministic: the key can be re-derived on
 * every session restart without storing any secret on disk.
 *
 * The derived key is used as `encryptionSk` passed to seismic-viem's
 * `createShieldedWalletClient()`, which uses it to perform ECDH with the Seismic TEE
 * public key and derive the AES-GCM key for encrypting transaction calldata.
 *
 * **Security note:** This key is kept in process memory only (never written to disk).
 * It should be zeroed when the SDK shuts down. A compromise of this key only affects
 * calldata confidentiality for in-flight transactions — historical transactions remain
 * protected by the Seismic TEE's own key rotation.
 *
 * @param fullSig - The `fullSig` field from a Fireblocks SignedMessage (hex string, with or without 0x)
 * @returns 32-byte hex key suitable for use as seismic-viem encryptionSk
 */
export function deriveKeyFromSignature(fullSig: string): Hex {
  const sigBytes = hexToBytes(fullSig.startsWith("0x") ? (fullSig as Hex) : `0x${fullSig}`);
  const hash = sha256(sigBytes);
  return bytesToHex(hash);
}
