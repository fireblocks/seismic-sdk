import { Fireblocks, SignedMessage, TransactionRequest } from "@fireblocks/ts-sdk";
import { FireblocksSigner } from "./fireblocksSigner.js";
import { FireblocksConfig } from "../types/index.js";
import { SdkApiError } from "../types/errors.js";
import {
  Logger,
  getPublicKeyForDerivationPathAndAlgorithm,
  getTxStatus,
  formatErrorMessage,
  getFinalFireblocksSDKParams,
  withRetry,
} from "../utils/index.js";

/**
 * Service class for interacting with the Fireblocks SDK.
 *
 * This service provides a high-level interface for common Fireblocks operations including:
 * - Message signing for blockchain transactions
 * - Transaction broadcasting and status tracking
 * - Vault account address management
 * - Public key retrieval for cryptographic operations
 *
 * The service wraps the Fireblocks SDK with additional error handling, logging, and
 * convenience methods for common Fireblocks operations.
 *
 * @class FireblocksService
 * @example
 * ```typescript
 * const config: FireblocksConfig = {
 *   apiKey: process.env.FIREBLOCKS_API_KEY,
 *   secretKey: process.env.FIREBLOCKS_SECRET_KEY,
 *   basePath: BasePath.US
 * };
 *
 * const service = new FireblocksService(config);
 *
 * // Get public key
 * const publicKey = await service.getAssetPublicKey(
 *   '123',    // vault account ID
 *   'ETH',    // asset ID
 *   0,        // change index
 *   0         // address index
 * );
 * ```
 */
export class FireblocksService {
  private readonly fireblocksSDK: Fireblocks;
  private readonly fireblocksSigner: FireblocksSigner;
  private readonly logger = new Logger("services:fireblocks");
  private testnet: boolean = false;

  /**
   * Creates an instance of FireblocksService.
   *
   * Initializes the Fireblocks SDK with the provided configuration, setting up
   * authentication and API endpoint configuration for all subsequent operations.
   *
   * @param fireblocksConfig - Fireblocks SDK configuration (apiKey, secretKey, basePath)
   */
  constructor(fireblocksConfig?: FireblocksConfig) {
    const { apiKey, secretKey, basePath } = getFinalFireblocksSDKParams(fireblocksConfig);
    this.fireblocksSDK = new Fireblocks({ apiKey, secretKey, basePath });
    this.testnet = fireblocksConfig?.testnet || false;
    this.fireblocksSigner = new FireblocksSigner(this.fireblocksSDK, this.testnet);
  }

  /**
   * @returns The initialized Fireblocks SDK instance of this Service class.
   */
  public getFireblocksSDK = (): Fireblocks => {
    return this.fireblocksSDK;
  };

  /**
   * Retrieves the public key associated with a given Fireblocks vault ID.
   *
   * This method converts the provided `vaultID` to a non-negative integer, validates it,
   * and then retrieves the corresponding public key using the Fireblocks SDK.
   *
   * @param vaultID - The Fireblocks vault ID as a string or number. Must be a valid non-negative integer.
   * @returns A promise that resolves to the public key as a string.
   * @throws {Error} If the vault ID is invalid or if any error occurs during the process.
   */
  public getPublicKeyByVaultID = async (vaultID: string | number): Promise<string> => {
    const id = typeof vaultID === "string" ? Number(vaultID) : vaultID;
    if (!Number.isInteger(id) || id < 0) {
      throw new Error("vaultID must be a valid non-negative integer.");
    }

    try {
      const publicKey = await getPublicKeyForDerivationPathAndAlgorithm(
        this.fireblocksSDK,
        vaultID.toString(),
        this.testnet
      );

      return publicKey;
    } catch (error: unknown) {
      throw new Error(`Failed to get public key by vault ID: ${formatErrorMessage(error)}`);
    }
  };

  /**
   * Broadcasts a transaction to the Fireblocks network and waits for signing completion.
   *
   * This method submits a transaction request to Fireblocks, monitors its status until
   * completion, and extracts the signed message data. It's primarily used for message
   * signing operations where the transaction is used to generate cryptographic signatures
   * rather than transferring assets.
   *
   * The method polls the transaction status until it reaches a terminal state and
   * returns the signature data from the completed transaction.
   *
   * @param transactionPayload - The transaction request to broadcast, containing:
   *   - Operation type (TYPED_MESSAGE for signing)
   *   - Source vault account
   *   - Message content to sign
   *   - Note/description for the transaction
   *
   * @returns A Promise resolving to an object containing:
   * - signature: The SignedMessageSignature with fullSig, r, s, v components
   * - content: Optional message content that was signed
   * - publicKey: Optional public key used for signing
   * - algorithm: Optional signature algorithm used (e.g., MPC_ECDSA_SECP256K1)
   * Returns null if the transaction completes but no signature is found
   *
   * @throws {Error} When transaction ID is undefined after creation
   * @throws {Error} When transaction creation or status polling fails
   * @throws {Error} When Fireblocks API returns an error response
   *
   * @example
   * ```typescript
   * const service = new FireblocksService(config);
   *
   * const payload: TransactionRequest = {
   *   operation: TransactionOperation.TYPED_MESSAGE,
   *   source: { type: 'VAULT_ACCOUNT', id: '123' },
   *   assetId: 'ADA',
   *   extraParameters: {
   *     rawMessageData: {
   *       messages: [{
   *         content: 'Message to sign',
   *         type: 'EIP191'
   *       }]
   *     }
   *   },
   *   note: 'Claim signature'
   * };
   *
   * const result = await service.broadcastTransaction(payload);
   *
   * if (result) {
   *   console.log('Signature:', result.signature.fullSig);
   *   console.log('Public key:', result.publicKey);
   *   console.log('Algorithm:', result.algorithm);
   * }
   * ```
   *
   * @remarks
   * This method is used internally by signMessage() but can also be called directly
   * for custom transaction payloads. The transaction status polling is handled by
   * the getTxStatus utility function, which waits for the transaction to complete.
   */
  public broadcastTransaction = async (
    transactionPayload: TransactionRequest
  ): Promise<SignedMessage | null> => {
    try {
      const transactionResponse = await withRetry(
        () =>
          this.fireblocksSDK.transactions.createTransaction({
            transactionRequest: transactionPayload,
          }),
        3,
        1000
      );

      const txId = transactionResponse.data.id;
      if (!txId) throw new Error("Transaction ID is undefined.");

      const completedTx = await getTxStatus(txId, this.fireblocksSDK);
      const signatureData = completedTx.signedMessages?.[0];
      if (signatureData?.signature) {
        return {
          signature: signatureData.signature,
          content: signatureData.content,
          publicKey: signatureData.publicKey,
          algorithm: signatureData.algorithm,
        };
      } else {
        this.logger.warn("No signed message found in response.");
        return null;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.error(`${transactionPayload.assetId} signing error:`, message);
      throw error;
    }
  };

  /**
   * Retrieves the public key for a specific vault account asset address.
   *
   * This method fetches the public key corresponding to a specific address within
   * a vault account. The address is identified by its BIP-44 derivation path
   * components (change and addressIndex). Public keys are essential for various
   * cryptographic operations including signature verification and address generation.
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @param assetId - The asset/blockchain identifier (e.g., ADA, ETH, BTC)
   * @param change - The BIP-44 change index (0 for external addresses, 1 for internal/change addresses)
   * @param addressIndex - The BIP-44 address index within the change path
   *
   * @returns A Promise resolving to the hex-encoded public key string
   *
   * @throws {Error} When no public key is found for the specified parameters
   * @throws {Error} When the Fireblocks API request fails
   * @throws {Error} When the vault account or asset doesn't exist
   *
   * @example
   * ```typescript
   * const service = new FireblocksService(config);
   *
   * // Get public key for the first external address (m/44'/1815'/0'/0/0 for Cardano)
   * const publicKey = await service.getAssetPublicKey(
   *   '123',
   *   'ADA',
   *   0,  // external chain
   *   0   // first address
   * );
   * console.log('Public key:', publicKey);
   *
   * // Get public key for a change address (m/44'/1815'/0'/1/5)
   * const changePublicKey = await service.getAssetPublicKey(
   *   '123',
   *   'ADA',
   *   1,  // internal/change chain
   *   5   // sixth change address
   * );
   *
   * // Get Ethereum public key
   * const ethPublicKey = await service.getAssetPublicKey(
   *   '456',
   *   'ETH',
   *   0,
   *   0
   * );
   *
   * // Use public key for signature verification
   * const signature = await service.signMessage({...});
   * const publicKey = await service.getAssetPublicKey(
   *   '123',
   *   'ADA'
   * );
   * // Verify signature with public key...
   * ```
   *
   * @remarks
   * The derivation path follows BIP-44 standard:
   * m/44'/coin_type'/account'/change/address_index
   *
   * For most use cases:
   * - change = 0: External addresses (for receiving)
   * - change = 1: Internal addresses (for change)
   * - addressIndex = 0: First address at that change level
   *
   * The returned public key is in hex format and can be used for:
   * - Signature verification
   * - Address derivation
   * - Other cryptographic operations
   */
  public getAssetPublicKey = async (
    vaultAccountId: string,
    assetId: string,
    change: number = 0,
    addressIndex: number = 0
  ): Promise<string> => {
    try {
      const response = await this.fireblocksSDK.vaults.getPublicKeyInfoForAddress({
        vaultAccountId,
        assetId,
        change,
        addressIndex,
      });

      const publicKey = response.data.publicKey;

      if (!publicKey) {
        throw new Error(
          `Error fetching public key for vault account ${vaultAccountId} on ${assetId}`
        );
      }

      return publicKey;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new Error(
        `Failed to get public key for vault account ${vaultAccountId} on ${assetId}: ${message}`
      );
    }
  };

  /**
   * Signs a transaction with the given vault account ID using the Fireblocks SDK and Fireblocks-signer.
   *
   * This method prepares and sends a transaction from the specified sender to the recipient
   * // descripe parameters
   * @param content - The content of the transaction to sign.
   * @param vaultAccountId - The Fireblocks vault account ID as a string or number.
   * @param txNote - An optional note for the transaction.
   * @returns A promise that resolves to the signature when the transaction is successfully signed.
   * @throws {Error} If any parameter is invalid or if the transaction fails.
   **/

  public signTransaction = async (
    content: string,
    vaultAccountId: string,
    purpose?: string
  ): Promise<SignedMessage> => {
    try {
      return await this.fireblocksSigner.rawSign(
        content,
        vaultAccountId,
        purpose || "sign-transaction"
      );
    } catch (error) {
      if (error instanceof SdkApiError) throw error;
      const msg = formatErrorMessage(error);
      this.logger.error(`Failed to sign transaction: ${msg}`);
      throw new SdkApiError(msg, 500, "SIGN_FAILED", undefined, "FireblocksService");
    }
  };
}
