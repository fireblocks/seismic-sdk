import {
  Fireblocks,
  TransactionOperation,
  TransferPeerPathType,
  TransactionRequest,
  TransactionResponse,
  FireblocksResponse,
  TransactionStateEnum,
  SignedMessageAlgorithmEnum,
  SignedMessage,
} from "@fireblocks/ts-sdk";
import { type Hex, concat, pad, toHex } from "viem";
import {
  derivationPath,
  formatErrorMessage,
  FIREBLOCKS_RAW_SIGN_ASSET_ID,
} from "../utils/index.js";
import { Logger } from "../utils/logger.js";
import { SdkApiError } from "../types/errors.js";

export class FireblocksSigner {
  private readonly logger = new Logger("services:fireblocks-signer");
  private readonly coinType: number;

  constructor(
    public fireblocks: Fireblocks,
    testnet: boolean = false
  ) {
    // Fireblocks testnet workspaces always use coin type 1 for all assets.
    // Mainnet workspaces use SLIP-44 standard (60 for EVM chains).
    this.coinType = testnet ? 1 : derivationPath.coinType;
  }

  /**
   * Builds the RAW signing transaction payload.
   *
   * Fireblocks has two mutually exclusive RAW signing modes:
   *
   * **Testnet** — "natively supported asset" mode:
   *   Uses `assetId: "BTC_TEST"` (coin type 1) + `source.id`. Fireblocks infers the
   *   key path from the asset + vault account. No `derivationPath` in the message.
   *
   * **Mainnet** — "unsupported asset" mode:
   *   No `assetId`, `source` has no `id`. The full BIP-44 path (coin type 60) is
   *   embedded in the message's `derivationPath`. Requires `algorithm` in rawMessageData.
   */
  createTransactionPayload = (
    vaultAccountId: string,
    hexContent: string,
    purpose: string
  ): TransactionRequest => {
    const note = `[Seismic SDK] vault:${vaultAccountId} | ${purpose} | ${new Date().toISOString()}`;

    if (this.coinType === 1) {
      // Testnet: BTC_TEST asset uses m/44'/1'/vaultId'/0/0 — matches Seismic testnet key
      return {
        note,
        assetId: FIREBLOCKS_RAW_SIGN_ASSET_ID,
        source: { type: TransferPeerPathType.VaultAccount, id: vaultAccountId },
        operation: TransactionOperation.Raw,
        extraParameters: {
          rawMessageData: {
            messages: [{ content: hexContent }],
          },
        },
      };
    }

    // Mainnet: explicit derivation path (coin type 60) — no assetId, no source.id
    return {
      note,
      source: { type: TransferPeerPathType.VaultAccount },
      operation: TransactionOperation.Raw,
      extraParameters: {
        rawMessageData: {
          messages: [
            {
              content: hexContent,
              derivationPath: [
                derivationPath.purpose, // 44
                this.coinType, // 60
                parseInt(vaultAccountId), // vault account index
                derivationPath.change, // 0
                derivationPath.addressIndex, // 0
              ],
            },
          ],
          algorithm: SignedMessageAlgorithmEnum.EcdsaSecp256K1,
        },
      },
    };
  };

  getTxStatus = async (txId: string): Promise<TransactionResponse> => {
    let response: FireblocksResponse<TransactionResponse> =
      await this.fireblocks.transactions.getTransaction({ txId });
    let tx: TransactionResponse = response.data;

    this.logger.debug(`tx:${txId} status=${tx.status}`);

    while (tx.status !== TransactionStateEnum.Completed) {
      await new Promise((resolve) => setTimeout(resolve, 3000));

      response = await this.fireblocks.transactions.getTransaction({ txId });
      tx = response.data;

      switch (tx.status) {
        case TransactionStateEnum.Blocked:
        case TransactionStateEnum.Cancelled:
        case TransactionStateEnum.Failed:
        case TransactionStateEnum.Rejected:
          throw new Error(`RAW signing failed | txId:${tx.id} | status:${tx.status}`);
        default:
          this.logger.debug(`tx:${txId} status=${tx.status}`);
          break;
      }
    }
    return tx;
  };

  /**
   * Signs an arbitrary 32-byte payload via Fireblocks RAW signing.
   *
   * Returns the full SignedMessage object, which includes both the signature (r/s/v/fullSig)
   * and the vault's compressed secp256k1 public key. needed for address derivation and
   * encryption key derivation.
   *
   * Note: Fireblocks returns v as 0 or 1. Use packSignature() to normalize to 27/28
   * and zero-pad r/s before use with ecrecover.
   *
   * @param content        - 32-byte message to sign (hex, with or without 0x prefix)
   * @param vaultAccountId - Fireblocks vault account ID
   * @param purpose        - Short label describing why this signature is being requested.
   *                         Shown in the Fireblocks console and activity log — make it
   *                         descriptive so ops can identify the operation without needing
   *                         to correlate SDK logs
   *                         (e.g. "derive-encryption-key", "src20-balance-read", "seismic-transfer")
   */
  rawSign = async (
    content: string,
    vaultAccountId: string,
    purpose: string = "raw-sign"
  ): Promise<SignedMessage> => {
    try {
      if (typeof content !== "string") {
        throw new Error("Content for raw signing must be a hex string");
      }

      const hexContent = content.startsWith("0x") ? content.slice(2) : content;

      if (hexContent.length !== 64) {
        throw new Error(
          `Raw message must be exactly 32 bytes (64 hex chars), got ${hexContent.length} chars`
        );
      }

      const transactionPayload = this.createTransactionPayload(vaultAccountId, hexContent, purpose);

      this.logger.info(`Submitting RAW sign | vault:${vaultAccountId} | purpose:${purpose}`);

      const transactionResponse = await this.fireblocks.transactions.createTransaction({
        transactionRequest: transactionPayload,
      });

      const txId = transactionResponse.data.id;
      if (!txId) {
        throw new Error("Transaction ID is undefined.");
      }

      this.logger.debug(
        `RAW sign submitted | txId:${txId} | vault:${vaultAccountId} | purpose:${purpose}`
      );

      const txInfo = await this.getTxStatus(txId);

      const signedMessage = txInfo.signedMessages?.[0];
      if (!signedMessage) {
        throw new Error("No signed messages returned from Fireblocks");
      }

      this.logger.info(`RAW sign completed | txId:${txId} | vault:${vaultAccountId}`);

      return signedMessage;
    } catch (error) {
      if (error instanceof SdkApiError) throw error;
      const msg = formatErrorMessage(error);
      this.logger.error(`RAW sign failed | vault:${vaultAccountId} | purpose:${purpose} | ${msg}`);
      throw new SdkApiError(msg, 500, "RAW_SIGN_FAILED", undefined, "FireblocksSigner");
    }
  };

  /**
   * Packs r/s/v from a Fireblocks SignedMessage signature into a standard 65-byte
   * Ethereum signature (r || s || v), ready for use with ecrecover.
   *
   * Fireblocks quirks handled here:
   *   - v is returned as 0 or 1; ecrecover expects 27 or 28
   *   - r and s must be zero-padded to exactly 32 bytes each
   */
  packSignature = (sig: SignedMessage["signature"]): Hex => {
    if (!sig?.r || !sig?.s || sig?.v === undefined) {
      throw new Error("Incomplete signature from Fireblocks (missing r, s, or v)");
    }
    const v = sig.v < 27 ? sig.v + 27 : sig.v;
    const rPadded = pad(`0x${sig.r.replace(/^0x/, "")}` as Hex, { size: 32 });
    const sPadded = pad(`0x${sig.s.replace(/^0x/, "")}` as Hex, { size: 32 });
    return concat([rPadded, sPadded, toHex(v, { size: 1 })]);
  };
}
