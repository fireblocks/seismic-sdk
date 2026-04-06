import { AxiosInstance } from "axios";
import {
  http,
  type Chain,
  type Address,
  type Hex,
  type Transport,
  keccak256,
  toRlp,
  numberToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  createShieldedPublicClient,
  createShieldedWalletClient,
  getShieldedContract,
  seismicDevnet2,
  type ShieldedPublicClient,
  type ShieldedWalletClient,
  type GetSeismicClientsParameters,
} from "seismic-viem";
import {
  Logger,
  ErrorHandler,
  api_constants,
  validateAddress,
  validateAmount,
} from "../utils/index.js";
import {
  BroadcastResult,
  GetTransactionHistoryParams,
  GetTransactionHistoryFromIndexerOpts,
  TokenType,
  Transaction,
  UnsignedTransaction,
  TransactionType,
} from "../types/index.js";
import axiosInstance from "../utils/httpClient.js";
import { chain_info, SEISMIC_CHAIN_ID } from "../utils/constants.js";
import { SRC20Abi } from "../seismic/abi.js";

type SeismicClient = ShieldedWalletClient<Transport, Chain>;
type SeismicPublicClient = ShieldedPublicClient<Transport, Chain>;

export class BlockchainApiService {
  private readonly logger = new Logger("services:blockchain-api");
  private axiosClient: AxiosInstance;
  private readonly rpcUrl: string;
  private readonly chainId: number;
  private readonly errorHandler = new ErrorHandler("blockchain-api", this.logger);
  private network: "mainnet" | "testnet";

  constructor(testnet: boolean = false) {
    this.axiosClient = axiosInstance;
    this.rpcUrl =
      process.env.RPC_URL || (testnet ? api_constants.testnet_rpc : api_constants.mainnet_rpc);
    this.chainId = testnet ? SEISMIC_CHAIN_ID.testnet : SEISMIC_CHAIN_ID.testnet;
    this.network = testnet ? "testnet" : "mainnet";
  }

  public getChainId = (): number => this.chainId;

  /**
   * Sends a JSON-RPC request to the Seismic node.
   */
  private async jsonRpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await this.axiosClient.post(this.rpcUrl, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
    if (response.data.error) {
      throw new Error(`JSON-RPC error: ${JSON.stringify(response.data.error)}`);
    }
    return response.data.result as T;
  }

  // ─── Address ────────────────────────────────────────────────────────────────

  /**
   * Derives the Seismic/ETH address from a compressed secp256k1 public key.
   *
   * Decompresses the 33-byte pubkey to 65 bytes, strips the '04' prefix,
   * applies keccak256, and takes the last 20 bytes — standard EVM address derivation.
   */
  public formatAddress = (pubKey: string): string => {
    try {
      if (!pubKey || typeof pubKey !== "string") {
        throw this.errorHandler.handleApiError(
          new Error("Public key must be a non-empty string"),
          "formatting address"
        );
      }

      const hex = pubKey.replace(/^0x/, "");
      const point = secp256k1.ProjectivePoint.fromHex(hex);
      const uncompressedHex = point.toHex(false).slice(2); // strip '04' prefix
      const hash = keccak256(`0x${uncompressedHex}` as Hex);
      return `0x${hash.slice(-40)}`;
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "formatting address");
    }
  };

  // ─── Balances ───────────────────────────────────────────────────────────────

  /**
   * Retrieves the native ETH balance for a Seismic address.
   * Calls eth_getBalance and converts from wei to ETH.
   */
  public getNativeBalance = async (address: string): Promise<number> => {
    try {
      if (!validateAddress(address)) {
        throw this.errorHandler.handleApiError(
          new Error("Invalid address"),
          "fetching native balance"
        );
      }

      const hexBalance = await this.jsonRpc<string>("eth_getBalance", [address, "latest"]);
      const weiBalance = BigInt(hexBalance);
      const divisor = BigInt(10 ** chain_info.coinDecimals);
      const whole = weiBalance / divisor;
      const remainder = weiBalance % divisor;
      return Number(whole) + Number(remainder) / 10 ** chain_info.coinDecimals;
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "fetching native balance");
    }
  };

  /**
   * Reads a standard ERC-20 balanceOf(address) via eth_call.
   * Returns the raw BigInt balance (in the token's smallest unit).
   *
   * @param holderAddress   - The address whose balance to query
   * @param contractAddress - ERC-20 contract address
   */
  public readErc20Balance = async (
    holderAddress: string,
    contractAddress: string
  ): Promise<bigint> => {
    // balanceOf(address) selector = 0x70a08231, padded to 32 bytes
    const data = "0x70a08231" + holderAddress.slice(2).toLowerCase().padStart(64, "0");

    const result = await this.jsonRpc<string>("eth_call", [
      { to: contractAddress, data },
      "latest",
    ]);

    return BigInt(result || "0x0");
  };

  /**
   * Returns fungible token balances for a Seismic address.
   *
   * SRC-20 balances are encrypted on-chain and require a Fireblocks-signed read
   * (via readSrc20BalanceSigned). Standard eth_call returns zero for shielded
   * suint256 storage. This method returns an empty array; call readSrc20BalanceSigned
   * from MainSDK.getSrc20Balance for shielded balance reads.
   */
  public getFTBalancesForAddress = async (
    address: string
  ): Promise<{ token: TokenType; balance: number }[]> => {
    try {
      if (!validateAddress(address)) {
        throw this.errorHandler.handleApiError(
          new Error("Invalid address"),
          "fetching fungible token balances"
        );
      }
      return [];
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "fetching fungible token balances");
    }
  };

  // ─── Fees ───────────────────────────────────────────────────────────────────

  /**
   * Estimates the transaction fee for a standard ETH transfer.
   * Uses eth_gasPrice and a fixed gas limit of 21 000 for native transfers.
   */
  public estimateTxFee = async (): Promise<number> => {
    try {
      const hexGasPrice = await this.jsonRpc<string>("eth_gasPrice", []);
      const gasPriceWei = BigInt(hexGasPrice);
      const gasLimit = 21_000n;
      const feeWei = gasPriceWei * gasLimit;
      return Number(feeWei) / 10 ** chain_info.coinDecimals;
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "estimating transaction fee");
    }
  };

  // ─── Transaction building ────────────────────────────────────────────────────

  /**
   * Builds an unsigned ETH transfer transaction for Seismic.
   *
   * For SRC-20 shielded transfers use MainSDK.createShieldedTransaction instead —
   * seismic-viem handles calldata encryption and type-0x4A serialization internally.
   */
  public buildUnsignedTransaction = async (
    sender: string,
    recipient: string,
    amount: number,
    _type: TransactionType = TransactionType.Native,
    _token?: TokenType
  ): Promise<UnsignedTransaction> => {
    try {
      if (!validateAddress(recipient) || !validateAddress(sender)) {
        throw this.errorHandler.handleApiError(
          new Error("Invalid sender or recipient address"),
          "building unsigned transaction"
        );
      }

      if (!validateAmount(amount)) {
        throw this.errorHandler.handleApiError(
          new Error("Invalid amount"),
          "building unsigned transaction"
        );
      }

      const [hexNonce, hexGasPrice] = await Promise.all([
        this.jsonRpc<string>("eth_getTransactionCount", [sender, "latest"]),
        this.jsonRpc<string>("eth_gasPrice", []),
      ]);

      const nonce = parseInt(hexNonce, 16);
      const gasPrice = BigInt(hexGasPrice);
      const gasLimit = 21_000n;
      const valueWei = BigInt(Math.round(amount * 10 ** chain_info.coinDecimals));

      const evmTxFields = {
        from: sender,
        to: recipient,
        value: `0x${valueWei.toString(16)}`,
        data: "0x",
        nonce: `0x${nonce.toString(16)}`,
        gasPrice: `0x${gasPrice.toString(16)}`,
        gas: `0x${gasLimit.toString(16)}`,
      };

      // EIP-155 signing hash: keccak256(RLP([nonce, gasPrice, gas, to, value, data, chainId, 0, 0]))
      const rlpEncoded = toRlp([
        nonce === 0 ? "0x" : numberToHex(nonce),
        numberToHex(gasPrice),
        numberToHex(gasLimit),
        recipient as Hex,
        numberToHex(valueWei),
        "0x",
        numberToHex(this.chainId),
        "0x",
        "0x",
      ]);
      const signingHash = keccak256(rlpEncoded);

      return { unsignedTx: evmTxFields, evmTxFields, signingHash };
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "building unsigned transaction");
    }
  };

  /**
   * Serializes the unsigned transaction for Fireblocks RAW signing.
   * Delegates to buildUnsignedTransaction — callers use the tx fields to construct
   * the EIP-155 hash that Fireblocks signs.
   */
  public serializeTransaction = async (
    sender: string,
    recipient: string,
    amount: number,
    type: TransactionType = TransactionType.Native,
    token?: TokenType
  ): Promise<UnsignedTransaction> => {
    try {
      return await this.buildUnsignedTransaction(sender, recipient, amount, type, token);
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "serializing transaction");
    }
  };

  /**
   * Broadcasts a signed raw transaction to the Seismic network via eth_sendRawTransaction.
   *
   * For shielded SRC-20 transfers, use MainSDK.createShieldedTransaction — those
   * go through seismic-viem and never reach this method.
   */
  public broadcastTransaction = async (signedTx: unknown): Promise<BroadcastResult> => {
    try {
      if (typeof signedTx !== "string" || !signedTx.startsWith("0x")) {
        throw new Error("signedTx must be a 0x-prefixed hex string");
      }

      const txHash = await this.jsonRpc<string>("eth_sendRawTransaction", [signedTx]);
      this.logger.info(`Transaction broadcast | txHash:${txHash}`);
      return { txid: txHash };
    } catch (error) {
      this.logger.error(`Broadcast failed: ${error}`);
      return { err: error };
    }
  };

  /**
   * Retrieves transaction history for a Seismic address.
   *
   * Seismic testnet does not currently expose a full transaction history indexer.
   * Returns an empty array; integrate a block explorer API when available.
   */
  public getTransactionHistory = async (
    params: GetTransactionHistoryParams
  ): Promise<Transaction[]> => {
    if (
      "address" in params &&
      !validateAddress((params as GetTransactionHistoryFromIndexerOpts).address)
    ) {
      throw this.errorHandler.handleApiError(
        new Error("Invalid address provided"),
        "fetching transactions history"
      );
    }

    this.logger.debug(
      `getTransactionHistory | ${this.network} | no history indexer on Seismic testnet`
    );
    return [];
  };

  // ─── Seismic shielded operations (seismic-viem) ──────────────────────────────

  /**
   * Creates a Seismic shielded wallet client.
   *
   * This is async because seismic-viem fetches the TEE public key and derives
   * the AES-GCM encryption key at initialization time.
   *
   * @param accountPrivateKey - The vault's private key proxy used as the signing key
   * @param encryptionSk      - 32-byte hex key for ECDH with the Seismic TEE.
   *                            Derived deterministically from a Fireblocks RAW signature
   *                            via deriveKeyFromSignature — never stored on disk.
   */
  public createShieldedClient = async (
    accountPrivateKey: Hex,
    encryptionSk?: Hex
  ): Promise<SeismicClient> => {
    const account = privateKeyToAccount(accountPrivateKey);

    const chain: Chain = {
      ...seismicDevnet2,
      id: this.chainId,
      rpcUrls: {
        default: { http: [this.rpcUrl] },
      },
    };

    const clientConfig: GetSeismicClientsParameters<Transport, Chain, typeof account> = {
      chain,
      account,
      transport: http(this.rpcUrl),
      encryptionSk,
    };

    this.logger.info(`Creating shielded client | rpc:${this.rpcUrl} | chainId:${this.chainId}`);
    const client = await createShieldedWalletClient(clientConfig);
    this.logger.info("Shielded client created — TEE public key fetched");
    return client as SeismicClient;
  };

  /**
   * Creates a Seismic public client for read-only operations.
   *
   * Unlike createShieldedClient, this does not require a private key — suitable for
   * readSrc20BalanceSigned where authorization comes from the Fireblocks-signed message
   * parameter, not the client's account.
   */
  public createPublicClient = (): SeismicPublicClient => {
    const chain: Chain = {
      ...seismicDevnet2,
      id: this.chainId,
      rpcUrls: {
        default: { http: [this.rpcUrl] },
      },
    };

    return createShieldedPublicClient({
      chain,
      transport: http(this.rpcUrl),
    }) as SeismicPublicClient;
  };

  /**
   * Reads the caller's own SRC-20 balance via a signed read.
   * The client's private key automatically signs the eth_call so the TEE can
   * verify identity and decrypt the shielded balance.
   */
  public readSrc20Balance = async (
    client: SeismicClient,
    contractAddress: Address
  ): Promise<bigint> => {
    this.logger.debug(`Reading own balance | contract:${contractAddress}`);
    const result = await client.readContract({
      address: contractAddress,
      abi: SRC20Abi,
      functionName: "balance",
    });
    return result as bigint;
  };

  /**
   * Reads a vault's SRC-20 balance using a Fireblocks MPC signature for authorization.
   *
   * Used when the vault never holds a raw private key: the Fireblocks vault signs an
   * EIP-191 message off-chain, and the SRC-20 contract verifies it via ecrecover.
   *
   * @param client          - Any seismic-viem client (used only for the RPC call)
   * @param contractAddress - SRC-20 contract address
   * @param ownerAddress    - Vault's Seismic/ETH address
   * @param signature       - 65-byte packed signature from FireblocksSigner.packSignature()
   * @param expiry          - Unix timestamp from createExpiry() — must not be expired
   */
  public readSrc20BalanceSigned = async (
    client: SeismicPublicClient,
    contractAddress: Address,
    ownerAddress: Address,
    signature: Hex,
    expiry: bigint
  ): Promise<bigint> => {
    this.logger.debug(
      `Reading signed balance | contract:${contractAddress} | owner:${ownerAddress}`
    );
    const result = await client.readContract({
      address: contractAddress,
      abi: SRC20Abi,
      functionName: "balanceOfSigned",
      args: [ownerAddress, expiry, signature],
    });
    return result as bigint;
  };

  /**
   * Submits an encrypted SRC-20 transfer as a Seismic type-0x4A transaction.
   *
   * seismic-viem automatically:
   * 1. ABI-encodes the transfer(address, suint256) calldata
   * 2. Encrypts it with AES-256-GCM using ECDH(encryptionSk, TEE pubkey) + HKDF
   * 3. Constructs the type-0x4A transaction with SeismicElements metadata
   * 4. Signs and broadcasts
   *
   * @returns Transaction hash
   */
  public submitShieldedTransfer = async (
    client: SeismicClient,
    contractAddress: Address,
    to: Address,
    amount: bigint
  ): Promise<Hex> => {
    this.logger.info(
      `Submitting shielded transfer | contract:${contractAddress} | to:${to} | amount:${amount}`
    );

    const contract = getShieldedContract({
      abi: SRC20Abi,
      address: contractAddress,
      client,
    });

    const txHash = await contract.write.transfer([to, amount]);
    this.logger.info(`Shielded transfer submitted | txHash:${txHash}`);
    return txHash;
  };

  /**
   * Polls until the transaction is confirmed on Seismic.
   * Default timeout is 60 seconds — increase for high-congestion periods.
   */
  public waitForReceipt = async (client: SeismicClient, txHash: Hex, timeoutMs = 60_000) => {
    this.logger.debug(`Waiting for receipt | txHash:${txHash}`);
    return client.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs });
  };
}
