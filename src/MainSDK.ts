import {
  type Hex,
  type Address,
  pad,
  concat,
  toHex,
  toRlp,
  numberToHex,
  keccak256,
  serializeTransaction,
} from "viem";
import { toAccount } from "viem/accounts";
import { FireblocksService, BlockchainApiService } from "./services/index.js";
import {
  BroadcastResult,
  CreateTransactionResponse,
  EvmTxFields,
  FireblocksConfig,
  GetFtBalancesResponse,
  GetNativeBalanceResponse,
  TokenType,
  TransactionType,
  VaultData,
} from "./types/index.js";
import { SdkApiError } from "./types/errors.js";
import {
  Logger,
  validateApiCredentials,
  checkParamsAndAdjustAmount,
  formatErrorMessage,
  unitsToCoin,
  SEED_MESSAGE_HEX,
  ERC20_SELECTORS,
  DEFAULT_TOKEN_DECIMALS,
} from "./utils/index.js";
import { deriveKeyFromSignature } from "./crypto/key-derivation.js";
import { buildBalanceReadMessage, createExpiry } from "./seismic/signature.js";

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

  public async getErc20Info(contractAddress: string) {
    return this.blockchainApiService.getErc20Info(contractAddress);
  }

  public async getTransactionByHash(txHash: string): Promise<Record<string, unknown> | null> {
    return this.blockchainApiService.getTransactionByHash(txHash);
  }

  public async getTransactionHistory(params: {
    vaultId: string;
    type?: "native" | "erc20" | "src20" | "all";
    fromBlock?: string;
    toBlock?: string;
    contracts?: string[];
    limit?: number;
    offset?: number;
  }) {
    const vaultData = await this.ensureVaultData(params.vaultId);

    // For SRC-20, derive the encryption key so calldata can be decrypted client-side
    let encryptionSk: Hex | undefined;
    if (params.type === "src20") {
      try {
        encryptionSk = await this.deriveEncryptionKey(params.vaultId);
      } catch (err) {
        this.logger.warn(
          `Could not derive encryption key for SRC-20 history - amounts will be 0: ${(err as Error).message}`
        );
      }
    }

    return this.blockchainApiService.getTransactionHistory({
      address: vaultData.address,
      type: params.type,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      contracts: params.contracts,
      limit: params.limit,
      offset: params.offset,
      encryptionSk,
    });
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

      const { signingHash, evmTxFields } = transactionToSign;
      if (!signingHash || !evmTxFields) {
        throw new Error("serializeTransaction did not return signingHash or evmTxFields");
      }

      // Fireblocks signs the 32-byte EIP-155 hash (strip 0x prefix)
      const signedMsg = await this.fireblocksService.signTransaction(
        (signingHash as string).slice(2),
        vaultData.vaultAccountId,
        note || "eth-transfer"
      );

      const sig = signedMsg.signature;
      if (!sig?.r || !sig?.s || sig.v === undefined) {
        throw new Error("Incomplete signature from Fireblocks (missing r, s, or v)");
      }

      // EIP-155 replay-protected v: v = chainId * 2 + 35 + recoveryBit
      const chainId = this.blockchainApiService.getChainId();
      const recoveryBit = sig.v < 27 ? sig.v : sig.v - 27;
      const v = BigInt(chainId) * 2n + 35n + BigInt(recoveryBit);

      const r = `0x${sig.r.replace(/^0x/, "").padStart(64, "0")}` as Hex;
      const s = `0x${sig.s.replace(/^0x/, "").padStart(64, "0")}` as Hex;

      const tx = evmTxFields as EvmTxFields;

      // RLP-encode the signed transaction
      const signedRlp = toRlp([
        tx.nonce === "0x0" || tx.nonce === "0x" ? "0x" : (tx.nonce as Hex),
        tx.gasPrice as Hex,
        tx.gas as Hex,
        tx.to as Hex,
        tx.value as Hex,
        tx.data as Hex,
        numberToHex(v),
        r,
        s,
      ]);

      const result = await this.blockchainApiService.broadcastTransaction(signedRlp);
      return result;
    } catch (error) {
      if (error instanceof SdkApiError) throw error;
      throw new SdkApiError(
        `Failed to build, sign or send transaction: ${formatErrorMessage(error)}`,
        500,
        "TX_FAILED",
        undefined,
        "MainSDK"
      );
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
   * Transfers a standard ERC-20 token from a vault to a recipient.
   * Encodes transfer(address,uint256) calldata, signs the EIP-155 hash via Fireblocks RAW, and broadcasts.
   *
   * @param vaultAccountId  - Source Fireblocks vault account ID
   * @param recipientAddress - Destination EVM address
   * @param amount          - Amount in whole token units (e.g. 100 for 100 tokens with 18 decimals)
   * @param contractAddress - ERC-20 contract address
   * @param decimals        - Token decimals (default: 18)
   * @param note            - Optional label on the Fireblocks signing request
   */
  public createErc20Transaction = async (
    vaultAccountId: string,
    recipientAddress: string,
    amount: number,
    contractAddress: string,
    decimals?: number,
    note?: string
  ): Promise<CreateTransactionResponse> => {
    try {
      const vaultData = await this.ensureVaultData(vaultAccountId);

      const resolvedDecimals =
        decimals ??
        (await this.blockchainApiService.getErc20Info(contractAddress)).decimals ??
        DEFAULT_TOKEN_DECIMALS;
      const amountWei = BigInt(Math.round(amount * 10 ** resolvedDecimals));

      // Encode transfer(address,uint256) calldata
      const paddedTo = recipientAddress.slice(2).toLowerCase().padStart(64, "0");
      const paddedAmount = amountWei.toString(16).padStart(64, "0");
      const calldata = `${ERC20_SELECTORS.transfer}${paddedTo}${paddedAmount}` as Hex;

      // Build unsigned tx: to=contract, value=0, data=calldata
      const [hexNonce, hexGasPrice] = await Promise.all([
        this.blockchainApiService["jsonRpc"]<string>("eth_getTransactionCount", [
          vaultData.address,
          "latest",
        ]),
        this.blockchainApiService["jsonRpc"]<string>("eth_gasPrice", []),
      ]);

      const nonce = parseInt(hexNonce, 16);
      const gasPrice = BigInt(hexGasPrice);
      const gasLimit = 100_000n; // ERC-20 transfer gas
      const chainId = this.blockchainApiService.getChainId();

      const rlpEncoded = toRlp([
        nonce === 0 ? "0x" : numberToHex(nonce),
        numberToHex(gasPrice),
        numberToHex(gasLimit),
        contractAddress as Hex,
        "0x",
        calldata,
        numberToHex(chainId),
        "0x",
        "0x",
      ]);
      const signingHash = keccak256(rlpEncoded);

      const signedMsg = await this.fireblocksService.signTransaction(
        signingHash.slice(2),
        vaultAccountId,
        note || "erc20-transfer"
      );

      const sig = signedMsg.signature;
      if (!sig?.r || !sig?.s || sig.v === undefined) {
        throw new Error("Incomplete signature from Fireblocks");
      }

      const recoveryBit = sig.v < 27 ? sig.v : sig.v - 27;
      const v = BigInt(chainId) * 2n + 35n + BigInt(recoveryBit);
      const r = `0x${sig.r.replace(/^0x/, "").padStart(64, "0")}` as Hex;
      const s = `0x${sig.s.replace(/^0x/, "").padStart(64, "0")}` as Hex;

      const signedRlp = toRlp([
        nonce === 0 ? "0x" : numberToHex(nonce),
        numberToHex(gasPrice),
        numberToHex(gasLimit),
        contractAddress as Hex,
        "0x",
        calldata,
        numberToHex(v),
        r,
        s,
      ]);

      const result = await this.blockchainApiService.broadcastTransaction(signedRlp);
      if (result.err) {
        return { success: false, error: formatErrorMessage(result.err) };
      }
      return { success: true, txHash: result.txid };
    } catch (error) {
      this.logger.error(`Failed to create ERC-20 transaction: ${formatErrorMessage(error)}`);
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
   * Returns the vault's derived Seismic/ETH address (from its MPC public key).
   */
  public getSeismicAddress = async (vaultId: string): Promise<string> => {
    const { address } = await this.ensureVaultData(vaultId);
    return address;
  };

  /**
   * Returns the vault's compressed secp256k1 MPC public key.
   */
  public getVaultPublicKey = async (vaultId: string): Promise<string> => {
    const { publicKey } = await this.ensureVaultData(vaultId);
    return publicKey;
  };

  /**
   * Returns the public key for a specific vault asset address by BIP-44 derivation path.
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @param assetId - The asset ID (e.g. 'ETH', 'BTC')
   * @param change - BIP-44 change index (0 = external, 1 = internal/change)
   * @param addressIndex - BIP-44 address index
   */
  public getPublicKey = async (
    vaultAccountId: string,
    assetId: string,
    change: number = 0,
    addressIndex: number = 0
  ): Promise<string> => {
    return await this.fireblocksService.getAssetPublicKey(
      vaultAccountId,
      assetId,
      change,
      addressIndex
    );
  };

  /**
   * Reads ERC-20 balances for a vault address across one or more contracts.
   *
   * @param vaultId   - Fireblocks vault account ID
   * @param contracts - Comma-separated or array of ERC-20 contract addresses
   */
  public getErc20Balances = async (
    vaultId: string,
    contracts: string[]
  ): Promise<{ contractAddress: string; balance: string }[]> => {
    const { address } = await this.ensureVaultData(vaultId);
    const results = await Promise.all(
      contracts.map(async (contractAddress) => {
        try {
          const raw = await this.blockchainApiService.readErc20Balance(address, contractAddress);
          return { contractAddress, balance: raw.toString() };
        } catch {
          return { contractAddress, balance: "0" };
        }
      })
    );
    return results;
  };

  // ─── Seismic shielded operations ────────────────────────────────────────────

  /**
   * Derives and caches the deterministic encryption key for a vault.
   *
   * Signs SEED_MESSAGE_HEX via Fireblocks RAW signing, then computes
   * SHA-256(fullSig) to produce a stable 32-byte encryptionSk. The result is
   * cached in the vault's VaultData entry - subsequent calls return the cached
   * value without a Fireblocks round-trip.
   *
   * The encryptionSk is held in process memory only and zeroed on shutdown.
   */
  public deriveEncryptionKey = async (vaultId: string): Promise<Hex> => {
    const vaultData = await this.ensureVaultData(vaultId);
    if (vaultData.encryptionSk) return vaultData.encryptionSk as Hex;

    this.logger.info(`Deriving encryption key | vault:${vaultId}`);
    const signedMsg = await this.fireblocksService.signTransaction(
      SEED_MESSAGE_HEX.slice(2), // strip 0x - rawSign expects plain hex
      vaultId,
      "derive-encryption-key"
    );

    const fullSig = signedMsg.signature?.fullSig;
    if (!fullSig) throw new Error(`Fireblocks did not return a signature for vault ${vaultId}`);

    const encryptionSk = deriveKeyFromSignature(fullSig);
    vaultData.encryptionSk = encryptionSk;
    this.logger.info(`Encryption key derived and cached | vault:${vaultId}`);
    return encryptionSk;
  };

  /**
   * Reads a vault's SRC-20 balance via a Fireblocks-signed read.
   *
   * Flow:
   * 1. Build the EIP-191 message for balanceOfSigned (keccak256 of owner + expiry)
   * 2. Fireblocks RAW-signs the 32-byte hash (proves vault identity without raw key)
   * 3. Create a Seismic public client and call balanceOfSigned(owner, expiry, sig)
   * 4. The SRC-20 contract verifies via ecrecover and decrypts the shielded balance
   *
   * @param vaultId         - Fireblocks vault account ID
   * @param contractAddress - SRC-20 contract address (0x-prefixed)
   * @returns Balance in whole ETH units (wei / 1e18)
   */
  public getSrc20Balance = async (
    vaultId: string,
    contractAddress: string
  ): Promise<GetNativeBalanceResponse> => {
    try {
      const { address } = await this.ensureVaultData(vaultId);
      const ownerAddress = address as Address;
      const expiry = createExpiry();

      const messageHash = buildBalanceReadMessage(ownerAddress, expiry);
      const signedMsg = await this.fireblocksService.signTransaction(
        messageHash.slice(2), // strip 0x
        vaultId,
        "src20-balance-read"
      );

      // Pack r/s/v into 65-byte Ethereum signature (ecrecover format)
      const sig = signedMsg.signature;
      if (!sig?.r || !sig?.s || sig.v === undefined) {
        throw new Error("Incomplete signature from Fireblocks (missing r, s, or v)");
      }
      const v = sig.v < 27 ? sig.v + 27 : sig.v;
      const rPadded = pad(`0x${sig.r.replace(/^0x/, "")}` as Hex, { size: 32 });
      const sPadded = pad(`0x${sig.s.replace(/^0x/, "")}` as Hex, { size: 32 });
      const packedSignature = concat([rPadded, sPadded, toHex(v, { size: 1 })]);

      // Use a plain unsigned eth_call via ShieldedPublicClient.
      // balanceOfSigned does NOT check msg.sender (Seismic zeroes it for unsigned calls) -
      // authorization comes entirely from the ecrecover check on packedSignature.
      // Signed reads (type-0x4A → eth_call) are only needed for balance() which reads
      // msg.sender's own balance; they also require the caller to have ETH for gas
      // estimation, making them unsuitable here.
      const publicClient = this.blockchainApiService.createPublicClient();
      const rawBalance = await this.blockchainApiService.readSrc20BalanceSigned(
        publicClient,
        contractAddress as Address,
        ownerAddress,
        packedSignature,
        expiry
      );

      const whole = rawBalance / BigInt(10 ** 18);
      const remainder = rawBalance % BigInt(10 ** 18);
      const balance = Number(whole) + Number(remainder) / 10 ** 18;
      return { success: true, balance };
    } catch (error) {
      this.logger.error(`Error fetching SRC-20 balance: ${formatErrorMessage(error)}`);
      return { success: false, error: formatErrorMessage(error) };
    }
  };

  /**
   * Submits an encrypted SRC-20 shielded transfer (Seismic type-0x4A transaction).
   *
   * Flow:
   * 1. Derive encryptionSk (cached after first call)
   * 2. Create a ShieldedWalletClient using encryptionSk as both the signing key
   *    and the calldata encryption key
   * 3. seismic-viem encrypts transfer(to, amount) calldata via AES-256-GCM
   *    using ECDH(encryptionSk, TEE pubkey) + HKDF, then broadcasts the type-0x4A tx
   *
   * @param vaultId         - Fireblocks vault account ID
   * @param recipient       - Transfer recipient address
   * @param amount          - Transfer amount in whole token units
   * @param contractAddress - SRC-20 contract address
   * @param note            - Optional label for the Fireblocks activity log
   */
  public createShieldedTransaction = async (
    vaultId: string,
    recipient: string,
    amount: number,
    contractAddress: string,
    note?: string
  ): Promise<CreateTransactionResponse> => {
    try {
      const vaultData = await this.ensureVaultData(vaultId);
      const encryptionSk = await this.deriveEncryptionKey(vaultId);

      // Build a custom viem account backed by Fireblocks raw signing
      // - address: the vault's address (0x6d7a...)
      // - encryptionSk: used only for ECDH calldata encryption, not for signing
      const fireblocksAccount = toAccount({
        address: vaultData.address as Address,
        signMessage: async () => {
          throw new Error("signMessage not supported for Fireblocks account");
        },
        signTypedData: async () => {
          throw new Error("signTypedData not supported for Fireblocks account");
        },
        signTransaction: async (transaction, options) => {
          const serialize = (options?.serializer ?? serializeTransaction) as (
            tx: unknown,
            sig?: unknown
          ) => Hex;
          const serialized = serialize(transaction);
          const hash = keccak256(serialized);
          const signedMsg = await this.fireblocksService.signTransaction(
            hash.slice(2),
            vaultId,
            note || "src20-shielded-transfer"
          );
          const sig = signedMsg.signature;
          if (!sig?.r || !sig?.s || sig.v === undefined) {
            throw new Error("Incomplete signature from Fireblocks");
          }
          const r = `0x${sig.r.replace(/^0x/, "").padStart(64, "0")}` as Hex;
          const s = `0x${sig.s.replace(/^0x/, "").padStart(64, "0")}` as Hex;
          const v = sig.v < 27 ? sig.v : sig.v - 27;
          return serialize(transaction, { r, s, v });
        },
      });

      const client = await this.blockchainApiService.createShieldedClient(
        fireblocksAccount,
        encryptionSk
      );

      const amountBigInt = BigInt(Math.round(amount * 10 ** 18));
      const txHash = await this.blockchainApiService.submitShieldedTransfer(
        client,
        contractAddress as Address,
        recipient as Address,
        amountBigInt
      );

      this.logger.info(
        `Shielded transfer submitted | vault:${vaultId} | txHash:${txHash}` +
          (note ? ` | note:${note}` : "")
      );
      return { success: true, txHash };
    } catch (error: unknown) {
      this.logger.error(`Failed to create shielded transaction: ${formatErrorMessage(error)}`);
      return { success: false, error: formatErrorMessage(error) };
    }
  };

  /**
   * Gracefully shutdown the SDK.
   * Zeroes encryptionSk values in memory before clearing vault data.
   *
   * @returns Promise that resolves when shutdown is complete
   */
  public async shutdown(): Promise<void> {
    this.logger.info("Shutting down MainSDK...");
    // Zero encryptionSk values before clearing - defense-in-depth against memory scraping
    for (const vaultData of this.vaultData.values()) {
      if (vaultData.encryptionSk) {
        vaultData.encryptionSk = "0".repeat(vaultData.encryptionSk.length);
      }
    }
    this.vaultData.clear();
    this.logger.info("MainSDK shutdown complete");
  }
}
