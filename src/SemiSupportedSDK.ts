import {
  BasePath,
  VaultWalletAddress,
  SignedMessageSignature,
  TransactionRequest,
} from "@fireblocks/ts-sdk";
import { FireblocksService, BlockchainApiService } from "./services/index.js";
import { Logger } from "./utils/index.js";
import {
  FireblocksConfig,
  GetTransactionsHistoryOpts,
  TransactionHistoryResponse,
} from "./types/index.js";

/**
 * Configuration for MainSDK
 */
export interface MainSDKConfig {
  /** Fireblocks API key */
  apiKey: string;
  /** Fireblocks secret key */
  secretKey: string;
  /** Fireblocks API base path (defaults to US) */
  basePath?: BasePath;
  /** Optional custom logger instance */
  logger?: Logger;
}

/**
 * Main SDK for Custom Development
 *
 * This is the primary entry point for the SDK framework. It provides:
 * - Connection pooling for efficient multi-vault operations
 * - Type-safe operations for address management and transactions
 * - Optional Express REST API integration
 * - Built-in resilience patterns (retry, circuit breaker)
 *
 * @example
 * ```typescript
 * // Basic usage
 * const sdk = new MainSDK({
 *   apiKey: process.env.FIREBLOCKS_API_KEY!,
 *   secretKey: process.env.FIREBLOCKS_SECRET_KEY!,
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

  /**
   * Creates a new MainSDK instance
   *
   * @param config - SDK configuration
   */
  constructor(config: MainSDKConfig) {
    // Validate config
    if (!config.apiKey || typeof config.apiKey !== "string" || !config.apiKey.trim()) {
      throw new Error("InvalidConfig: apiKey must be a non-empty string");
    }
    if (!config.secretKey || typeof config.secretKey !== "string" || !config.secretKey.trim()) {
      throw new Error("InvalidConfig: secretKey must be a non-empty string");
    }

    this.logger = config.logger ?? new Logger("MainSDK");

    const baseConfig = {
      apiKey: config.apiKey,
      apiSecret: config.secretKey,
      basePath: config.basePath || BasePath.US,
    } as FireblocksConfig;

    // Initialize core services for direct use
    this.fireblocksService = new FireblocksService(baseConfig);
    this.blockchainApiService = new BlockchainApiService();

    this.logger.info("MainSDK initialized successfully");
  }

  /**
   * Get a specific vault account address by index
   *
   * Retrieves a single address for a vault account and asset at the specified BIP-44 derivation index.
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @param assetId - The asset ID (e.g., 'BTC', 'ETH', 'ADA')
   * @param index - The BIP-44 address derivation index (defaults to 0)
   * @returns Promise resolving to the vault wallet address
   *
   * @example
   * ```typescript
   * const address = await sdk.getVaultAccountAddress('vault-123', 'BTC', 0);
   * console.log('Address:', address.address);
   * console.log('Index:', address.bip44AddressIndex);
   * ```
   */
  public async getVaultAccountAddress(
    vaultAccountId: string,
    assetId: string,
    index: number = 0
  ): Promise<VaultWalletAddress> {
    this.logger.debug(
      `Getting address for vault ${vaultAccountId}, asset ${assetId}, index ${index}`
    );

    return await this.fireblocksService.getVaultAccountAddress(vaultAccountId, assetId, index);
  }

  /**
   * Get all vault account addresses for a specific asset
   *
   * Retrieves all addresses that have been generated for a vault account and asset combination.
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @param assetId - The asset ID (e.g., 'BTC', 'ETH', 'ADA')
   * @returns Promise resolving to an array of vault wallet addresses
   *
   * @example
   * ```typescript
   * const addresses = await sdk.getVaultAccountAddresses('vault-123', 'ETH');
   * console.log(`Found ${addresses.length} addresses`);
   * addresses.forEach(addr => {
   *   console.log(`Index ${addr.bip44AddressIndex}: ${addr.address}`);
   * });
   * ```
   */
  public async getVaultAccountAddresses(
    vaultAccountId: string,
    assetId: string
  ): Promise<VaultWalletAddress[]> {
    this.logger.debug(`Getting all addresses for vault ${vaultAccountId}, asset ${assetId}`);

    return await this.fireblocksService.getVaultAccountAddresses(vaultAccountId, assetId);
  }

  /**
   * Submit a transaction through Fireblocks
   *
   * Creates and broadcasts a transaction to the Fireblocks network. This can be used for
   * transfers, contract calls, message signing, or any other Fireblocks transaction type.
   *
   * @param vaultAccountId - The Fireblocks vault account ID (unused, kept for API compatibility)
   * @param transactionRequest - The Fireblocks transaction request payload
   * @param waitForCompletion - Whether to wait for transaction completion (defaults to true)
   * @returns Promise resolving to the signed message data or null
   *
   * @example
   * ```typescript
   * // Transfer transaction
   * const result = await sdk.submitTransaction('vault-123', {
   *   operation: TransactionOperation.TRANSFER,
   *   source: { type: 'VAULT_ACCOUNT', id: 'vault-123' },
   *   destination: { type: 'ONE_TIME_ADDRESS', oneTimeAddress: { address: '0x...' } },
   *   assetId: 'ETH',
   *   amount: '0.1',
   *   note: 'Payment'
   * });
   *
   * // Message signing
   * const signResult = await sdk.submitTransaction('vault-123', {
   *   operation: TransactionOperation.TYPED_MESSAGE,
   *   source: { type: 'VAULT_ACCOUNT', id: 'vault-123' },
   *   assetId: 'ETH',
   *   extraParameters: {
   *     rawMessageData: {
   *       messages: [{
   *         content: 'Message to sign',
   *         type: 'EIP191'
   *       }]
   *     }
   *   }
   * });
   * ```
   */
  public async submitTransaction(
    vaultAccountId: string,
    transactionRequest: TransactionRequest,
    waitForCompletion: boolean = true
  ): Promise<{
    signature: SignedMessageSignature;
    content?: string;
    publicKey?: string;
    algorithm?: string;
  } | null> {
    this.logger.info(
      `Submitting transaction for vault ${vaultAccountId}, operation: ${transactionRequest.operation}`
    );

    if (!waitForCompletion) {
      throw new Error(
        "Non-blocking transaction submission not yet implemented. Set waitForCompletion to true."
      );
    }

    return await this.fireblocksService.broadcastTransaction(transactionRequest);
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
   * const history = await sdk.getTransactionsHistory('vault-123', {
   *   assetId: 'BTC',
   *   limit: 10,
   *   status: 'COMPLETED'
   * });
   * console.log(`Found ${history.total} transactions`);
   * ```
   */
  public async getTransactionsHistory(
    vaultAccountId: string,
    options: GetTransactionsHistoryOpts = {}
  ): Promise<TransactionHistoryResponse> {
    this.logger.debug(`Getting transaction history for vault ${vaultAccountId}`, options);

    // Use blockchain API service for transaction history
    await this.blockchainApiService.getTransactionHistory(options);

    // TODO: Implement actual transaction history retrieval
    this.logger.warn("getTransactionsHistory not yet fully implemented - returning empty result");

    return {
      transactions: [],
      total: 0,
      hasMore: false,
    };
  }

  /**
   * Get a public key for a vault account asset address
   *
   * Retrieves the public key for a specific address within a vault account, identified by
   * its BIP-44 derivation path components.
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @param assetId - The asset ID (e.g., 'BTC', 'ETH', 'ADA')
   * @param change - The BIP-44 change index (0 for external, 1 for internal/change addresses)
   * @param addressIndex - The BIP-44 address index within the change path
   * @returns Promise resolving to the hex-encoded public key string
   *
   * @example
   * ```typescript
   * // Get public key for first external address
   * const publicKey = await sdk.getPublicKey('vault-123', 'ADA', 0, 0);
   * console.log('Public key:', publicKey);
   * ```
   */
  public async getPublicKey(
    vaultAccountId: string,
    assetId: string,
    change: number = 0,
    addressIndex: number = 0
  ): Promise<string> {
    this.logger.debug(
      `Getting public key for vault ${vaultAccountId}, asset ${assetId}, change ${change}, index ${addressIndex}`
    );

    return await this.fireblocksService.getAssetPublicKey(
      vaultAccountId,
      assetId,
      change,
      addressIndex
    );
  }

  /**
   * Get the FireblocksService instance for direct access to Fireblocks operations
   *
   * This provides direct access to the underlying FireblocksService for advanced use cases
   * where you need full control over Fireblocks operations.
   *
   * @returns The FireblocksService instance
   *
   * @example
   * ```typescript
   * const fireblocksService = sdk.getFireblocksService();
   * const address = await fireblocksService.getVaultAccountAddress('vault-123', 'BTC', 0);
   * ```
   */
  public getFireblocksService(): FireblocksService {
    return this.fireblocksService;
  }

  /**
   * Get the BlockchainApiService instance for direct access to blockchain API operations
   *
   * This provides direct access to the underlying BlockchainApiService for advanced use cases
   * where you need to interact with blockchain APIs directly.
   *
   * @returns The BlockchainApiService instance
   *
   * @example
   * ```typescript
   * const blockchainService = sdk.getBlockchainApiService();
   * const history = await blockchainService.getTransactionsHistory({ limit: 10 });
   * ```
   */
  public getBlockchainApiService(): BlockchainApiService {
    return this.blockchainApiService;
  }

  /**
   * Gracefully shutdown the SDK
   *
   * Closes all connections, cleans up resources, and prepares for application termination.
   * Should be called when the application is shutting down.
   *
   * @returns Promise that resolves when shutdown is complete
   *
   * @example
   * ```typescript
   * process.on('SIGTERM', async () => {
   *   console.log('Shutting down...');
   *   await sdk.shutdown();
   *   process.exit(0);
   * });
   * ```
   */
  public async shutdown(): Promise<void> {
    this.logger.info("Shutting down MainSDK...");
    // Cleanup resources if needed
    this.logger.info("MainSDK shutdown complete");
  }
}
