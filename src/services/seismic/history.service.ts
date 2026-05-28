import { type Hex, formatUnits } from "viem";
import { computeKeyHash, AesGcmCrypto } from "seismic-viem";
import {
  Logger,
  validateAddress,
  DEFAULT_TOKEN_DECIMALS,
  ERC20_TRANSFER_TOPIC,
  SRC20_TRANSFER_TOPIC,
  SEISMIC_CHAIN_ID,
  SUSDC_CONTRACT_ADDRESS,
} from "../../utils/index.js";
import {
  GetTransactionHistoryFromIndexerOpts,
  Transaction,
  TransactionType,
} from "../../types/index.js";
import { ExplorerService } from "../explorer.service.js";
import { RpcService, EthLog } from "./rpc.service.js";
import { SeismicShieldedService } from "./shielded.service.js";

export class TransactionHistoryService {
  private readonly logger: Logger;

  constructor(
    private readonly rpc: RpcService,
    private readonly shielded: SeismicShieldedService,
    private readonly socialscanApiKey?: string,
    logger?: Logger
  ) {
    this.logger = logger ?? new Logger("services:history");
  }

  async getTransactionHistory(params: GetTransactionHistoryFromIndexerOpts): Promise<{
    transactions: Transaction[];
    fromBlock: string;
    toBlock: string;
    source: string;
    total: number;
    warning?: string;
  }> {
    const {
      address,
      contracts,
      limit = 50,
      offset = 0,
      type = "erc20",
      encryptionSk,
      viewingKey,
      before,
      after,
    } = params;

    if (!validateAddress(address)) {
      throw this.rpc.errorHandler.handleApiError(
        new Error("Invalid address provided"),
        "fetching transaction history"
      );
    }

    let fromBlock = params.fromBlock;
    let toBlock = params.toBlock;
    let dateOutOfRangeWarning: string | undefined;

    if (before || after) {
      const [beforeResult, afterResult] = await Promise.all([
        before ? this.rpc.dateToBlock(before, "end") : Promise.resolve(null),
        after ? this.rpc.dateToBlock(after, "start") : Promise.resolve(null),
      ]);
      if (beforeResult) {
        toBlock = beforeResult.blockHex;
        if (beforeResult.outOfRange)
          dateOutOfRangeWarning = `'before' date (${before}) is older than ~41 days - results may be incomplete`;
      }
      if (afterResult) {
        fromBlock = afterResult.blockHex;
        if (afterResult.outOfRange)
          dateOutOfRangeWarning = `'after' date (${after}) is older than ~41 days - results may be incomplete`;
      }
    }

    const apiKey = this.socialscanApiKey;
    const useExplorer = !!apiKey;

    if (useExplorer) {
      const explorer = new ExplorerService(
        apiKey!,
        this.rpc.chainId === SEISMIC_CHAIN_ID.testnet,
        this.rpc.rpcUrl,
        this.rpc.axiosClient
      );

      if (type === "susdc") {
        // sUSDC is a standard ERC-20 - route through tokentx filtered to the sUSDC contract.
        const transactions = await explorer.getErc20Transactions(
          address,
          SUSDC_CONTRACT_ADDRESS,
          limit,
          offset,
          fromBlock,
          toBlock
        );
        return {
          transactions,
          fromBlock: fromBlock ?? "0",
          toBlock: toBlock ?? "latest",
          source: "socialscan-tokentx-susdc",
          total: transactions.length,
          warning: dateOutOfRangeWarning,
        };
      }

      if (type === "all") {
        // "all" = sUSDC (ERC-20 filtered) + other ERC-20 + SRC-20. Native SIZE not exposed.
        const src20Params = {
          address,
          type: "src20" as const,
          contracts,
          limit,
          offset,
          encryptionSk,
          viewingKey,
          before,
          after,
        };
        const [sUSDC, erc20, src20Result] = await Promise.allSettled([
          explorer.getErc20Transactions(
            address,
            SUSDC_CONTRACT_ADDRESS,
            limit,
            offset,
            fromBlock,
            toBlock
          ),
          explorer.getErc20Transactions(address, contracts?.[0], limit, offset, fromBlock, toBlock),
          this.getTransactionHistory(src20Params),
        ]);
        const sUSDCTxs = sUSDC.status === "fulfilled" ? sUSDC.value : [];
        const erc20Txs = erc20.status === "fulfilled" ? erc20.value : [];
        const src20Txs = src20Result.status === "fulfilled" ? src20Result.value.transactions : [];
        // Deduplicate: sUSDC txs may overlap with general ERC-20 query if no contract filter
        const seen = new Set<string>();
        const deduped = [...sUSDCTxs, ...erc20Txs, ...src20Txs].filter((tx) => {
          if (seen.has(tx.transaction_hash)) return false;
          seen.add(tx.transaction_hash);
          return true;
        });
        const merged = deduped.sort((a, b) =>
          (b.timestamp ?? "").localeCompare(a.timestamp ?? "")
        );
        const allPage = merged.slice(0, limit);
        return {
          transactions: allPage,
          fromBlock: fromBlock ?? "0",
          toBlock: toBlock ?? "latest",
          source: "socialscan-tokentx+eth_getLogs",
          total: merged.length,
          warning: dateOutOfRangeWarning,
        };
      }

      if (type !== "src20")
        try {
          const transactions = await explorer.getErc20Transactions(
            address,
            contracts?.[0],
            limit,
            offset,
            fromBlock,
            toBlock
          );
          return {
            transactions,
            fromBlock: fromBlock ?? "0",
            toBlock: toBlock ?? "latest",
            source: "socialscan-tokentx",
            total: transactions.length,
            warning: dateOutOfRangeWarning,
          };
        } catch (explorerErr) {
          this.logger.warn(
            `SocialScan unavailable (${(explorerErr as Error).message}), falling back to eth_getLogs`
          );
        }
    }

    if (type === "susdc") {
      throw this.rpc.errorHandler.handleApiError(
        new Error(
          "sUSDC transaction history requires the SocialScan Explorer API (no RPC fallback). " +
            "Set SOCIALSCAN_API_KEY in your environment (get a key at developer.socialscan.io)."
        ),
        "fetching transaction history"
      );
    }

    const isSrc20 = type === "src20";
    const paddedAddress = "0x" + address.slice(2).toLowerCase().padStart(64, "0");
    const transferTopic = isSrc20 ? SRC20_TRANSFER_TOPIC : ERC20_TRANSFER_TOPIC;
    const hexRangePinned = !!(params.fromBlock && params.toBlock) && !(before || after);
    const callerPinnedRange = hexRangePinned;

    if (isSrc20 && viewingKey) {
      const keyHash = computeKeyHash(viewingKey);
      const addressFilter = contracts?.length ? { address: contracts } : {};

      let allLogs: EthLog[];
      let vkFromBlock: string;
      let vkToBlock: string;

      if (callerPinnedRange) {
        vkFromBlock = fromBlock ?? params.fromBlock!;
        vkToBlock = toBlock ?? params.toBlock!;
        const [sentLogs, receivedLogs] = await Promise.all([
          this.rpc.jsonRpc<EthLog[]>("eth_getLogs", [
            {
              ...addressFilter,
              fromBlock: vkFromBlock,
              toBlock: vkToBlock,
              topics: [transferTopic, paddedAddress],
            },
          ]),
          this.rpc.jsonRpc<EthLog[]>("eth_getLogs", [
            {
              ...addressFilter,
              fromBlock: vkFromBlock,
              toBlock: vkToBlock,
              topics: [transferTopic, null, paddedAddress, keyHash],
            },
          ]),
        ]);
        const seen = new Set<string>();
        allLogs = [...receivedLogs, ...sentLogs].filter((log) => {
          const key = `${log.transactionHash}-${log.logIndex}`;
          return seen.has(key) ? false : (seen.add(key), true);
        });
      } else {
        const { logs, scannedFrom, scannedTo } = await this.rpc.scanLogsUntil(
          offset + limit,
          ({ fromBlock: fb, toBlock: tb }) => [
            {
              ...addressFilter,
              fromBlock: fb,
              toBlock: tb,
              topics: [transferTopic, paddedAddress],
            },
            {
              ...addressFilter,
              fromBlock: fb,
              toBlock: tb,
              topics: [transferTopic, null, paddedAddress, keyHash],
            },
          ],
          (log) => `${log.transactionHash}-${log.logIndex}`,
          toBlock,
          fromBlock
        );
        allLogs = logs;
        vkFromBlock = scannedFrom;
        vkToBlock = scannedTo;
      }

      allLogs.sort((a, b) => parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16));
      const sliced = allLogs.slice(offset, offset + limit);

      const uniqueBlocks = [...new Set(sliced.map((l) => l.blockNumber))];
      const uniqueContracts = [...new Set(sliced.map((l) => l.address))];
      const blockTimestamps = new Map<string, string>();
      const tokenDecimals = new Map<string, number>();
      const tokenSymbols = new Map<string, string>();

      await Promise.all([
        ...uniqueBlocks.map(async (blockNum) => {
          const block = await this.rpc.jsonRpc<{ timestamp: string } | null>(
            "eth_getBlockByNumber",
            [blockNum, false]
          );
          if (block) blockTimestamps.set(blockNum, this.rpc.toIsoTimestamp(block.timestamp));
        }),
        ...uniqueContracts.map(async (contractAddr) => {
          const info = await this._getErc20Info(contractAddr);
          tokenDecimals.set(contractAddr, info.decimals ?? DEFAULT_TOKEN_DECIMALS);
          tokenSymbols.set(contractAddr, info.symbol ?? contractAddr);
        }),
      ]);

      const receivedSet = new Set(
        allLogs
          .filter((l) => l.topics[2]?.slice(-40).toLowerCase() === address.slice(2).toLowerCase())
          .map((l) => `${l.transactionHash}-${l.logIndex}`)
      );

      const transactions = await Promise.all(
        sliced.map(async (log) => {
          const decimals = tokenDecimals.get(log.address) ?? DEFAULT_TOKEN_DECIMALS;
          const symbol = tokenSymbols.get(log.address) ?? log.address;
          const logKey = `${log.transactionHash}-${log.logIndex}`;
          let amount = "0";

          if (receivedSet.has(logKey)) {
            const dataHex = (log.data as string).slice(2);
            const byteLength = parseInt(dataHex.slice(64, 128), 16);
            const encryptedData = "0x" + dataHex.slice(128, 128 + byteLength * 2);
            const nonce = ("0x" + encryptedData.slice(-24)) as Hex;
            const encryptedPart = encryptedData.slice(0, encryptedData.length - 24) as Hex;
            try {
              const plaintext = await new AesGcmCrypto(viewingKey).decrypt(encryptedPart, nonce);
              const rawAmount = BigInt(plaintext);
              amount = formatUnits(rawAmount, decimals);
            } catch {
              // encryptedAmount was empty or used a different key
            }
          } else if (encryptionSk) {
            const decrypted = await this.shielded.decryptSrc20Amount(
              log.transactionHash,
              encryptionSk,
              decimals
            );
            if (decrypted !== null) amount = decrypted;
          }

          return {
            type: TransactionType.FungibleToken,
            tokenInfo: { tokenID: log.address, tokenName: symbol, decimals },
            sender: "0x" + log.topics[1].slice(-40),
            recipient: "0x" + log.topics[2].slice(-40),
            amount,
            encryptedAmount: log.data,
            transaction_hash: log.transactionHash,
            timestamp: blockTimestamps.get(log.blockNumber),
            success: true,
          };
        })
      );

      return {
        transactions,
        fromBlock: vkFromBlock,
        toBlock: vkToBlock,
        source: "eth_getLogs-viewing-key",
        total: allLogs.length,
        warning: dateOutOfRangeWarning,
      };
    }

    const addressFilter = contracts?.length ? { address: contracts } : {};
    let allLogs: EthLog[];

    if (callerPinnedRange) {
      fromBlock = fromBlock ?? params.fromBlock!;
      toBlock = toBlock ?? params.toBlock!;
      const [sentLogs, receivedLogs] = await Promise.all([
        this.rpc.jsonRpc<EthLog[]>("eth_getLogs", [
          { ...addressFilter, fromBlock, toBlock, topics: [transferTopic, paddedAddress, null] },
        ]),
        this.rpc.jsonRpc<EthLog[]>("eth_getLogs", [
          { ...addressFilter, fromBlock, toBlock, topics: [transferTopic, null, paddedAddress] },
        ]),
      ]);
      const seen = new Set<string>();
      allLogs = [...sentLogs, ...receivedLogs].filter((log) => {
        const key = `${log.transactionHash}-${log.logIndex}`;
        return seen.has(key) ? false : (seen.add(key), true);
      });
    } else {
      const { logs, scannedFrom, scannedTo } = await this.rpc.scanLogsUntil(
        offset + limit,
        ({ fromBlock: fb, toBlock: tb }) => [
          {
            ...addressFilter,
            fromBlock: fb,
            toBlock: tb,
            topics: [transferTopic, paddedAddress, null],
          },
          {
            ...addressFilter,
            fromBlock: fb,
            toBlock: tb,
            topics: [transferTopic, null, paddedAddress],
          },
        ],
        (log) => `${log.transactionHash}-${log.logIndex}`,
        toBlock,
        fromBlock
      );
      allLogs = logs;
      fromBlock = scannedFrom;
      toBlock = scannedTo;
    }

    allLogs.sort((a, b) => parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16));
    const sliced =
      limit !== undefined ? allLogs.slice(offset, offset + limit) : allLogs.slice(offset);

    const uniqueBlocks = [...new Set(sliced.map((l) => l.blockNumber))];
    const uniqueContracts = [...new Set(sliced.map((l) => l.address))];
    const blockTimestamps = new Map<string, string>();
    const tokenDecimals = new Map<string, number>();
    const tokenSymbols = new Map<string, string>();

    await Promise.all([
      ...uniqueBlocks.map(async (blockNum) => {
        const block = await this.rpc.jsonRpc<{ timestamp: string } | null>("eth_getBlockByNumber", [
          blockNum,
          false,
        ]);
        if (block) blockTimestamps.set(blockNum, this.rpc.toIsoTimestamp(block.timestamp));
      }),
      ...uniqueContracts.map(async (contractAddr) => {
        const info = await this._getErc20Info(contractAddr);
        tokenDecimals.set(contractAddr, info.decimals ?? DEFAULT_TOKEN_DECIMALS);
        tokenSymbols.set(contractAddr, info.symbol ?? contractAddr);
      }),
    ]);

    const transactions = await Promise.all(
      sliced.map(async (log) => {
        const decimals = tokenDecimals.get(log.address) ?? DEFAULT_TOKEN_DECIMALS;
        const symbol = tokenSymbols.get(log.address) ?? log.address;
        let amount = "0";
        if (isSrc20 && encryptionSk) {
          const decrypted = await this.shielded.decryptSrc20Amount(
            log.transactionHash,
            encryptionSk,
            decimals
          );
          if (decrypted !== null) amount = decrypted;
        } else if (!isSrc20) {
          const rawAmount = BigInt(log.data || "0x0");
          amount = formatUnits(rawAmount, decimals);
        }

        return {
          type: TransactionType.FungibleToken,
          tokenInfo: { tokenID: log.address, tokenName: symbol, decimals },
          sender: "0x" + log.topics[1].slice(-40),
          recipient: "0x" + log.topics[2].slice(-40),
          amount,
          ...(isSrc20 ? { encryptedAmount: log.data } : {}),
          transaction_hash: log.transactionHash,
          timestamp: blockTimestamps.get(log.blockNumber),
          success: true,
        };
      })
    );

    return {
      transactions,
      fromBlock,
      toBlock,
      source: "eth_getLogs",
      total: allLogs.length,
      warning: dateOutOfRangeWarning,
    };
  }

  async discoverSrc20Contracts(address: string): Promise<string[]> {
    const paddedAddress = "0x" + address.slice(2).toLowerCase().padStart(64, "0");
    const latestHex = await this.rpc.jsonRpc<string>("eth_blockNumber", []);
    const latest = parseInt(latestHex, 16);
    const contracts = new Set<string>();
    const seen = new Set<string>();
    let rpcErrorCount = 0;

    const windowCount = Math.min(
      RpcService.DISCOVERY_WINDOWS,
      Math.ceil(latest / RpcService.LOG_WINDOW_SIZE)
    );
    const indices = Array.from({ length: windowCount }, (_, i) => i);

    for (let b = 0; b < indices.length; b += RpcService.DISCOVERY_BATCH_SIZE) {
      const batch = indices.slice(b, b + RpcService.DISCOVERY_BATCH_SIZE);
      const batchLogs = await Promise.all(
        batch.map(async (i) => {
          const hi = latest - i * RpcService.LOG_WINDOW_SIZE;
          if (hi <= 0) return [];
          const lo = Math.max(0, hi - RpcService.LOG_WINDOW_SIZE + 1);
          const window = { fromBlock: `0x${lo.toString(16)}`, toBlock: `0x${hi.toString(16)}` };
          try {
            const [sent, received] = await Promise.all([
              this.rpc.jsonRpc<EthLog[]>("eth_getLogs", [
                { ...window, topics: [SRC20_TRANSFER_TOPIC, paddedAddress, null] },
              ]),
              this.rpc.jsonRpc<EthLog[]>("eth_getLogs", [
                { ...window, topics: [SRC20_TRANSFER_TOPIC, null, paddedAddress] },
              ]),
            ]);
            return [...sent, ...received];
          } catch (err) {
            rpcErrorCount++;
            this.logger.warn(`discoverSrc20Contracts: RPC error in window ${i}: ${err}`);
            return [];
          }
        })
      );

      for (const logs of batchLogs) {
        for (const log of logs) {
          const key = `${log.transactionHash}-${log.logIndex}`;
          if (!seen.has(key)) {
            seen.add(key);
            contracts.add(log.address.toLowerCase());
          }
        }
      }
    }

    const apiKey = this.socialscanApiKey;
    if (contracts.size === 0 && rpcErrorCount > 0 && apiKey) {
      this.logger.info(
        `discoverSrc20Contracts: RPC had ${rpcErrorCount} errors and found no contracts - falling back to SocialScan`
      );
      const explorer = new ExplorerService(
        apiKey,
        this.rpc.chainId === 5124,
        this.rpc.rpcUrl,
        this.rpc.axiosClient
      );
      return explorer.discoverSrc20Contracts(address);
    }

    return [...contracts];
  }

  // Inline ERC-20 info helper - avoids a circular reference back to BlockchainApiService
  private async _getErc20Info(
    contractAddress: string
  ): Promise<{ name: string | null; symbol: string | null; decimals: number | null }> {
    const call = async (data: string): Promise<string> => {
      const result = await this.rpc.jsonRpc<string>("eth_call", [
        { to: contractAddress, data },
        "latest",
      ]);
      return result;
    };

    const decodeString = (hex: string): string | null => {
      try {
        if (!hex || hex === "0x") return null;
        const data = hex.startsWith("0x") ? hex.slice(2) : hex;
        const offset = parseInt(data.slice(0, 64), 16) * 2;
        const length = parseInt(data.slice(offset, offset + 64), 16);
        const strHex = data.slice(offset + 64, offset + 64 + length * 2);
        return Buffer.from(strHex, "hex").toString("utf8");
      } catch {
        return null;
      }
    };

    const decodeUint = (hex: string): number | null => {
      try {
        if (!hex || hex === "0x") return null;
        return parseInt(hex, 16);
      } catch {
        return null;
      }
    };

    const [nameHex, symbolHex, decimalsHex] = await Promise.all([
      call("0x06fdde03").catch(() => "0x"),
      call("0x95d89b41").catch(() => "0x"),
      call("0x313ce567").catch(() => "0x"),
    ]);

    return {
      name: decodeString(nameHex),
      symbol: decodeString(symbolHex),
      decimals: decodeUint(decimalsHex),
    };
  }
}
