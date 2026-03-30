import { VaultWalletAddress, SignedMessageSignature, TransactionRequest } from "@fireblocks/ts-sdk";
import { FireblocksService, BlockchainApiService } from "./services/index.js";
import {
  BroadcastResult,
  CreateTransactionResponse,
  FireblocksConfig,
  GetFtBalancesResponse,
  GetNativeBalanceResponse,
  GetTransactionHistoryParams,
  GetTransactionHistoryResponse,
  GetTransactionsHistoryOpts,
  TokenType,
  TransactionHistoryResponse,
  TransactionType,
  VaultData,
} from "./types/index.js";
import {
  Logger,
  validateApiCredentials,
  checkParamsAndAdjustAmount,
  formatErrorMessage,
  unitsToCoin,
} from "./utils/index.js";

/**
 * Configuration for MainSDK
 */
export interface MainSDKConfig extends FireblocksConfig {
  /** Optional custom logger instance */
  logger?: Logger;
}

/**
 * Main SDK for Custom Development
 *
 * This is the primary entry point for the SDK framework. It provides:
 * - A single shared instance of FireblocksService and BlockchainApiService
 * - Lazy per-vault initialization: address and public key are resolved on first use
 *   and cached in an internal map keyed by vault account ID
 * - Type-safe operations for address management and transactions
 * - Optional Express REST API integration
 * - Built-in resilience patterns (retry, circuit breaker)
 *
 * @example
 * ```typescript
 * // Basic usage
 * const sdk = new MainSDK({
 *   apiKey: process.env.FIREBLOCKS_API_KEY!,
 *   apiSecret: process.env.FIREBLOCKS_SECRET_KEY!,
 *   basePath: BasePath.US
 * });
 *
 * // Get address for a vault
 * const address = await sdk.getVaultAccountAddress('vault-123', 'BTC', 0);
 *
 * // Submit a transaction
 * const result = await sdk.submitTransaction('vault-123', {
 *   operation: TransactionOperation.TRANSFER,
 *   source: { type: 'VAULT_ACCOUNT', id: 'vault-123' },
 *   destination: { type: 'ONE_TIME_ADDRESS', oneTimeAddress: { address: '0x...' } },
 *   assetId: 'ETH',
 *   amount: '0.1'
 * });
 *
 * // Access services directly
 * const fireblocksService = sdk.getFireblocksService();
 * const blockchainService = sdk.getBlockchainApiService();
 * ```
 */
export class MainSDK {
  private readonly fireblocksService: FireblocksService;
  private readonly blockchainApiService: BlockchainApiService;
  private readonly logger: Logger;
  private readonly vaultData: Map<string, VaultData> = new Map();

  /**
   * Creates a new MainSDK instance.
   * FireblocksService and BlockchainApiService are shared across all vault accounts.
   * Per-vault data (address, public key) is resolved lazily on first use via ensureVaultData().
   *
   * @param config - SDK configuration
   */
  constructor(config: MainSDKConfig) {
    try {
      validateApiCredentials(config.apiKey, config.apiSecret);
      this.fireblocksService = new FireblocksService({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        basePath: config.basePath,
        testnet: config.testnet,
      });
      this.blockchainApiService = new BlockchainApiService(config.testnet ?? false);
      this.logger = config.logger ?? new Logger("MainSDK");
      this.logger.info("MainSDK initialized successfully");
    } catch (error) {
      throw new Error(`Failed to initialize MainSDK: ${error}`);
    }
  }

  /**
   * Resolves and caches per-vault identity data (public key + derived address).
   * On subsequent calls for the same vault, returns the cached entry immediately.
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @returns Cached or freshly resolved VaultData
   */
  private async ensureVaultData(vaultAccountId: string): Promise<VaultData> {
    const cached = this.vaultData.get(vaultAccountId);
    if (cached) return cached;

    this.logger.debug(`Resolving vault data for vault ${vaultAccountId}`);
    const publicKey = await this.fireblocksService.getPublicKeyByVaultID(vaultAccountId);
    const address = this.blockchainApiService.formatAddress(publicKey);
    const entry: VaultData = { vaultAccountId, address, publicKey };
    this.vaultData.set(vaultAccountId, entry);
    this.logger.debug(`Vault data cached for vault ${vaultAccountId}: address=${address}`);
    return entry;
  }

  /**
   * Get transaction history for a vault account
   *
   * Retrieves transaction history based on the provided filters using the blockchain API service.
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @param options - Optional filters for transaction history
   * @returns Promise resolving to transaction history response
   *
   * @example
   * ```typescript
   * const history = await sdk.getTransactionHistory('vault-123', {
   *   limit: 10,
   * });
   * console.log(`Found ${history.data.length} transactions`);
   * ```
   */
  public async getTransactionHistory(
    vaultAccountId: string,
    options: { limit?: number; offset?: number; order?: "ASC" | "DESC" } = {}
  ): Promise<GetTransactionHistoryResponse> {
    try {
      this.logger.debug(`Getting transaction history for vault ${vaultAccountId}`, options);

      const { address } = await this.ensureVaultData(vaultAccountId);

      const params = {
        address,
        limit: options.limit,
        offset: options.offset,
      } as GetTransactionHistoryParams;

      const transactions = await this.blockchainApiService.getTransactionHistory(params);

      if (options.order === "ASC") {
        transactions.reverse();
      }

      return { success: true, data: transactions };
    } catch (error) {
      this.logger.error(`Error fetching transaction history: ${formatErrorMessage(error)}`);
      return { success: false, error: formatErrorMessage(error) };
    }
  }

  public async getVaultAccountAddress(
    vaultAccountId: string,
    assetId: string,
    index: number = 0
  ): Promise<VaultWalletAddress> {
    return await this.fireblocksService.getVaultAccountAddress(vaultAccountId, assetId, index);
  }

  public async getVaultAccountAddresses(
    vaultAccountId: string,
    assetId: string
  ): Promise<VaultWalletAddress[]> {
    return await this.fireblocksService.getVaultAccountAddresses(vaultAccountId, assetId);
  }

  public async submitTransaction(
    _vaultAccountId: string,
    transactionRequest: TransactionRequest,
    waitForCompletion: boolean = true
  ): Promise<{
    signature: SignedMessageSignature;
    content?: string;
    publicKey?: string;
    algorithm?: string;
  } | null> {
    if (!waitForCompletion) {
      throw new Error(
        "Non-blocking transaction submission not yet implemented. Set waitForCompletion to true."
      );
    }
    return await this.fireblocksService.broadcastTransaction(transactionRequest);
  }

  public async getTransactionsHistory(
    vaultAccountId: string,
    options: GetTransactionsHistoryOpts = {}
  ): Promise<TransactionHistoryResponse> {
    this.logger.debug(`Getting transaction history for vault ${vaultAccountId}`, options);
    await this.blockchainApiService.getTransactionHistory(options);
    this.logger.warn("getTransactionsHistory not yet fully implemented - returning empty result");
    return { transactions: [], total: 0, hasMore: false };
  }

  /**
   * Get the FireblocksService instance for direct access to Fireblocks operations
   *
   * @returns The FireblocksService instance
   */
  public getFireblocksService(): FireblocksService {
    return this.fireblocksService;
  }

  /**
   * Get the BlockchainApiService instance for direct access to blockchain API operations
   *
   * @returns The BlockchainApiService instance
   */
  public getBlockchainApiService(): BlockchainApiService {
    return this.blockchainApiService;
  }

  /**
   * Retrieves the native coin balance for a vault account address.
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @returns A promise that resolves to a {GetNativeBalanceResponse}
   */
  public getBalance = async (vaultAccountId: string): Promise<GetNativeBalanceResponse> => {
    this.logger.debug(`Fetching native balance for vault ${vaultAccountId}`);
    try {
      const { address } = await this.ensureVaultData(vaultAccountId);
      const balance = await this.blockchainApiService.getNativeBalance(address);
      return { success: true, balance };
    } catch (error) {
      this.logger.error(`Error fetching native balance: ${formatErrorMessage(error)}`);
      return { success: false, error: formatErrorMessage(error) };
    }
  };

  /**
   * Retrieves the fungible token balances for a vault account address.
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @returns A promise that resolves to a {GetFtBalancesResponse}
   */
  public getFtBalances = async (vaultAccountId: string): Promise<GetFtBalancesResponse> => {
    this.logger.debug(`Fetching fungible token balances for vault ${vaultAccountId}`);
    try {
      const { address } = await this.ensureVaultData(vaultAccountId);
      const balances = await this.blockchainApiService.getFTBalancesForAddress(address);
      return {
        success: true,
        data: balances.map((b) => ({ token: b.token, balance: b.balance })),
      };
    } catch (error) {
      this.logger.error(`Error fetching fungible token balances: ${formatErrorMessage(error)}`);
      return { success: false, error: formatErrorMessage(error) };
    }
  };

  /**
   * Builds, signs, and broadcasts a transaction.
   * Handles both native coin and fungible token transactions.
   */
  private buildSignSendTransaction = async (
    vaultData: VaultData,
    recipientAddress: string,
    amount: number,
    type: TransactionType = TransactionType.Native,
    token?: TokenType,
    note?: string
  ): Promise<BroadcastResult> => {
    try {
      const transactionToSign = await this.blockchainApiService.serializeTransaction(
        vaultData.address,
        recipientAddress,
        amount,
        type,
        token
      );

      const unsignedTx = transactionToSign.unsignedTx as string;

      const signature = await this.fireblocksService.signTransaction(
        unsignedTx,
        vaultData.vaultAccountId,
        note || ""
      );

      transactionToSign.signature = signature; // Adjust as needed, Add the signature to the transaction as the blockchain API expects it

      const result = await this.blockchainApiService.broadcastTransaction(unsignedTx);
      return result;
    } catch (error) {
      throw new Error(`Failed to build, sign or send transaction: ${formatErrorMessage(error)}`);
    }
  };

  /**
   * Creates a native coin transaction to transfer funds to a recipient address.
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @param recipientAddress - The address of the recipient
   * @param amount - The amount to transfer in native coin
   * @param grossTransaction - If true, fee is deducted from the transferred amount (default: false)
   * @param note - Optional note attached to the raw signing request
   * @returns {CreateTransactionResponse} Promise
   */
  public createNativeTransaction = async (
    vaultAccountId: string,
    recipientAddress: string,
    amount: number,
    grossTransaction: boolean = false,
    note?: string
  ): Promise<CreateTransactionResponse> => {
    try {
      const vaultData = await this.ensureVaultData(vaultAccountId);

      const paramsValidationResponse = await checkParamsAndAdjustAmount(
        this,
        vaultAccountId,
        recipientAddress,
        amount,
        grossTransaction,
        TransactionType.Native
      );

      if (!paramsValidationResponse.validParams) {
        return {
          success: false,
          error: `Invalid transaction parameters: ${paramsValidationResponse.reason}`,
        };
      }

      amount = unitsToCoin(paramsValidationResponse.finalAmount!);

      const result = await this.buildSignSendTransaction(
        vaultData,
        recipientAddress,
        amount,
        TransactionType.Native,
        undefined,
        note
      );

      if (!result || result.err) {
        return {
          success: false,
          error: result?.err ? formatErrorMessage(result.err) : "unknown error",
        };
      }

      return { success: true, txHash: result.txid };
    } catch (error: unknown) {
      this.logger.error(`Failed to create native transaction: ${formatErrorMessage(error)}`);
      return { success: false, error: formatErrorMessage(error) };
    }
  };

  /**
   * Creates a fungible token transaction to transfer tokens to a recipient address.
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @param recipientAddress - The address of the recipient
   * @param amount - The amount to transfer
   * @param token - The fungible token type
   * @param note - Optional note attached to the raw signing request
   * @returns {CreateTransactionResponse} Promise
   */
  public createFTTransaction = async (
    vaultAccountId: string,
    recipientAddress: string,
    amount: number,
    token: TokenType,
    note?: string
  ): Promise<CreateTransactionResponse> => {
    try {
      const vaultData = await this.ensureVaultData(vaultAccountId);

      const paramsValidationResponse = await checkParamsAndAdjustAmount(
        this,
        vaultAccountId,
        recipientAddress,
        amount,
        undefined,
        TransactionType.FungibleToken,
        token
      );

      if (!paramsValidationResponse.validParams) {
        return {
          success: false,
          error: `Invalid transaction parameters: ${paramsValidationResponse.reason}`,
        };
      }

      amount = unitsToCoin(paramsValidationResponse.finalAmount!);

      const result = await this.buildSignSendTransaction(
        vaultData,
        recipientAddress,
        amount,
        TransactionType.FungibleToken,
        token,
        note
      );

      if (!result || result.err) {
        return {
          success: false,
          error: result?.err ? formatErrorMessage(result.err) : "unknown error",
        };
      }

      return { success: true, txHash: result.txid };
    } catch (error: unknown) {
      this.logger.error(`Failed to create FT transaction: ${formatErrorMessage(error)}`);
      return { success: false, error: formatErrorMessage(error) };
    }
  };

  /**
   * Gracefully shutdown the SDK
   *
   * @returns Promise that resolves when shutdown is complete
   */
  public async shutdown(): Promise<void> {
    this.logger.info("Shutting down MainSDK...");
    this.vaultData.clear();
    this.logger.info("MainSDK shutdown complete");
  }
}
