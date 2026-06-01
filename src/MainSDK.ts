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
  parseUnits,
  formatUnits,
  hashTypedData,
} from "viem";
import type { AxiosInstance } from "axios";
import { toAccount } from "viem/accounts";
import { FireblocksService } from "./services/fireblocks.service.js";
import { BlockchainApiService } from "./services/seismic.service.js";
import {
  FireblocksConfig,
  TokenBalance,
  TokenBalancesResult,
  TokenType,
  Transaction,
  VaultData,
  SdkApiError,
} from "./types/index.js";
import {
  Logger,
  validateApiCredentials,
  formatErrorMessage,
  SEED_MESSAGE_HEX,
  ERC20_SELECTORS,
  DEFAULT_TOKEN_DECIMALS,
  SEISMIC_CHAIN_ID,
  api_constants,
  SUSDC_CONTRACT_ADDRESS,
  SUSDC_DECIMALS,
  logTx,
} from "./utils/index.js";
import { deriveKeyFromSignature } from "./crypto/key-derivation.js";
import { buildBalanceReadMessage, createExpiry } from "./seismic/signature.js";

/**
 * ERROR HANDLING
 *
 * All public methods throw `SdkApiError` on failure. Success path returns the
 * result data directly. SdkApiError carries:
 *   - statusCode (HTTP-style)
 *   - errorType (machine-readable)
 *   - service (origin)
 *   - errorInfo (extra context)
 *
 * Library consumers should wrap calls in try/catch:
 *
 *   try {
 *     const balance = await sdk.getSUsdcBalance(vaultId);
 *   } catch (err) {
 *     if (err instanceof SdkApiError) {
 *       // err.statusCode, err.errorType, err.service available
 *     }
 *   }
 */

/**
 * Configuration for MainSDK
 */
export interface MainSDKConfig extends FireblocksConfig {
  logger?: Logger;
  /** Override the Seismic RPC URL (defaults to env RPC_URL or the network default) */
  rpcUrl?: string;
  /** SocialScan API key for native/ERC-20 history (defaults to env SOCIALSCAN_API_KEY) */
  socialscanApiKey?: string;
  /** Inject a custom Axios instance for all HTTP calls (useful for testing) */
  httpClient?: AxiosInstance;
  /** Optional service overrides for testing */
  services?: {
    fireblocks?: FireblocksService;
    blockchainApi?: BlockchainApiService;
  };
  /** Skip the deterministic signing check at startup. Only use if you are certain your workspace has deterministic signing enabled. */
  skipDeterminismCheck?: boolean;
}

export class MainSDK {
  private readonly fireblocksService: FireblocksService;
  private readonly blockchainApiService: BlockchainApiService;
  private readonly logger: Logger;
  private readonly vaultData: Map<string, VaultData> = new Map();
  private readonly skipDeterminismCheck: boolean;
  private deterministicSigningVerified: boolean | undefined;

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
      this.fireblocksService =
        config.services?.fireblocks ??
        new FireblocksService({
          apiKey: config.apiKey,
          apiSecret: config.apiSecret,
          basePath: config.basePath,
          testnet: config.testnet,
        });
      this.blockchainApiService =
        config.services?.blockchainApi ??
        new BlockchainApiService(config.testnet ?? false, {
          rpcUrl: config.rpcUrl,
          socialscanApiKey: config.socialscanApiKey,
          httpClient: config.httpClient,
        });
      this.logger = config.logger ?? new Logger("MainSDK");
      this.skipDeterminismCheck = config.skipDeterminismCheck ?? false;
      this.deterministicSigningVerified = this.skipDeterminismCheck ? true : undefined;
      this.logger.info("MainSDK initialized successfully");
    } catch (error) {
      if (error instanceof SdkApiError) throw error;
      throw new SdkApiError(
        `Failed to initialize MainSDK: ${formatErrorMessage(error)}`,
        500,
        "INIT_FAILED",
        undefined,
        "MainSDK"
      );
    }
  }

  /**
   * Creates a MainSDK instance and verifies that Fireblocks workspace supports deterministic signing.
   * @param config - SDK configuration
   * @returns Initialized SDK instance
   * @throws SdkApiError if deterministic signing verification fails
   */
  static async create(config: MainSDKConfig): Promise<MainSDK> {
    // Guard: mainnet is not yet live.
    if (!config.testnet) {
      const mainnetRpc = config.rpcUrl ?? api_constants.mainnet_rpc;
      if (!mainnetRpc || SEISMIC_CHAIN_ID.mainnet === 0) {
        throw new SdkApiError(
          "Seismic mainnet is not yet available. Set NETWORK=testnet (or testnet: true) to use the Seismic testnet.",
          503,
          "MAINNET_NOT_AVAILABLE",
          undefined,
          "MainSDK"
        );
      }
    }

    const sdk = new MainSDK(config);
    if (!sdk.skipDeterminismCheck) {
      await sdk.runDeterminismCheck("0");
    }
    return sdk;
  }

  private async runDeterminismCheck(vaultId: string): Promise<void> {
    this.logger.info(`Running deterministic signing check | vault:${vaultId}`);
    const sig1 = await this.fireblocksService.signTransaction(
      SEED_MESSAGE_HEX.slice(2),
      vaultId,
      "determinism-check"
    );
    const sig2 = await this.fireblocksService.signTransaction(
      SEED_MESSAGE_HEX.slice(2),
      vaultId,
      "determinism-check"
    );
    if (sig1.signature?.fullSig !== sig2.signature?.fullSig) {
      this.deterministicSigningVerified = false;
      throw new SdkApiError(
        "Fireblocks workspace does not support deterministic signing. " +
          "The SDK requires deterministic MPC signatures to derive a stable encryption key. " +
          "Enable 'Deterministic Signing' in your Fireblocks workspace settings, " +
          "or set skipDeterminismCheck: true in the SDK config to bypass this guard.",
        500,
        "DETERMINISTIC_SIGNING_REQUIRED",
        undefined,
        "MainSDK"
      );
    }
    this.deterministicSigningVerified = true;
    this.logger.info(`Deterministic signing verified | vault:${vaultId}`);
  }

  private assertDeterministicSigning(): void {
    if (this.deterministicSigningVerified === false) {
      throw new SdkApiError(
        "SDK is blocked: Fireblocks workspace does not support deterministic signing.",
        500,
        "DETERMINISTIC_SIGNING_REQUIRED",
        undefined,
        "MainSDK"
      );
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

  private buildFireblocksAccount(address: Address, vaultId: string, purpose: string) {
    return toAccount({
      address,
      signMessage: async () => {
        throw new SdkApiError(
          "signMessage not supported for Fireblocks account",
          400,
          "UNSUPPORTED_OPERATION",
          undefined,
          "MainSDK"
        );
      },
      signTypedData: async (typedData) => {
        const hash = hashTypedData(typedData as Parameters<typeof hashTypedData>[0]);
        const signedMsg = await this.fireblocksService.signTransaction(
          hash.slice(2),
          vaultId,
          purpose
        );
        const sig = signedMsg.signature;
        if (!sig?.r || !sig?.s || sig.v === undefined) {
          throw new SdkApiError(
            "Incomplete signature from Fireblocks",
            502,
            "SIGNATURE_INCOMPLETE",
            undefined,
            "MainSDK"
          );
        }
        const r = sig.r.replace(/^0x/, "").padStart(64, "0");
        const s = sig.s.replace(/^0x/, "").padStart(64, "0");
        const v = (sig.v < 27 ? sig.v + 27 : sig.v).toString(16).padStart(2, "0");
        return `0x${r}${s}${v}` as Hex;
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
          purpose
        );
        const sig = signedMsg.signature;
        if (!sig?.r || !sig?.s || sig.v === undefined) {
          throw new SdkApiError(
            "Incomplete signature from Fireblocks",
            502,
            "SIGNATURE_INCOMPLETE",
            undefined,
            "MainSDK"
          );
        }
        const r = `0x${sig.r.replace(/^0x/, "").padStart(64, "0")}` as Hex;
        const s = `0x${sig.s.replace(/^0x/, "").padStart(64, "0")}` as Hex;
        const v = BigInt(sig.v < 27 ? sig.v : sig.v - 27);
        return serialize(transaction, { r, s, v });
      },
    });
  }

  /**
   * Fetches ERC-20 token metadata (name, symbol, decimals, totalSupply).
   * @param contractAddress - ERC-20 contract address
   * @returns Token metadata object
   * @throws SdkApiError on failure
   */
  public async getTokenInfo(contractAddress: string): Promise<{
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    totalSupply: string | null;
  }> {
    return this.blockchainApiService.getTokenInfo(contractAddress);
  }

  /**
   * Fetches a transaction by hash.
   * @param txHash - Transaction hash (0x-prefixed)
   * @returns Transaction object, or null if not found
   * @throws SdkApiError on failure
   */
  public async getTransactionByHash(txHash: string): Promise<Record<string, unknown> | null> {
    return this.blockchainApiService.getTransactionByHash(txHash);
  }

  /**
   * Retrieves transaction history for a vault.
   * Routes by type: susdc (requires SOCIALSCAN_API_KEY), erc20, src20, all.
   * @param params.vaultId - Vault account ID
   * @param params.type - Asset type filter: "susdc" | "erc20" | "src20" | "all"
   * @param params.fromBlock - Optional start block (hex format or "earliest")
   * @param params.toBlock - Optional end block (hex format or "latest")
   * @param params.before - Optional end date (YYYY-MM-DD format) - overrides toBlock
   * @param params.after - Optional start date (YYYY-MM-DD format) - overrides fromBlock
   * @param params.contracts - Optional contract addresses to filter by
   * @param params.limit - Optional limit on number of results (default: 50)
   * @param params.offset - Optional offset for pagination (default: 0)
   * @returns Promise with success flag, array of transactions, and metadata (fromBlock, toBlock, source, total)
   */
  public async getTransactionHistory(params: {
    vaultId: string;
    type?: "susdc" | "erc20" | "src20" | "all";
    fromBlock?: string;
    toBlock?: string;
    before?: string;
    after?: string;
    contracts?: string[];
    limit?: number;
    offset?: number;
  }): Promise<{
    transactions: Transaction[];
    fromBlock: string;
    toBlock: string;
    source: string;
    total: number;
    warning?: string;
  }> {
    if (params.type === "src20" || params.type === "all") {
      this.assertDeterministicSigning();
    }
    const vaultData = await this.ensureVaultData(params.vaultId);

    let encryptionSk: Hex | undefined;
    let viewingKey: Hex | undefined;

    if (params.type === "src20" || params.type === "all") {
      try {
        const isRegistered = await this.checkViewingKeyRegistered(params.vaultId);
        if (isRegistered) {
          viewingKey = await this.deriveViewingKey(params.vaultId);
        }
        encryptionSk = await this.deriveEncryptionKey(params.vaultId);
      } catch (err) {
        this.logger.warn(
          `Could not derive keys for SRC-20 history - amounts will be 0: ${(err as Error).message}`
        );
      }
    }

    return this.blockchainApiService.getTransactionHistory({
      address: vaultData.address,
      type: params.type,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      before: params.before,
      after: params.after,
      contracts: params.contracts,
      limit: params.limit,
      offset: params.offset,
      encryptionSk,
      viewingKey,
    });
  }

  /**
   * @deprecated Inject via MainSDKConfig.services for testing; direct access will be removed in a future major version.
   */
  public getFireblocksService(): FireblocksService {
    this.logger.warn(
      "getFireblocksService() is deprecated and will be removed in a future version."
    );
    return this.fireblocksService;
  }

  public estimateTxFee = async (): Promise<number> => {
    return this.blockchainApiService.estimateTxFee();
  };

  /**
   * Returns the vault's sUSDC balance (Seismic's primary gas and value token).
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @returns Balance as a decimal string (e.g. "250.5")
   * @throws SdkApiError on failure
   */
  public getSUsdcBalance = async (vaultAccountId: string): Promise<string> => {
    this.logger.debug(`Fetching sUSDC balance for vault ${vaultAccountId}`);
    return this.getSrc20Balance(vaultAccountId, SUSDC_CONTRACT_ADDRESS, SUSDC_DECIMALS);
  };

  /**
   * Fast-path batch balance fetch using `eth_getBalance` - a single JSON-RPC batch HTTP request
   * for all vaults. No Fireblocks signing required.
   *
   * @param vaultIds - Array of Fireblocks vault account IDs
   * @returns One entry per vault, in the same order as the input. Failed vaults get `balance: "0"`
   *          and a populated `error` field rather than throwing.
   */
  public batchGetSUsdcBalances = async (
    vaultIds: string[]
  ): Promise<Array<{ vaultAccountId: string; balance: string; error?: string }>> => {
    this.logger.debug(`batchGetSUsdcBalances: resolving ${vaultIds.length} vault(s)`);

    // Resolve all vault addresses in parallel.
    const addressResults = await Promise.allSettled(vaultIds.map((id) => this.ensureVaultData(id)));

    const resolvedVaultIds: string[] = [];
    const vaultErrors = new Map<string, string>();

    for (let i = 0; i < vaultIds.length; i++) {
      const r = addressResults[i];
      if (r.status === "fulfilled") {
        resolvedVaultIds.push(vaultIds[i]);
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        vaultErrors.set(vaultIds[i], msg);
      }
    }

    // Build one eth_getBalance request per resolved vault.
    const requests = resolvedVaultIds.map((id) => ({
      method: "eth_getBalance",
      params: [this.vaultData.get(id)!.address, "latest"],
    }));

    let batchResults: Array<{
      id: number;
      result?: string;
      error?: { code: number; message: string };
    }> = [];
    if (requests.length > 0) {
      batchResults = await this.blockchainApiService.jsonRpcBatch<string>(requests);
    }

    const batchById = new Map(batchResults.map((r) => [r.id, r]));

    const output: Array<{ vaultAccountId: string; balance: string; error?: string }> = [];
    let resolvedIdx = 0;

    for (const vaultAccountId of vaultIds) {
      if (vaultErrors.has(vaultAccountId)) {
        output.push({ vaultAccountId, balance: "0", error: vaultErrors.get(vaultAccountId) });
        continue;
      }
      const item = batchById.get(resolvedIdx++);
      if (!item || item.error) {
        output.push({
          vaultAccountId,
          balance: "0",
          error: item?.error?.message ?? "Unknown RPC error",
        });
      } else {
        const balance = formatUnits(BigInt(item.result ?? "0x0"), 18);
        output.push({ vaultAccountId, balance });
      }
    }

    return output;
  };

  /**
   * Retrieves the fungible token balances for a vault account address.
   *
   * @param vaultAccountId - The Fireblocks vault account ID
   * @returns A promise that resolves to a {GetFtBalancesResponse}
   */
  /**
   * Retrieves the fungible token balances for a vault account address.
   * @param vaultAccountId - The Fireblocks vault account ID
   * @returns Array of token balances
   * @throws SdkApiError on failure
   */
  public getFtBalances = async (
    vaultAccountId: string
  ): Promise<{ token: TokenType; balance: number }[]> => {
    this.logger.debug(`Fetching fungible token balances for vault ${vaultAccountId}`);
    const { address } = await this.ensureVaultData(vaultAccountId);
    const balances = await this.blockchainApiService.getFTBalancesForAddress(address);
    return balances.map((b) => ({ token: b.token, balance: b.balance }));
  };

  /**
   * Unified transfer method - handles sUSDC, ERC-20, and SRC-20, vault-to-vault or vault-to-address.
   *
   * Exactly one of `recipient` (EVM address) or `destinationVaultId` (Fireblocks vault ID) must be set.
   * `contractAddress` is required for ERC20 and SRC20 types; sUSDC uses the built-in contract address.
   *
   * @example vault-to-vault sUSDC
   *   sdk.transfer({ vaultId: "0", type: "SUSDC", destinationVaultId: "1", amount: "100" })
   * @example vault-to-address ERC-20
   *   sdk.transfer({ vaultId: "0", type: "ERC20", recipient: "0xABC...", amount: "100", contractAddress: "0xDEF..." })
   * @throws SdkApiError on validation failure or transaction error
   */
  public transfer = async (params: {
    vaultId: string;
    type: "SUSDC" | "ERC20" | "SRC20";
    recipient?: string;
    destinationVaultId?: string;
    amount: string;
    contractAddress?: string;
    decimals?: number;
    note?: string;
  }): Promise<{ txHash: string }> => {
    const {
      vaultId,
      type,
      recipient,
      destinationVaultId,
      amount,
      contractAddress,
      decimals,
      note,
    } = params;

    if (!recipient && !destinationVaultId) {
      throw new SdkApiError(
        "Either recipient or destinationVaultId must be provided",
        400,
        "VALIDATION_ERROR",
        undefined,
        "MainSDK"
      );
    }
    const to = destinationVaultId
      ? await this.getSeismicAddress(destinationVaultId)
      : (recipient as string);

    if (type === "SRC20") {
      if (!contractAddress)
        throw new SdkApiError(
          "contractAddress is required for SRC20",
          400,
          "VALIDATION_ERROR",
          undefined,
          "MainSDK"
        );
      return this.createShieldedTransaction(vaultId, to, amount, contractAddress, decimals, note);
    }
    if (type === "ERC20") {
      if (!contractAddress)
        throw new SdkApiError(
          "contractAddress is required for ERC20",
          400,
          "VALIDATION_ERROR",
          undefined,
          "MainSDK"
        );
      return this.createErc20Transaction(vaultId, to, amount, contractAddress, decimals, note);
    }
    // SUSDC: use the well-known contract; decimals baked in
    return this.createSUsdcTransaction(vaultId, to, amount, note);
  };

  /**
   * Transfers sUSDC (Seismic's primary gas/value token) to a recipient.
   * Uses the well-known sUSDC contract address - callers do not need to supply it.
   *
   * @param vaultAccountId   - Source Fireblocks vault account ID
   * @param recipientAddress - Destination EVM address
   * @param amount           - Amount in whole sUSDC units (e.g. "100" for 100 sUSDC)
   * @param note             - Optional label on the Fireblocks signing request
   * @throws SdkApiError on failure
   */
  public createSUsdcTransaction = async (
    vaultAccountId: string,
    recipientAddress: string,
    amount: string,
    note?: string
  ): Promise<{ txHash: string }> => {
    return this.createShieldedTransaction(
      vaultAccountId,
      recipientAddress,
      amount,
      SUSDC_CONTRACT_ADDRESS,
      SUSDC_DECIMALS,
      note ?? "susdc-transfer"
    );
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
  /**
   * Transfers a standard ERC-20 token from a vault to a recipient.
   * @throws SdkApiError on failure
   */
  public createErc20Transaction = async (
    vaultAccountId: string,
    recipientAddress: string,
    amount: string,
    contractAddress: string,
    decimals?: number,
    note?: string
  ): Promise<{ txHash: string }> => {
    try {
      const vaultData = await this.ensureVaultData(vaultAccountId);

      const resolvedDecimals =
        decimals ??
        (await this.blockchainApiService.getTokenInfo(contractAddress)).decimals ??
        DEFAULT_TOKEN_DECIMALS;
      const amountWei = parseUnits(amount, resolvedDecimals);

      // Encode transfer(address,uint256) calldata
      const paddedTo = recipientAddress.slice(2).toLowerCase().padStart(64, "0");
      const paddedAmount = amountWei.toString(16).padStart(64, "0");
      const calldata = `${ERC20_SELECTORS.transfer}${paddedTo}${paddedAmount}` as Hex;

      // Build unsigned tx: to=contract, value=0, data=calldata
      const [hexNonce, hexGasPrice] = await Promise.all([
        this.blockchainApiService.jsonRpc<string>("eth_getTransactionCount", [
          vaultData.address,
          "pending",
        ]),
        this.blockchainApiService.jsonRpc<string>("eth_gasPrice", []),
      ]);

      const nonce = parseInt(hexNonce, 16);
      const gasPrice = BigInt(hexGasPrice);
      const chainId = this.blockchainApiService.getChainId();
      const gasLimit = await this.blockchainApiService
        .jsonRpc<string>("eth_estimateGas", [
          { from: vaultData.address, to: contractAddress, data: calldata },
        ])
        .then((hex) => (BigInt(hex) * 120n) / 100n)
        .catch(() => 100_000n);

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
        throw new SdkApiError(
          "Incomplete signature from Fireblocks",
          502,
          "SIGNATURE_INCOMPLETE",
          undefined,
          "MainSDK"
        );
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
        throw new SdkApiError(
          formatErrorMessage(result.err),
          500,
          "BROADCAST_FAILED",
          undefined,
          "MainSDK"
        );
      }
      const txHash = result.txid!;
      logTx({
        timestamp: new Date().toISOString(),
        vault: vaultAccountId,
        type: "ERC20",
        to: recipientAddress,
        amount,
        contract: contractAddress,
        nonce,
        txHash,
      });
      return { txHash };
    } catch (error) {
      if (error instanceof SdkApiError) throw error;
      throw new SdkApiError(
        `Failed to create ERC-20 transaction: ${formatErrorMessage(error)}`,
        500,
        "ERC20_TX_FAILED",
        undefined,
        "MainSDK"
      );
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

  /**
   * Returns token balances for a vault.
   *
   * - type="erc20": auto-discovers via SocialScan (requires SOCIALSCAN_API_KEY) or
   *                 reads specific contracts if provided. Returns plaintext balances.
   * - type="src20": auto-discovers via eth_getLogs scan or reads specific contracts.
   *                 Returns decrypted shielded balances via balanceOfSigned.
   * - type="all": both in parallel, each failing independently.
   *
   * If contracts are provided they override auto-discovery for that type.
   */
  public getTokenBalances = async (
    vaultId: string,
    type: "erc20" | "src20" | "all" = "all",
    contracts?: string[]
  ): Promise<TokenBalancesResult> => {
    const { address } = await this.ensureVaultData(vaultId);

    const fetchErc20 = async () => {
      if (contracts?.length) {
        // Known contracts: call eth_call directly (no SOCIALSCAN_API_KEY needed)
        return Promise.all(
          contracts.map(async (contractAddress) => {
            try {
              const [raw, info] = await Promise.all([
                this.blockchainApiService.readErc20Balance(address, contractAddress),
                this.blockchainApiService.getTokenInfo(contractAddress),
              ]);
              const decimals = info.decimals ?? 18;
              return {
                contractAddress,
                name: info.name ?? contractAddress,
                symbol: info.symbol ?? contractAddress,
                decimals,
                balance: formatUnits(raw, decimals),
                rawBalance: raw.toString(),
              };
            } catch {
              return {
                contractAddress,
                name: "",
                symbol: "",
                decimals: 18,
                balance: "0",
                rawBalance: "0",
              };
            }
          })
        );
      }
      // No contracts: discover via SocialScan
      return this.blockchainApiService.getAllTokenBalances(address);
    };

    const fetchSrc20 = async (excludeContracts: string[] = []) => {
      let contractList = contracts?.length
        ? contracts
        : await this.blockchainApiService.discoverSrc20Contracts(address);
      if (excludeContracts.length) {
        const excluded = new Set(excludeContracts.map((c) => c.toLowerCase()));
        contractList = contractList.filter((c) => !excluded.has(c.toLowerCase()));
      }
      if (contractList.length === 0) return [];
      return Promise.all(
        contractList.map(async (contractAddress) => {
          const info = await this.blockchainApiService
            .getTokenInfo(contractAddress)
            .catch(
              () =>
                ({}) as { name?: string | null; symbol?: string | null; decimals?: number | null }
            );
          const decimals = info.decimals ?? 18;
          const balance = await this.getSrc20Balance(vaultId, contractAddress, decimals).catch(
            () => "0"
          );
          return {
            contractAddress,
            name: info.name ?? null,
            symbol: info.symbol ?? null,
            decimals: info.decimals ?? null,
            balance,
          };
        })
      );
    };

    const fetchSUSDC = async (): Promise<TokenBalance> => {
      const balance = await this.getSrc20Balance(vaultId, SUSDC_CONTRACT_ADDRESS, SUSDC_DECIMALS);
      return {
        contractAddress: SUSDC_CONTRACT_ADDRESS,
        name: "Shielded USD Coin",
        symbol: "SUSDC",
        decimals: SUSDC_DECIMALS,
        balance,
      };
    };

    if (type === "erc20") {
      return { erc20: await fetchErc20() };
    }
    if (type === "src20") {
      return { src20: await fetchSrc20() };
    }
    // type === "all": sUSDC + ERC-20 + SRC-20 in parallel, each fails independently.
    const [sUSDC, erc20, src20] = await Promise.allSettled([
      fetchSUSDC(),
      fetchErc20(),
      fetchSrc20([SUSDC_CONTRACT_ADDRESS]),
    ]);
    return {
      ...(sUSDC.status === "fulfilled"
        ? { sUSDC: sUSDC.value }
        : { sUSDCError: (sUSDC.reason as Error).message }),
      erc20: erc20.status === "fulfilled" ? erc20.value : [],
      src20: src20.status === "fulfilled" ? src20.value : [],
      ...(erc20.status === "rejected" ? { erc20Error: (erc20.reason as Error).message } : {}),
      ...(src20.status === "rejected" ? { src20Error: (src20.reason as Error).message } : {}),
    };
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
    this.assertDeterministicSigning();
    const vaultData = await this.ensureVaultData(vaultId);
    if (vaultData.encryptionSk) return vaultData.encryptionSk as Hex;

    this.logger.info(`Deriving encryption key | vault:${vaultId}`);
    const signedMsg = await this.fireblocksService.signTransaction(
      SEED_MESSAGE_HEX.slice(2), // strip 0x - rawSign expects plain hex
      vaultId,
      "derive-encryption-key"
    );

    const fullSig = signedMsg.signature?.fullSig;
    if (!fullSig)
      throw new SdkApiError(
        `Fireblocks did not return a signature for vault ${vaultId}`,
        502,
        "SIGNATURE_MISSING",
        undefined,
        "MainSDK"
      );

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
  /**
   * Reads a vault's SRC-20 balance via a Fireblocks-signed read.
   * @param vaultId         - Fireblocks vault account ID
   * @param contractAddress - SRC-20 contract address (0x-prefixed)
   * @param decimals        - Token decimal places (default: 18). Pass token's actual decimals to
   *                          avoid precision loss - e.g. 6 for sUSDC-style tokens.
   * @returns Balance in whole token units as a decimal string (e.g. "250.5")
   * @throws SdkApiError on failure
   */
  public getSrc20Balance = async (
    vaultId: string,
    contractAddress: string,
    decimals = 18
  ): Promise<string> => {
    this.assertDeterministicSigning();
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
      throw new SdkApiError(
        "Incomplete signature from Fireblocks (missing r, s, or v)",
        502,
        "SIGNATURE_INCOMPLETE",
        undefined,
        "MainSDK"
      );
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

    return formatUnits(rawBalance, decimals);
  };

  /**
   * Derives the deterministic AES viewing key for a vault.
   *
   * Register this key once via registerViewingKey() so Transfer events are encrypted to it.
   */
  public deriveViewingKey = async (vaultId: string): Promise<Hex> => {
    const vaultData = await this.ensureVaultData(vaultId);
    if (vaultData.viewingKey) return vaultData.viewingKey as Hex;
    const encryptionSk = await this.deriveEncryptionKey(vaultId);
    const viewingKey = keccak256(encryptionSk);
    vaultData.viewingKey = viewingKey;
    return viewingKey;
  };

  /**
   * Registers the vault's viewing key in the Seismic Directory precompile.
   *
   * One-time operation per address. After registration, all incoming SRC-20 Transfer
   * events will have encryptedAmount encrypted to this key - enabling getTransactionHistory
   * to return plaintext amounts for both sent and received transfers with zero extra RPC calls.
   *
   * @param vaultId - Fireblocks vault account ID
   */
  /**
   * @throws SdkApiError on failure
   */
  public registerViewingKey = async (vaultId: string): Promise<{ txHash: string }> => {
    this.assertDeterministicSigning();
    const vaultData = await this.ensureVaultData(vaultId);
    const encryptionSk = await this.deriveEncryptionKey(vaultId);
    const viewingKey = await this.deriveViewingKey(vaultId);

    const fireblocksAccount = this.buildFireblocksAccount(
      vaultData.address as Address,
      vaultId,
      "register-viewing-key"
    );

    const client = await this.blockchainApiService.createShieldedClient(
      fireblocksAccount,
      encryptionSk
    );

    const txHash = await this.blockchainApiService.registerViewingKey(client, viewingKey);
    vaultData.viewingKeyRegistered = true;
    this.logger.info(`Viewing key registered | vault:${vaultId} | tx:${txHash}`);
    logTx({
      timestamp: new Date().toISOString(),
      vault: vaultId,
      type: "register-viewing-key",
      to: vaultData.address,
      amount: "0",
      txHash,
    });
    return { txHash };
  };

  /**
   * Returns whether this vault's address has a viewing key registered in the Directory.
   *
   * Caches a `true` result permanently - the Directory is append-only so once registered
   * it never un-registers. An `undefined` or `false` result triggers a fresh RPC check.
   *
   * @param vaultId - Fireblocks vault account ID
   */
  public checkViewingKeyRegistered = async (vaultId: string): Promise<boolean> => {
    const vaultData = await this.ensureVaultData(vaultId);
    if (vaultData.viewingKeyRegistered === true) return true;
    const registered = await this.blockchainApiService.checkViewingKeyRegistered(
      vaultData.address as Address
    );
    if (registered) vaultData.viewingKeyRegistered = true;
    return registered;
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
  /**
   * @throws SdkApiError on failure
   */
  public createShieldedTransaction = async (
    vaultId: string,
    recipient: string,
    amount: string,
    contractAddress: string,
    decimals = DEFAULT_TOKEN_DECIMALS,
    note?: string
  ): Promise<{ txHash: string }> => {
    this.assertDeterministicSigning();
    const vaultData = await this.ensureVaultData(vaultId);
    const encryptionSk = await this.deriveEncryptionKey(vaultId);

    const fireblocksAccount = this.buildFireblocksAccount(
      vaultData.address as Address,
      vaultId,
      note || "src20-shielded-transfer"
    );

    const client = await this.blockchainApiService.createShieldedClient(
      fireblocksAccount,
      encryptionSk
    );

    const amountBigInt = parseUnits(amount, decimals);
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
    logTx({
      timestamp: new Date().toISOString(),
      vault: vaultId,
      type:
        contractAddress.toLowerCase() === SUSDC_CONTRACT_ADDRESS.toLowerCase() ? "SUSDC" : "SRC20",
      to: recipient,
      amount,
      contract: contractAddress,
      txHash,
    });
    return { txHash };
  };

  /**
   * Gracefully shutdown the SDK.
   * Zeroes encryptionSk values in memory before clearing vault data.
   *
   * @returns Promise that resolves when shutdown is complete
   */
  /**
   * Validates the SocialScan Explorer API key.
   * Makes a lightweight request to the SocialScan API to confirm the key is accepted.
   *
   * @returns Object with `valid` boolean and optional `error` message
   */
  public async validateExplorerApiKey(apiKey: string): Promise<{
    valid: boolean;
    status: "valid" | "invalid_key" | "service_error";
    error?: string;
  }> {
    return this.blockchainApiService.validateExplorerApiKey(apiKey);
  }

  public async shutdown(): Promise<void> {
    this.logger.info("Shutting down MainSDK...");
    for (const vaultData of this.vaultData.values()) {
      if (vaultData.encryptionSk) {
        vaultData.encryptionSk = "0".repeat(vaultData.encryptionSk.length);
      }
      if (vaultData.viewingKey) {
        vaultData.viewingKey = "0".repeat(vaultData.viewingKey.length);
      }
    }
    this.vaultData.clear();
    this.logger.info("MainSDK shutdown complete");
  }
}
