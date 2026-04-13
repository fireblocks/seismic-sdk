import fs from "fs";
import {
  Fireblocks,
  FireblocksResponse,
  SignedMessageAlgorithmEnum,
  TransactionResponse,
  TransactionStateEnum,
  VaultsApiGetPublicKeyInfoRequest,
} from "@fireblocks/ts-sdk";
import { Logger, derivationPath, formatErrorMessage } from "./index.js";

const logger = new Logger("utils:fireblocks");

/**
 * Polls a Fireblocks transaction until it reaches a terminal state.
 *
 * Continuously monitors transaction status and waits for completion or broadcasting state.
 * Logs status changes and throws errors for failure states (blocked, cancelled, failed, rejected).
 *
 * @param txId - The Fireblocks transaction ID to monitor
 * @param fireblocks - Initialized Fireblocks SDK instance for API calls
 * @param pollingInterval - Optional interval between status checks in milliseconds (default: 1000ms)
 *
 * @returns Promise resolving to the final TransactionResponse when completed or broadcasting
 *
 * @throws {Error} If transaction is blocked - policy or compliance issue
 * @throws {Error} If transaction is cancelled - user or system cancellation
 * @throws {Error} If transaction fails - signature failure or network error
 * @throws {Error} If transaction is rejected - approval policy rejection
 *
 * @remarks
 * **Terminal Success States:**
 * - `COMPLETED` - Transaction fully processed and confirmed
 * - `BROADCASTING` - Transaction submitted to blockchain network
 *
 * **Terminal Failure States:**
 * - `BLOCKED` - Blocked by policy or compliance
 * - `CANCELLED` - Manually cancelled
 * - `FAILED` - Technical failure during processing
 * - `REJECTED` - Rejected by approval policy
 *
 * **Transient States** (will continue polling):
 * - `SUBMITTED` - Submitted for processing
 * - `QUEUED` - Waiting in queue
 * - `PENDING_SIGNATURE` - Awaiting signature
 * - `PENDING_AUTHORIZATION` - Awaiting approval
 * - `PENDING_3RD_PARTY_MANUAL_APPROVAL` - Waiting for external approval
 * - `PENDING_3RD_PARTY` - Processing with third party
 *
 * @example
 * ```typescript
 * const txResponse = await fireblocks.transactions.createTransaction({...});
 * const completedTx = await getTxStatus(txResponse.data.id, fireblocks, 2000);
 * const signature = completedTx.signedMessages?.[0]?.signature;
 * ```
 */
export const getTxStatus = async (
  txId: string,
  fireblocks: Fireblocks,
  pollingInterval: number = 1000
): Promise<TransactionResponse> => {
  try {
    let txResponse: FireblocksResponse<TransactionResponse> =
      await fireblocks.transactions.getTransaction({ txId });
    let lastStatus = txResponse.data.status;

    logger.info(
      `Transaction ${txResponse.data.id} is currently at status - ${txResponse.data.status}`
    );

    // Poll until terminal state
    while (
      txResponse.data.status !== TransactionStateEnum.Completed &&
      txResponse.data.status !== TransactionStateEnum.Broadcasting
    ) {
      await new Promise((resolve) => setTimeout(resolve, pollingInterval));

      txResponse = await fireblocks.transactions.getTransaction({
        txId: txId,
      });

      if (txResponse.data.status !== lastStatus) {
        logger.info(
          `Transaction ${txResponse.data.id} status changed: ${lastStatus} → ${txResponse.data.status}`
        );
        lastStatus = txResponse.data.status;
      }

      switch (txResponse.data.status) {
        case TransactionStateEnum.Blocked:
        case TransactionStateEnum.Cancelled:
        case TransactionStateEnum.Failed:
        case TransactionStateEnum.Rejected:
          throw new Error(
            `Transaction ${txResponse.data.id} failed with status: ${txResponse.data.status}\nSub-Status: ${txResponse.data.subStatus}`
          );
        default:
          break;
      }
    }

    logger.info(
      `Transaction ${txResponse.data.id} reached terminal state: ${txResponse.data.status}`
    );

    return txResponse.data;
  } catch (error: unknown) {
    logger.error(
      `Error polling transaction ${txId}:`,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
};

/**
 * Retrieves the public key for a given digital signing algorithm and vault account ID using a specified derivation path.
 * @param fireblocksSDK
 * @param vaultAccountId
 * @returns The public key as a string.
 * @throws {Error} if unable to fetch the public key for any reason.
 */
export const getPublicKeyForDerivationPathAndAlgorithm = async (
  fireblocksSDK: Fireblocks,
  vaultAccountId: string,
  testnet: boolean = false
): Promise<string> => {
  // Fireblocks testnet workspaces always use coin type 1 regardless of the blockchain.
  // Mainnet workspaces use the SLIP-44 coin type (60 for EVM chains).
  const coinType = testnet ? 1 : derivationPath.coinType;
  const requestParams: VaultsApiGetPublicKeyInfoRequest = {
    derivationPath: `[${derivationPath.purpose}, ${coinType}, ${vaultAccountId}, ${derivationPath.change}, ${derivationPath.addressIndex}]`,
    algorithm: SignedMessageAlgorithmEnum.EcdsaSecp256K1,
    compressed: true,
  };
  try {
    const response = await fireblocksSDK.vaults.getPublicKeyInfo(requestParams);
    const publicKey = response.data.publicKey;
    if (!publicKey) {
      throw new Error("Public key not found for the given vault account ID.");
    }
    return publicKey;
  } catch (error: unknown) {
    throw new Error(`Error fetching public key: ${formatErrorMessage(error)}`);
  }
};

/**
 * Validates Fireblocks API credentials including API key format, secret key file existence, and vault account ID type.
 * @param apiKey
 * @param secretKeyPath
 * @param vaultAccountId
 * @throws {Error} if any validation fails.
 */
export const validateApiCredentials = (
  apiKey: string,
  secretKeyPath: string,
  vaultAccountId?: string | number
): void => {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("InvalidConfig: apiKey must be a non-empty string");
  }
  if (!secretKeyPath || typeof secretKeyPath !== "string" || !secretKeyPath.trim()) {
    throw new Error("InvalidConfig: secretKeyPath must be a non-empty string");
  }
  // Validate API key is a valid UUID (v4)
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidV4Regex.test(apiKey)) {
    throw new Error("API key is not a valid UUID v4.");
  }

  // Validate secret key: accept either a PEM key string or a valid file path
  const isPemContent = secretKeyPath.trimStart().startsWith("-----BEGIN");
  if (!isPemContent && (!fs.existsSync(secretKeyPath) || !fs.statSync(secretKeyPath).isFile())) {
    throw new Error(`Secret key file does not exist at path: ${secretKeyPath}`);
  }

  // Validate vaultAccountId if provided
  if (vaultAccountId !== undefined) {
    if (
      typeof vaultAccountId !== "number" &&
      (typeof vaultAccountId !== "string" ||
        isNaN(Number(vaultAccountId)) ||
        vaultAccountId.trim() === "")
    ) {
      throw new Error("vaultAccountId must be a number or a string representing a number.");
    }
  }
};
