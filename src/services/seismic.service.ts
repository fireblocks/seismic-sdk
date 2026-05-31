import { AxiosInstance } from "axios";
import {
  type Address,
  type Hex,
  type Transport,
  type Chain,
  keccak256,
  toRlp,
  numberToHex,
  parseUnits,
  formatUnits,
} from "viem";
import type { LocalAccount } from "viem/accounts";
import { type ShieldedPublicClient, type ShieldedWalletClient } from "seismic-viem";
import {
  Logger,
  ErrorHandler,
  api_constants,
  validateAddress,
  validateAmount,
  chain_info,
  SEISMIC_CHAIN_ID,
  ERC20_SELECTORS,
  DEFAULT_TOKEN_DECIMALS,
} from "../utils/index.js";
import {
  BroadcastResult,
  GetTransactionHistoryFromIndexerOpts,
  TokenType,
  Transaction,
  UnsignedTransaction,
  TransactionType,
} from "../types/index.js";
import { ExplorerService } from "./explorer.service.js";
import { RpcService, SeismicShieldedService, TransactionHistoryService } from "./seismic/index.js";

type SeismicClient = ShieldedWalletClient<Transport, Chain>;
type SeismicPublicClient = ShieldedPublicClient<Transport, Chain>;

export class BlockchainApiService {
  private readonly logger: Logger;
  private readonly errorHandler: ErrorHandler;
  private readonly rpc: RpcService;
  private readonly shielded: SeismicShieldedService;
  private readonly historyService: TransactionHistoryService;
  private readonly socialscanApiKey?: string;

  constructor(
    testnet: boolean = false,
    opts?: { rpcUrl?: string; socialscanApiKey?: string; httpClient?: AxiosInstance }
  ) {
    const rpcUrl =
      opts?.rpcUrl ?? (testnet ? api_constants.testnet_rpc : api_constants.mainnet_rpc);
    const chainId = testnet ? SEISMIC_CHAIN_ID.testnet : SEISMIC_CHAIN_ID.mainnet;

    this.socialscanApiKey = opts?.socialscanApiKey;
    this.logger = new Logger("services:blockchain-api");
    this.errorHandler = new ErrorHandler("blockchain-api", this.logger);

    this.rpc = new RpcService({
      axiosClient: opts?.httpClient,
      rpcUrl,
      chainId,
      testnet,
      logger: this.logger,
    });

    this.shielded = new SeismicShieldedService(this.rpc, this.logger);

    this.historyService = new TransactionHistoryService(
      this.rpc,
      this.shielded,
      opts?.socialscanApiKey,
      this.logger
    );
  }

  public getChainId = (): number => this.rpc.chainId;

  // ── RpcService delegation ───────────────────────────────────────────────────

  public async jsonRpc<T>(method: string, params: unknown[]): Promise<T> {
    return this.rpc.jsonRpc<T>(method, params);
  }

  public formatAddress = (pubKey: string): string => this.rpc.formatAddress(pubKey);

  public getTransactionByHash = async (txHash: string): Promise<Record<string, unknown> | null> => {
    return this.rpc.getTransactionByHash(txHash);
  };

  // ── HistoryService delegation ────────────────────────────────────────────────

  public getTransactionHistory = async (
    params: GetTransactionHistoryFromIndexerOpts
  ): Promise<{
    transactions: Transaction[];
    fromBlock: string;
    toBlock: string;
    source: string;
    total: number;
    warning?: string;
  }> => {
    return this.historyService.getTransactionHistory(params);
  };

  public discoverSrc20Contracts = async (address: string): Promise<string[]> => {
    return this.historyService.discoverSrc20Contracts(address);
  };

  // ── SeismicShieldedService delegation ────────────────────────────────────────

  public decryptSrc20Amount = async (
    txHash: string,
    encryptionSk: Hex,
    decimals: number = 18
  ): Promise<string | null> => {
    return this.shielded.decryptSrc20Amount(txHash, encryptionSk, decimals);
  };

  public registerViewingKey = async (client: SeismicClient, viewingKey: Hex): Promise<Hex> => {
    return this.shielded.registerViewingKey(client, viewingKey);
  };

  public checkViewingKeyRegistered = async (address: Address): Promise<boolean> => {
    return this.shielded.checkViewingKeyRegistered(address);
  };

  public createShieldedClient = async (
    accountOrPrivateKey: Hex | LocalAccount,
    encryptionSk?: Hex
  ): Promise<SeismicClient> => {
    return this.shielded.createShieldedClient(accountOrPrivateKey, encryptionSk);
  };

  public createPublicClient = (): SeismicPublicClient => {
    return this.shielded.createPublicClient();
  };

  public readSrc20Balance = async (
    client: SeismicClient,
    contractAddress: Address
  ): Promise<bigint> => {
    return this.shielded.readSrc20Balance(client, contractAddress);
  };

  public readSrc20BalanceSigned = async (
    client: SeismicPublicClient,
    contractAddress: Address,
    ownerAddress: Address,
    signature: Hex,
    expiry: bigint
  ): Promise<bigint> => {
    return this.shielded.readSrc20BalanceSigned(
      client,
      contractAddress,
      ownerAddress,
      signature,
      expiry
    );
  };

  public submitShieldedTransfer = async (
    client: SeismicClient,
    contractAddress: Address,
    to: Address,
    amount: bigint
  ): Promise<Hex> => {
    return this.shielded.submitShieldedTransfer(client, contractAddress, to, amount);
  };

  public waitForReceipt = async (client: SeismicClient, txHash: Hex, timeoutMs = 60_000) => {
    return this.shielded.waitForReceipt(client, txHash, timeoutMs);
  };

  // ── Balances ────────────────────────────────────────────────────────────────

  /**
   * Internal debug helper. Returns `eth_getBalance` reports for the address.
   *
   * On Seismic testnet `eth_getBalance` returns the sUSDC balance (scaled), NOT the
   * native SIZE balance. SIZE is not yet minted/distributed.
   * Use `MainSDK.getSUsdcBalance(vaultId)` for sUSDC balance via `balanceOfSigned()`.
   * 
   * This method only exists for ops/debug.
   */
  public getEthGetBalanceFacade = async (address: string): Promise<string> => {
    try {
      if (!validateAddress(address)) {
        throw this.errorHandler.handleApiError(
          new Error("Invalid address"),
          "fetching eth_getBalance facade"
        );
      }
      const hexBalance = await this.rpc.jsonRpc<string>("eth_getBalance", [address, "latest"]);
      const weiBalance = BigInt(hexBalance);
      return formatUnits(weiBalance, chain_info.coinDecimals);
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "fetching eth_getBalance facade");
    }
  };

  /**
   * Fetches name, symbol, decimals, and totalSupply from a standard ERC-20 contract.
   * Any field that fails to decode (e.g. non-standard contract) is returned as null.
   */
  public getTokenInfo = async (
    contractAddress: string
  ): Promise<{
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    totalSupply: string | null;
  }> => {
    const call = (selector: string) =>
      this.rpc
        .jsonRpc<string>("eth_call", [{ to: contractAddress, data: selector }, "latest"])
        .catch(() => null);

    const [nameHex, symbolHex, decimalsHex, totalSupplyHex] = await Promise.all([
      call(ERC20_SELECTORS.name),
      call(ERC20_SELECTORS.symbol),
      call(ERC20_SELECTORS.decimals),
      call(ERC20_SELECTORS.totalSupply),
    ]);

    const decodeString = (hex: string | null): string | null => {
      if (!hex || hex === "0x") return null;
      try {
        const data = hex.slice(2);
        const offset = parseInt(data.slice(0, 64), 16) * 2;
        const length = parseInt(data.slice(offset, offset + 64), 16) * 2;
        const strHex = data.slice(offset + 64, offset + 64 + length);
        return Buffer.from(strHex, "hex").toString("utf8");
      } catch {
        return null;
      }
    };

    return {
      name: decodeString(nameHex),
      symbol: decodeString(symbolHex),
      decimals:
        decimalsHex && decimalsHex !== "0x" ? parseInt(decimalsHex, 16) : DEFAULT_TOKEN_DECIMALS,
      totalSupply:
        totalSupplyHex && totalSupplyHex !== "0x" ? BigInt(totalSupplyHex).toString() : null,
    };
  };

  public readErc20Balance = async (
    holderAddress: string,
    contractAddress: string
  ): Promise<bigint> => {
    const data = ERC20_SELECTORS.balanceOf + holderAddress.slice(2).toLowerCase().padStart(64, "0");
    const result = await this.rpc.jsonRpc<string>("eth_call", [
      { to: contractAddress, data },
      "latest",
    ]);
    return BigInt(result || "0x0");
  };

  public getAllTokenBalances = async (address: string) => {
    const apiKey = this.socialscanApiKey;
    if (!apiKey) throw new Error("SOCIALSCAN_API_KEY is required for getAllTokenBalances");
    const explorer = new ExplorerService(
      apiKey,
      this.rpc.chainId === SEISMIC_CHAIN_ID.testnet,
      this.rpc.rpcUrl,
      this.rpc.axiosClient
    );
    return explorer.getTokenBalances(address);
  };

  public validateExplorerApiKey = async (
    apiKey: string
  ): Promise<{
    valid: boolean;
    status: "valid" | "invalid_key" | "service_error";
    error?: string;
  }> => {
    const explorer = new ExplorerService(
      apiKey,
      this.rpc.chainId === SEISMIC_CHAIN_ID.testnet,
      this.rpc.rpcUrl
    );
    return explorer.validateApiKey();
  };

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

  // ── Fees ────────────────────────────────────────────────────────────────────

  private estimateGas = async (
    from: string,
    to: string,
    value?: string,
    data?: string
  ): Promise<bigint> => {
    try {
      const estimateParams = {
        from,
        to,
        ...(value && { value }),
        ...(data && { data }),
      };
      const hexEstimate = await this.rpc.jsonRpc<string>("eth_estimateGas", [estimateParams]);
      const estimated = BigInt(hexEstimate);
      return (estimated * 120n) / 100n;
    } catch {
      return 100_000n;
    }
  };

  public estimateTxFee = async (): Promise<number> => {
    try {
      const hexGasPrice = await this.rpc.jsonRpc<string>("eth_gasPrice", []);
      const gasPriceWei = BigInt(hexGasPrice);
      const gasLimit = await this.estimateGas(
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000"
      ).catch(() => 100_000n);
      const feeWei = gasPriceWei * gasLimit;
      return Number(feeWei) / 10 ** chain_info.coinDecimals;
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "estimating transaction fee");
    }
  };

  // ── Transaction building ─────────────────────────────────────────────────────

  public buildUnsignedTransaction = async (
    sender: string,
    recipient: string,
    amount: number,
    _type: TransactionType = TransactionType.FungibleToken,
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

      const valueWei = parseUnits(String(amount), chain_info.coinDecimals);

      const [hexNonce, hexGasPrice, gasLimit] = await Promise.all([
        this.rpc.jsonRpc<string>("eth_getTransactionCount", [sender, "pending"]),
        this.rpc.jsonRpc<string>("eth_gasPrice", []),
        this.estimateGas(sender, recipient, `0x${valueWei.toString(16)}`).catch(() => 100_000n),
      ]);

      const nonce = parseInt(hexNonce, 16);
      const baseGasPrice = BigInt(hexGasPrice);
      const gasPrice = (baseGasPrice * 120n) / 100n;

      const evmTxFields = {
        from: sender,
        to: recipient,
        value: `0x${valueWei.toString(16)}`,
        data: "0x",
        nonce: `0x${nonce.toString(16)}`,
        gasPrice: `0x${gasPrice.toString(16)}`,
        gas: `0x${gasLimit.toString(16)}`,
      };

      const rlpEncoded = toRlp([
        nonce === 0 ? "0x" : numberToHex(nonce),
        numberToHex(gasPrice),
        numberToHex(gasLimit),
        recipient as Hex,
        numberToHex(valueWei),
        "0x",
        numberToHex(this.rpc.chainId),
        "0x",
        "0x",
      ]);
      const signingHash = keccak256(rlpEncoded);

      return { unsignedTx: evmTxFields, evmTxFields, signingHash };
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "building unsigned transaction");
    }
  };

  public serializeTransaction = async (
    sender: string,
    recipient: string,
    amount: number,
    type: TransactionType = TransactionType.FungibleToken,
    token?: TokenType
  ): Promise<UnsignedTransaction> => {
    try {
      return await this.buildUnsignedTransaction(sender, recipient, amount, type, token);
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "serializing transaction");
    }
  };

  public broadcastTransaction = async (signedTx: unknown): Promise<BroadcastResult> => {
    try {
      if (typeof signedTx !== "string" || !signedTx.startsWith("0x")) {
        throw new Error("signedTx must be a 0x-prefixed hex string");
      }
      const txHash = await this.rpc.jsonRpc<string>("eth_sendRawTransaction", [signedTx]);
      this.logger.info(`Transaction broadcast | txHash:${txHash}`);
      return { txid: txHash };
    } catch (error) {
      this.logger.error(`Broadcast failed: ${error}`);
      return { err: error };
    }
  };
}
