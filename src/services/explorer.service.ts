import axiosInstance from "../utils/httpClient.js";
import { Transaction, TransactionType } from "../types/index.js";
import {
  DEFAULT_TOKEN_DECIMALS,
  SRC20_TRANSFER_TOPIC,
  SOCIALSCAN_API_URL,
  Logger,
} from "../utils/index.js";

// ─── SocialScan response shapes ─────────────────────────────────────────────

type ExplorerTx = {
  hash: string;
  // txlist uses fromAddress/toAddress; tokentx uses from/to
  from?: string;
  to?: string;
  fromAddress?: string;
  toAddress?: string;
  value: string; // wei as decimal string
  timeStamp: string; // unix timestamp as decimal string
  isError?: string; // "0" = success, "1" = failed (txlist only)
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
  contractAddress?: string;
};

type ExplorerTokenBalance = {
  TokenAddress: string;
  TokenName: string;
  TokenType: string;
  TokenSymbol: string;
  TokenQuantity: string; // raw amount (no decimal applied)
  TokenDecimals: string;
  TokenID: string | null;
};

type ExplorerLog = {
  transactionHash: string;
  address: string; // emitting contract
  topics: string[];
  data: string; // ABI-encoded non-indexed params
  timeStamp: string; // hex timestamp
  blockNumber: string;
};

type ExplorerApiResponse<T> = {
  status: "0" | "1";
  message: string;
  result: T[] | string; // string on error
};

/**
 * SRC-20 Transaction extends the standard Transaction with an `encryptedAmount`
 * field - the AES-GCM ciphertext from the Transfer event data.
 * The amount field is 0 until the caller decrypts it using the vault's encryptionSk.
 */
export type Src20Transaction = Transaction & {
  encryptedAmount: string;
};

/**
 * Client for the SocialScan Explorer API on Seismic Testnet.
 *
 * Provides transaction history for all three asset types that the Seismic RPC
 * cannot surface on its own:
 * - Native ETH  → `txlist` + `txlistinternal` (no logs emitted by the EVM)
 * - ERC-20      → `tokentx` (standard Transfer indexing)
 * - SRC-20      → `getLogs` filtered by the SRC-20 Transfer topic
 *
 * Requires `SOCIALSCAN_API_KEY` environment variable.
 * Get a key at https://developer.socialscan.io
 *
 * @example
 * const explorer = new ExplorerService(process.env.SOCIALSCAN_API_KEY!);
 * const txs = await explorer.getNativeTransactions("0x...");
 */
export class ExplorerService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly rpcUrl: string;
  private readonly logger = new Logger("services:explorer");

  constructor(apiKey: string, testnet = true, rpcUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = testnet ? SOCIALSCAN_API_URL.testnet : SOCIALSCAN_API_URL.mainnet;
    this.rpcUrl = rpcUrl;
    if (!this.baseUrl) {
      throw new Error("ExplorerService: mainnet SocialScan URL is not yet available");
    }
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  // Seismic testnet: ~120ms block time → ~720k blocks/day.
  // SocialScan caps each query at 100k blocks (~3.3 hours of history).
  // We scan windows backwards from latest, stopping as soon as we have enough results
  // OR after MAX_CONSECUTIVE_EMPTY consecutive empty windows (address has no more history).
  private static readonly WINDOW_SIZE = 99_000;
  private static readonly MAX_WINDOWS = 300; // hard cap: ~41 days back
  private static readonly MAX_CONSECUTIVE_EMPTY = 10; // stop after 10 dry windows (~33h gap)

  /**
   * Fetches the latest block number from the Seismic RPC.
   * SocialScan has no proxy module, so we go directly to the node.
   */
  private async getLatestBlock(): Promise<number> {
    const response = await axiosInstance.post<{ result: string }>(this.rpcUrl, {
      jsonrpc: "2.0",
      method: "eth_blockNumber",
      params: [],
      id: 1,
    });
    return parseInt(response.data.result, 16);
  }

  /**
   * Scans 99k-block windows backwards from latest, accumulating results until
   * `needed` items are collected or MAX_WINDOWS is exhausted.
   *
   * Each window issues the queries returned by buildParams in parallel.
   * Windows are processed sequentially (newest first) so we stop early as soon
   * as we have enough - typically 1-3 windows for the first page.
   */
  private async scanWindowsUntil<T>(
    needed: number,
    buildParams: (w: { startblock: string; endblock: string }) => Record<string, string>[],
    dedupeKey: (item: T) => string,
    countFilter?: (item: T) => boolean
  ): Promise<T[]> {
    const latest = await this.getLatestBlock();
    const seen = new Set<string>();
    const collected: T[] = [];
    let consecutiveEmpty = 0;

    for (let i = 0; i < ExplorerService.MAX_WINDOWS; i++) {
      const hi = latest - i * ExplorerService.WINDOW_SIZE;
      if (hi <= 0) break;
      const lo = Math.max(0, hi - ExplorerService.WINDOW_SIZE + 1);

      const window = { startblock: String(lo), endblock: String(hi) };
      const results = await Promise.all(buildParams(window).map((p) => this.get<T>(p)));

      let newInWindow = 0;
      for (const item of results.flat()) {
        const key = dedupeKey(item);
        if (!seen.has(key)) {
          seen.add(key);
          collected.push(item);
          if (!countFilter || countFilter(item)) newInWindow++;
        }
      }

      if (newInWindow === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= ExplorerService.MAX_CONSECUTIVE_EMPTY) break;
      } else {
        consecutiveEmpty = 0;
      }

      const countedSoFar = countFilter ? collected.filter(countFilter).length : collected.length;
      if (countedSoFar >= needed) break;
    }

    return collected.filter((item) => !countFilter || countFilter(item));
  }

  private async get<T>(params: Record<string, string>): Promise<T[]> {
    const url = new URL(this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("apikey", this.apiKey);

    const response = await axiosInstance.get<ExplorerApiResponse<T>>(url.toString());
    const { status, message, result } = response.data;

    // status "0" with "No transactions found" is a valid empty response
    if (status === "0") {
      if (message === "No transactions found" || message === "No records found") return [];
      const detail = Array.isArray((result as unknown as { errors?: { msg: string }[] })?.errors)
        ? (result as unknown as { errors: { msg: string }[] }).errors.map((e) => e.msg).join("; ")
        : message;
      throw new Error(`Explorer API error: ${detail}`);
    }

    return Array.isArray(result) ? result : [];
  }

  // ─── Public methods ──────────────────────────────────────────────────────

  /**
   * Fetches native ETH transaction history for an address.
   * Queries both normal txs (`txlist`) and internal txs (`txlistinternal`) in parallel.
   *
   * @param address - Vault's Seismic/ETH address
   * @param limit   - Max results to return (default 50)
   * @param offset  - Results to skip for pagination (default 0)
   */
  public getNativeTransactions = async (
    address: string,
    limit = 50,
    offset = 0
  ): Promise<Transaction[]> => {
    this.logger.debug(`Fetching native tx history | address:${address}`);

    const all = await this.scanWindowsUntil<ExplorerTx>(
      offset + limit,
      ({ startblock, endblock }) => [
        {
          module: "account",
          action: "txlist",
          address,
          startblock,
          endblock,
          page: "1",
          offset: "100",
          sort: "desc",
        },
        {
          module: "account",
          action: "txlistinternal",
          address,
          startblock,
          endblock,
          page: "1",
          offset: "100",
          sort: "desc",
        },
      ],
      (tx) => tx.hash,
      // Only count transactions where ETH actually moved (value > 0).
      // txlist returns all txs including shielded contract calls with value=0.
      (tx) => BigInt(tx.value) > 0n
    );

    all.sort((a, b) => parseInt(b.timeStamp) - parseInt(a.timeStamp));
    const sliced = all.slice(offset, offset + limit);

    return sliced.map((tx) => ({
      type: TransactionType.Native,
      sender: tx.fromAddress ?? tx.from ?? "",
      recipient: tx.toAddress ?? tx.to ?? "",
      amount: Number(BigInt(tx.value)) / 1e18,
      transaction_hash: tx.hash,
      timestamp: new Date(parseInt(tx.timeStamp) * 1000)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, " UTC"),
      success: tx.isError === "0" || tx.isError === undefined,
    }));
  };

  /**
   * Fetches ERC-20 token transfer history for an address.
   * Uses the explorer's `tokentx` action which decodes standard Transfer events.
   *
   * @param address         - Vault's Seismic/ETH address
   * @param contractAddress - Optional filter by contract address
   * @param limit           - Max results to return (default 50)
   * @param offset          - Results to skip for pagination (default 0)
   */
  public getErc20Transactions = async (
    address: string,
    contractAddress?: string,
    limit = 50,
    offset = 0
  ): Promise<Transaction[]> => {
    this.logger.debug(`Fetching ERC-20 tx history | address:${address}`);

    const all = await this.scanWindowsUntil<ExplorerTx>(
      offset + limit,
      ({ startblock, endblock }) => {
        const p: Record<string, string> = {
          module: "account",
          action: "tokentx",
          address,
          startblock,
          endblock,
          page: "1",
          offset: "100",
          sort: "desc",
        };
        if (contractAddress) p.contractaddress = contractAddress;
        return [p];
      },
      (tx) => tx.hash
    );

    all.sort((a, b) => parseInt(b.timeStamp) - parseInt(a.timeStamp));
    const sliced = all.slice(offset, offset + limit);

    return sliced.map((tx) => {
      const decimals = tx.tokenDecimal ? parseInt(tx.tokenDecimal) : DEFAULT_TOKEN_DECIMALS;
      return {
        type: TransactionType.FungibleToken,
        tokenInfo: {
          tokenID: tx.contractAddress ?? "",
          tokenName: tx.tokenSymbol ?? tx.tokenName ?? tx.contractAddress ?? "",
          decimals,
        },
        sender: tx.fromAddress ?? tx.from ?? "",
        recipient: tx.toAddress ?? tx.to ?? "",
        amount: Number(BigInt(tx.value)) / 10 ** decimals,
        transaction_hash: tx.hash,
        timestamp: new Date(parseInt(tx.timeStamp) * 1000)
          .toISOString()
          .replace("T", " ")
          .replace(/\.\d{3}Z$/, " UTC"),
        success: tx.isError !== "1",
      };
    });
  };

  /**
   * Fetches SRC-20 Transfer event history for an address.
   *
   * SRC-20's Transfer event has a different ABI than ERC-20 -
   * `Transfer(address indexed from, address indexed to, bytes32 indexed encryptKeyHash, bytes encryptedAmount)`
   * - so `tokentx` will NOT return SRC-20 transfers. This method queries `getLogs`
   * filtered by the SRC-20 Transfer topic instead.
   *
   * The `encryptedAmount` field in the returned objects contains the raw AES-GCM
   * ciphertext from the event's `data` field. The `amount` field is always 0 until
   * decrypted client-side using the vault's `encryptionSk`.
   *
   * @param address         - Vault's Seismic/ETH address
   * @param contractAddress - SRC-20 contract address (required for topic-filtered getLogs)
   * @param limit           - Max results to return (default 50)
   * @param offset          - Results to skip for pagination (default 0)
   */
  public getSrc20Transactions = async (
    address: string,
    contractAddress: string,
    limit = 50,
    offset = 0
  ): Promise<Src20Transaction[]> => {
    this.logger.debug(
      `Fetching SRC-20 tx history | address:${address} | contract:${contractAddress}`
    );

    const paddedAddress = "0x" + address.slice(2).toLowerCase().padStart(64, "0");

    const allLogs = await this.scanWindowsUntil<ExplorerLog>(
      offset + limit,
      ({ startblock, endblock }) => [
        {
          module: "logs",
          action: "getLogs",
          address: contractAddress,
          topic0: SRC20_TRANSFER_TOPIC,
          topic0_1_opr: "and",
          topic1: paddedAddress,
          fromBlock: startblock,
          toBlock: endblock,
          page: "1",
          offset: "100",
        } as Record<string, string>,
        {
          module: "logs",
          action: "getLogs",
          address: contractAddress,
          topic0: SRC20_TRANSFER_TOPIC,
          topic0_2_opr: "and",
          topic2: paddedAddress,
          fromBlock: startblock,
          toBlock: endblock,
          page: "1",
          offset: "100",
        } as Record<string, string>,
      ],
      (log) => log.transactionHash
    );

    allLogs.sort((a, b) => parseInt(b.timeStamp, 16) - parseInt(a.timeStamp, 16));
    const sliced = allLogs.slice(offset, offset + limit);

    return sliced.map((log) => ({
      type: TransactionType.FungibleToken,
      tokenInfo: { tokenID: contractAddress, tokenName: "SRC20", decimals: 18 },
      sender: "0x" + (log.topics[1]?.slice(-40) ?? ""),
      recipient: "0x" + (log.topics[2]?.slice(-40) ?? ""),
      // Amount is encrypted - cannot be decoded without the vault's encryptionSk.
      amount: 0,
      encryptedAmount: log.data,
      transaction_hash: log.transactionHash,
      timestamp: new Date(parseInt(log.timeStamp, 16) * 1000)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, " UTC"),
      success: true,
    }));
  };

  /**
   * Discovers SRC-20 contract addresses an address has interacted with, using SocialScan getLogs.
   *
   * Scans backwards in 99k-block windows. Used as fallback when the RPC node's eth_getLogs
   * returns "failed to decode a key from a table" for the SRC-20 Transfer topic.
   *
   * @param address - Vault's Seismic/ETH address
   */
  public discoverSrc20Contracts = async (address: string): Promise<string[]> => {
    this.logger.debug(`Discovering SRC-20 contracts via SocialScan | address:${address}`);
    const paddedAddress = "0x" + address.slice(2).toLowerCase().padStart(64, "0");
    const latest = await this.getLatestBlock();
    const contracts = new Set<string>();

    for (let i = 0; i < ExplorerService.MAX_WINDOWS; i++) {
      const hi = latest - i * ExplorerService.WINDOW_SIZE;
      if (hi <= 0) break;
      const lo = Math.max(0, hi - ExplorerService.WINDOW_SIZE + 1);
      const window = { startblock: String(lo), endblock: String(hi) };

      try {
        const [sent, received] = await Promise.all([
          this.get<ExplorerLog>({
            module: "logs",
            action: "getLogs",
            topic0: SRC20_TRANSFER_TOPIC,
            topic0_1_opr: "and",
            topic1: paddedAddress,
            fromBlock: window.startblock,
            toBlock: window.endblock,
            page: "1",
            offset: "100",
          }),
          this.get<ExplorerLog>({
            module: "logs",
            action: "getLogs",
            topic0: SRC20_TRANSFER_TOPIC,
            topic0_2_opr: "and",
            topic2: paddedAddress,
            fromBlock: window.startblock,
            toBlock: window.endblock,
            page: "1",
            offset: "100",
          }),
        ]);

        for (const log of [...sent, ...received]) {
          contracts.add(log.address.toLowerCase());
        }
      } catch (err) {
        this.logger.warn(
          `discoverSrc20Contracts (SocialScan): skipping window [${lo}-${hi}]: ${err}`
        );
      }
    }

    return [...contracts];
  };

  /**
   * Returns all ERC-20 token balances held by an address - no contract list needed.
   * Uses SocialScan `addresstokenbalance` which aggregates all Transfer events for the address.
   *
   * @param address - Vault's Seismic/ETH address
   */
  public getTokenBalances = async (
    address: string
  ): Promise<
    {
      contractAddress: string;
      name: string;
      symbol: string;
      decimals: number;
      balance: number;
      rawBalance: string;
    }[]
  > => {
    this.logger.debug(`Fetching all token balances | address:${address}`);

    const params: Record<string, string> = {
      module: "account",
      action: "addresstokenbalance",
      address,
    };

    const results = await this.get<ExplorerTokenBalance>(params);

    return results
      .filter((t) => t.TokenType === "ERC20")
      .map((t) => {
        const decimals = parseInt(t.TokenDecimals) || DEFAULT_TOKEN_DECIMALS;
        return {
          contractAddress: t.TokenAddress,
          name: t.TokenName,
          symbol: t.TokenSymbol,
          decimals,
          balance: Number(BigInt(t.TokenQuantity)) / 10 ** decimals,
          rawBalance: t.TokenQuantity,
        };
      });
  };
}
