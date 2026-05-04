import { AxiosInstance } from "axios";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256 } from "viem";
import { Logger, ErrorHandler, api_constants, withRetry } from "../../utils/index.js";
import { SdkApiError } from "../../types/index.js";
import { SEISMIC_CHAIN_ID } from "../../utils/constants.js";
import { createHttpClient } from "../../utils/httpClient.js";

type EthLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
};

export { EthLog };

export class RpcService {
  readonly logger: Logger;
  readonly axiosClient: AxiosInstance;
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly errorHandler: ErrorHandler;

  // Seismic testnet: ~120ms block time → ~720k blocks/day.
  static readonly BLOCK_TIME_MS = 120;
  static readonly MAX_HISTORY_MS = 300 * 99_000 * 120;
  static readonly LOG_WINDOW_SIZE = 99_000;
  static readonly MAX_LOG_WINDOWS = 300;
  static readonly MAX_CONSECUTIVE_EMPTY_LOG_WINDOWS = 10;
  static readonly DISCOVERY_WINDOWS = 300;
  static readonly DISCOVERY_BATCH_SIZE = 10;

  constructor(opts: {
    axiosClient?: AxiosInstance;
    rpcUrl?: string;
    chainId?: number;
    testnet?: boolean;
    logger?: Logger;
  }) {
    this.axiosClient = opts.axiosClient ?? createHttpClient();
    const testnet = opts.testnet ?? false;
    this.rpcUrl = opts.rpcUrl ?? (testnet ? api_constants.testnet_rpc : api_constants.mainnet_rpc);
    this.chainId = opts.chainId ?? (testnet ? SEISMIC_CHAIN_ID.testnet : SEISMIC_CHAIN_ID.mainnet);
    this.logger = opts.logger ?? new Logger("services:rpc");
    this.errorHandler = new ErrorHandler("rpc", this.logger);
  }

  async jsonRpc<T>(method: string, params: unknown[]): Promise<T> {
    return withRetry(async () => {
      const response = await this.axiosClient.post(this.rpcUrl, {
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      });
      if (response.data.error) {
        throw new SdkApiError(
          `JSON-RPC error: ${JSON.stringify(response.data.error)}`,
          502,
          "JSON_RPC_ERROR",
          response.data.error,
          "RpcService"
        );
      }
      return response.data.result as T;
    });
  }

  toIsoTimestamp(raw: string | number): string {
    let ms = typeof raw === "string" ? parseInt(raw, 16) : raw;
    // Seismic testnet uses millisecond timestamps; standard EVM uses seconds.
    if (ms < 1e12) ms *= 1000;
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
  }

  async dateToBlock(
    dateStr: string,
    edge: "start" | "end"
  ): Promise<{ blockHex: string; outOfRange: boolean }> {
    const latestHex = await this.jsonRpc<string>("eth_blockNumber", []);
    const latestBlock = parseInt(latestHex, 16);

    const targetMs = new Date(dateStr + (edge === "end" ? "T23:59:59Z" : "T00:00:00Z")).getTime();
    const nowMs = Date.now();
    const diffMs = nowMs - targetMs;

    if (diffMs < 0) return { blockHex: latestHex, outOfRange: false };

    const blocksBack = Math.floor(diffMs / RpcService.BLOCK_TIME_MS);
    const blockNum = Math.max(0, latestBlock - blocksBack);
    const outOfRange = diffMs > RpcService.MAX_HISTORY_MS;

    return { blockHex: `0x${blockNum.toString(16)}`, outOfRange };
  }

  formatAddress(pubKey: string): string {
    try {
      if (!pubKey || typeof pubKey !== "string") {
        throw this.errorHandler.handleApiError(
          new Error("Public key must be a non-empty string"),
          "formatting address"
        );
      }
      const compressed = pubKey.startsWith("0x") ? pubKey.slice(2) : pubKey;
      if (compressed.length !== 66) {
        throw this.errorHandler.handleApiError(
          new Error(
            `Invalid compressed public key length: ${compressed.length} chars (expected 66)`
          ),
          "formatting address"
        );
      }
      const uncompressed = secp256k1.ProjectivePoint.fromHex(compressed).toRawBytes(false);
      const withoutPrefix = uncompressed.slice(1);
      const hash = keccak256(withoutPrefix);
      return ("0x" + hash.slice(-40)).toLowerCase();
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "formatting address");
    }
  }

  async getTransactionByHash(txHash: string): Promise<Record<string, unknown> | null> {
    return this.jsonRpc<Record<string, unknown> | null>("eth_getTransactionByHash", [txHash]);
  }

  async scanLogsUntil(
    needed: number,
    buildFilters: (w: { fromBlock: string; toBlock: string }) => object[],
    dedupeKey: (log: EthLog) => string,
    startFromBlock?: string,
    stopAtBlock?: string
  ): Promise<{ logs: EthLog[]; scannedFrom: string; scannedTo: string }> {
    const latestHex = await this.jsonRpc<string>("eth_blockNumber", []);
    const latest = startFromBlock
      ? Math.min(parseInt(startFromBlock, 16), parseInt(latestHex, 16))
      : parseInt(latestHex, 16);
    const floor = stopAtBlock ? parseInt(stopAtBlock, 16) : 0;

    const seen = new Set<string>();
    const collected: EthLog[] = [];
    let consecutiveEmpty = 0;
    let scannedFrom = `0x${latest.toString(16)}`;
    const scannedTo = `0x${latest.toString(16)}`;

    for (let i = 0; i < RpcService.MAX_LOG_WINDOWS; i++) {
      const hi = latest - i * RpcService.LOG_WINDOW_SIZE;
      if (hi <= 0 || hi < floor) break;
      const lo = Math.max(floor, hi - RpcService.LOG_WINDOW_SIZE + 1);
      const window = {
        fromBlock: `0x${lo.toString(16)}`,
        toBlock: `0x${hi.toString(16)}`,
      };
      scannedFrom = window.fromBlock;

      const results = await Promise.all(
        buildFilters(window).map((f) => this.jsonRpc<EthLog[]>("eth_getLogs", [f]))
      );

      let newInWindow = 0;
      for (const log of results.flat()) {
        const key = dedupeKey(log);
        if (!seen.has(key)) {
          seen.add(key);
          collected.push(log);
          newInWindow++;
        }
      }

      if (newInWindow === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= RpcService.MAX_CONSECUTIVE_EMPTY_LOG_WINDOWS) break;
      } else {
        consecutiveEmpty = 0;
      }

      if (collected.length >= needed) break;
    }

    return { logs: collected, scannedFrom, scannedTo };
  }
}
