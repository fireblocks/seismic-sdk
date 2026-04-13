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
  from: string;
  to: string;
  value: string; // wei as decimal string
  timeStamp: string; // unix timestamp as decimal string
  isError?: string; // "0" = success, "1" = failed (txlist only)
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
  contractAddress?: string;
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
  private readonly logger = new Logger("services:explorer");

  constructor(apiKey: string, testnet = true) {
    this.apiKey = apiKey;
    this.baseUrl = testnet ? SOCIALSCAN_API_URL.testnet : SOCIALSCAN_API_URL.mainnet;
    if (!this.baseUrl) {
      throw new Error("ExplorerService: mainnet SocialScan URL is not yet available");
    }
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private async get<T>(params: Record<string, string>): Promise<T[]> {
    const url = new URL(this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("apikey", this.apiKey);

    const response = await axiosInstance.get<ExplorerApiResponse<T>>(url.toString());
    const { status, message, result } = response.data;

    // status "0" with "No transactions found" is a valid empty response
    if (status === "0") {
      if (message === "No transactions found" || message === "No records found") return [];
      throw new Error(`Explorer API error: ${message}`);
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

    const pageSize = String(limit + offset); // fetch enough to satisfy offset
    const params = {
      module: "account",
      address,
      startblock: "0",
      endblock: "99999999",
      page: "1",
      offset: pageSize,
      sort: "desc",
    };

    const [normal, internal] = await Promise.all([
      this.get<ExplorerTx>({ ...params, action: "txlist" }),
      this.get<ExplorerTx>({ ...params, action: "txlistinternal" }),
    ]);

    // Deduplicate by hash (internal txs from the same tx appear twice)
    const seen = new Set<string>();
    const all = [...normal, ...internal].filter((tx) => {
      if (seen.has(tx.hash)) return false;
      seen.add(tx.hash);
      return true;
    });

    all.sort((a, b) => parseInt(b.timeStamp) - parseInt(a.timeStamp));
    const sliced = all.slice(offset, offset + limit);

    return sliced.map((tx) => ({
      type: TransactionType.Native,
      sender: tx.from,
      recipient: tx.to,
      amount: Number(BigInt(tx.value)) / 1e18,
      transaction_hash: tx.hash,
      timestamp: parseInt(tx.timeStamp),
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

    const params: Record<string, string> = {
      module: "account",
      action: "tokentx",
      address,
      startblock: "0",
      endblock: "99999999",
      page: "1",
      offset: String(limit + offset),
      sort: "desc",
    };
    if (contractAddress) params.contractaddress = contractAddress;

    const txs = await this.get<ExplorerTx>(params);
    const sliced = txs.slice(offset, offset + limit);

    return sliced.map((tx) => {
      const decimals = tx.tokenDecimal ? parseInt(tx.tokenDecimal) : DEFAULT_TOKEN_DECIMALS;
      return {
        type: TransactionType.FungibleToken,
        tokenInfo: {
          tokenID: tx.contractAddress ?? "",
          tokenName: tx.tokenSymbol ?? tx.tokenName ?? tx.contractAddress ?? "",
          decimals,
        },
        sender: tx.from,
        recipient: tx.to,
        amount: Number(BigInt(tx.value)) / 10 ** decimals,
        transaction_hash: tx.hash,
        timestamp: parseInt(tx.timeStamp),
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
    const pageSize = String(limit + offset);

    // Query sent and received in parallel
    const [sentLogs, receivedLogs] = await Promise.all([
      this.get<ExplorerLog>({
        module: "logs",
        action: "getLogs",
        address: contractAddress,
        topic0: SRC20_TRANSFER_TOPIC,
        topic0_1_opr: "and",
        topic1: paddedAddress,
        fromBlock: "0",
        toBlock: "99999999",
        page: "1",
        offset: pageSize,
      }),
      this.get<ExplorerLog>({
        module: "logs",
        action: "getLogs",
        address: contractAddress,
        topic0: SRC20_TRANSFER_TOPIC,
        topic0_2_opr: "and",
        topic2: paddedAddress,
        fromBlock: "0",
        toBlock: "99999999",
        page: "1",
        offset: pageSize,
      }),
    ]);

    // Deduplicate by txHash (self-transfers appear in both)
    const seen = new Set<string>();
    const allLogs = [...sentLogs, ...receivedLogs].filter((log) => {
      if (seen.has(log.transactionHash)) return false;
      seen.add(log.transactionHash);
      return true;
    });

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
      timestamp: parseInt(log.timeStamp, 16),
      success: true,
    }));
  };
}
