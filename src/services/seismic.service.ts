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
import type { LocalAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  createShieldedPublicClient,
  createShieldedWalletClient,
  getShieldedContract,
  getEncryption,
  AesGcmCrypto,
  encodeSeismicMetadataAsAAD,
  seismicDevnet2,
  computeKeyHash,
  checkRegistration,
  shieldedWriteContract,
  DIRECTORY_ADDRESS,
  DirectoryAbi,
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
  GetTransactionHistoryFromIndexerOpts,
  TokenType,
  Transaction,
  UnsignedTransaction,
  TransactionType,
} from "../types/index.js";

type EthLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
};
import axiosInstance from "../utils/httpClient.js";
import {
  chain_info,
  SEISMIC_CHAIN_ID,
  ERC20_SELECTORS,
  DEFAULT_TOKEN_DECIMALS,
  ERC20_TRANSFER_TOPIC,
  SRC20_TRANSFER_TOPIC,
} from "../utils/constants.js";
import { ExplorerService } from "./explorer.service.js";
import { SRC20Abi } from "../seismic/abi.js";

type SeismicClient = ShieldedWalletClient<Transport, Chain>;
type SeismicPublicClient = ShieldedPublicClient<Transport, Chain>;

export class BlockchainApiService {
  private readonly logger = new Logger("services:blockchain-api");
  private axiosClient: AxiosInstance;
  private readonly rpcUrl: string;
  private readonly chainId: number;
  private readonly errorHandler = new ErrorHandler("blockchain-api", this.logger);
  /** Cached TEE public key - stable per network session */
  private teePublicKey: string | null = null;

  constructor(testnet: boolean = false) {
    this.axiosClient = axiosInstance;
    this.rpcUrl =
      process.env.RPC_URL || (testnet ? api_constants.testnet_rpc : api_constants.mainnet_rpc);
    this.chainId = testnet ? SEISMIC_CHAIN_ID.testnet : SEISMIC_CHAIN_ID.mainnet;
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
   * applies keccak256, and takes the last 20 bytes - standard EVM address derivation.
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
      const point = secp256k1.Point.fromHex(hex);
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
  /**
   * Fetches name, symbol, decimals, and totalSupply from a standard ERC-20 contract.
   * Any field that fails to decode (e.g. non-standard contract) is returned as null.
   */
  public getErc20Info = async (
    contractAddress: string
  ): Promise<{
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    totalSupply: string | null;
  }> => {
    const call = (selector: string) =>
      this.jsonRpc<string>("eth_call", [{ to: contractAddress, data: selector }, "latest"]).catch(
        () => null
      );

    const [nameHex, symbolHex, decimalsHex, totalSupplyHex] = await Promise.all([
      call(ERC20_SELECTORS.name),
      call(ERC20_SELECTORS.symbol),
      call(ERC20_SELECTORS.decimals),
      call(ERC20_SELECTORS.totalSupply),
    ]);

    const decodeString = (hex: string | null): string | null => {
      if (!hex || hex === "0x") return null;
      try {
        // ABI-encoded string: offset(32) + length(32) + data
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
   * For SRC-20 shielded transfers use MainSDK.createShieldedTransaction instead -
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
   * Delegates to buildUnsignedTransaction - callers use the tx fields to construct
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
   * For shielded SRC-20 transfers, use MainSDK.createShieldedTransaction - those
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
   * Routes by `type`:
   * - "native"  → SocialScan `txlist` + `txlistinternal` (ETH has no logs; requires SOCIALSCAN_API_KEY)
   * - "erc20"   → SocialScan `tokentx` if SOCIALSCAN_API_KEY is set, else fallback to eth_getLogs
   * - "src20"   → SocialScan `getLogs` filtered by SRC-20 Transfer topic (requires contracts + SOCIALSCAN_API_KEY)
   * - "all"     → Native + ERC-20 merged (requires SOCIALSCAN_API_KEY for native portion)
   *
   * Falls back to eth_getLogs for ERC-20 when no API key is configured.
   * Native ETH history is unavailable without the explorer API key.
   */
  public getTransactionHistory = async (
    params: GetTransactionHistoryFromIndexerOpts
  ): Promise<{
    transactions: Transaction[];
    fromBlock: string;
    toBlock: string;
    source: string;
    total: number; // total matching events before pagination
  }> => {
    const {
      address,
      contracts,
      limit = 50,
      offset = 0,
      type = "erc20",
      encryptionSk,
      viewingKey,
    } = params;

    if (!validateAddress(address)) {
      throw this.errorHandler.handleApiError(
        new Error("Invalid address provided"),
        "fetching transaction history"
      );
    }

    const apiKey = process.env.SOCIALSCAN_API_KEY;
    const useExplorer = !!apiKey;

    // ── Explorer path ───────────────────────────────────────────────────────
    if (useExplorer) {
      const explorer = new ExplorerService(apiKey!, this.chainId === SEISMIC_CHAIN_ID.testnet);

      // native has no fallback - ETH transfers emit no logs, only the explorer can provide them
      if (type === "native") {
        const transactions = await explorer.getNativeTransactions(address, limit, offset);
        return {
          transactions,
          fromBlock: "0",
          toBlock: "latest",
          source: "socialscan-txlist",
          total: transactions.length,
        };
      }

      if (type === "src20") {
        if (!contracts?.length) {
          throw this.errorHandler.handleApiError(
            new Error(
              "SRC-20 history requires at least one contract address in the `contracts` filter"
            ),
            "fetching SRC-20 transaction history"
          );
        }
        try {
          const allTxs = (
            await Promise.all(
              contracts.map((c) => explorer.getSrc20Transactions(address, c, limit, offset))
            )
          ).flat();
          allTxs.sort((a, b) => (b.timestamp as number) - (a.timestamp as number));
          const src20Page = allTxs.slice(0, limit);
          return {
            transactions: src20Page,
            fromBlock: "0",
            toBlock: "latest",
            source: "socialscan-getlogs-src20",
            total: allTxs.length,
          };
        } catch (explorerErr) {
          this.logger.warn(
            `SocialScan unavailable (${(explorerErr as Error).message}), falling back to eth_getLogs for SRC-20`
          );
          // fall through to eth_getLogs below
        }
      }

      if (type === "all") {
        const [native, erc20] = await Promise.all([
          explorer.getNativeTransactions(address, limit, offset),
          explorer.getErc20Transactions(address, contracts?.[0], limit, offset),
        ]);
        const merged = [...native, ...erc20].sort(
          (a, b) => (b.timestamp as number) - (a.timestamp as number)
        );
        const allPage = merged.slice(0, limit);
        return {
          transactions: allPage,
          fromBlock: "0",
          toBlock: "latest",
          source: "socialscan-txlist+tokentx",
          total: merged.length,
        };
      }

      // type === "erc20": try explorer, fall back to eth_getLogs if unavailable
      try {
        const transactions = await explorer.getErc20Transactions(
          address,
          contracts?.[0],
          limit,
          offset
        );
        return {
          transactions,
          fromBlock: "0",
          toBlock: "latest",
          source: "socialscan-tokentx",
          total: transactions.length,
        };
      } catch (explorerErr) {
        this.logger.warn(
          `SocialScan unavailable (${(explorerErr as Error).message}), falling back to eth_getLogs`
        );
        // fall through to eth_getLogs below
      }
    }

    // ── Fallback: eth_getLogs ────────────────────────────────────────────────
    // Handles erc20, src20 (SocialScan unavailable), and all (erc20 portion).
    // native has no RPC fallback - eth_getLogs does not capture ETH transfers.
    if (type === "native") {
      throw this.errorHandler.handleApiError(
        new Error(
          "Native ETH transaction history requires the SocialScan Explorer API (no RPC fallback). " +
            "Set SOCIALSCAN_API_KEY in your environment (get a key at developer.socialscan.io)."
        ),
        "fetching transaction history"
      );
    }

    // Seismic nodes cap eth_getLogs at 100,000 blocks per query and produce
    // multiple blocks per second. Pin both fromBlock and toBlock to the same
    // snapshot so the range can't drift over the limit between calls.
    let fromBlock = params.fromBlock;
    let toBlock = params.toBlock;
    if (!fromBlock || !toBlock) {
      const latestHex = await this.jsonRpc<string>("eth_blockNumber", []);
      const latest = parseInt(latestHex, 16);
      if (!toBlock) toBlock = latestHex;
      if (!fromBlock) {
        const from = Math.max(0, latest - 99_000); // safely under the 100k limit
        fromBlock = `0x${from.toString(16)}`;
      }
    }

    const isSrc20 = type === "src20";
    const paddedAddress = "0x" + address.slice(2).toLowerCase().padStart(64, "0");
    const transferTopic = isSrc20 ? SRC20_TRANSFER_TOPIC : ERC20_TRANSFER_TOPIC;

    // ── Viewing key path (SRC-20 received transfers) ────────────────────────
    if (isSrc20 && viewingKey) {
      const keyHash = computeKeyHash(viewingKey);
      const baseFilter = {
        fromBlock,
        toBlock,
        ...(contracts?.length ? { address: contracts } : {}),
      };

      // Fetch received events and sent events in parallel.
      const [sentLogs, receivedLogs] = await Promise.all([
        this.jsonRpc<EthLog[]>("eth_getLogs", [
          { ...baseFilter, topics: [transferTopic, paddedAddress] },
        ]),
        this.jsonRpc<EthLog[]>("eth_getLogs", [
          { ...baseFilter, topics: [transferTopic, null, paddedAddress, keyHash] },
        ]),
      ]);

      // Deduplicate (self-transfers appear in both)
      const seen = new Set<string>();
      const allLogs = [...receivedLogs, ...sentLogs].filter((log) => {
        const key = `${log.transactionHash}-${log.logIndex}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      allLogs.sort((a, b) => parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16));
      const sliced = allLogs.slice(offset, offset + limit);

      const uniqueBlocks = [...new Set(sliced.map((l) => l.blockNumber))];
      const uniqueContracts = [...new Set(sliced.map((l) => l.address))];
      const blockTimestamps = new Map<string, number>();
      const tokenDecimals = new Map<string, number>();
      const tokenSymbols = new Map<string, string>();

      await Promise.all([
        ...uniqueBlocks.map(async (blockNum) => {
          const block = await this.jsonRpc<{ timestamp: string } | null>("eth_getBlockByNumber", [
            blockNum,
            false,
          ]);
          if (block) blockTimestamps.set(blockNum, parseInt(block.timestamp, 16));
        }),
        ...uniqueContracts.map(async (contractAddr) => {
          const info = await this.getErc20Info(contractAddr);
          tokenDecimals.set(contractAddr, info.decimals ?? DEFAULT_TOKEN_DECIMALS);
          tokenSymbols.set(contractAddr, info.symbol ?? contractAddr);
        }),
      ]);

      const receivedSet = new Set(receivedLogs.map((l) => `${l.transactionHash}-${l.logIndex}`));

      const transactions = await Promise.all(
        sliced.map(async (log) => {
          const decimals = tokenDecimals.get(log.address) ?? DEFAULT_TOKEN_DECIMALS;
          const symbol = tokenSymbols.get(log.address) ?? log.address;
          const logKey = `${log.transactionHash}-${log.logIndex}`;

          let amount = 0;

          if (receivedSet.has(logKey)) {
            // Received transfer: encryptedAmount in event data is encrypted to our viewing key.
            // log.data is ABI-encoded bytes: 32-byte offset + 32-byte length + actual bytes.
            // decode to get the raw encrypted bytes before splitting nonce/ciphertext.
            const dataHex = (log.data as string).slice(2); // strip "0x"
            const byteLength = parseInt(dataHex.slice(64, 128), 16); // 32-byte length field
            const encryptedData = "0x" + dataHex.slice(128, 128 + byteLength * 2);
            // parseEncryptedData logic: last 24 hex chars = 12-byte nonce, rest = ciphertext
            const nonce = ("0x" + encryptedData.slice(-24)) as Hex;
            const encryptedPart = encryptedData.slice(0, encryptedData.length - 24) as Hex;
            try {
              const plaintext = await new AesGcmCrypto(viewingKey).decrypt(encryptedPart, nonce);
              const rawAmount = BigInt(plaintext);
              const divisor = BigInt(10 ** decimals);
              amount = Number(rawAmount / divisor) + Number(rawAmount % divisor) / 10 ** decimals;
            } catch {
              // encryptedAmount was empty or used a different key
            }
          } else if (encryptionSk) {
            // Sent transfer: event data is encrypted to recipient's key.
            // Decrypt via ECDH on calldata.
            const decrypted = await this.decryptSrc20Amount(
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
        fromBlock,
        toBlock,
        source: "eth_getLogs-viewing-key",
        total: allLogs.length,
      };
    }

    const baseFilter = {
      fromBlock,
      toBlock,
      ...(contracts?.length ? { address: contracts } : {}),
    };

    const [sentLogs, receivedLogs] = await Promise.all([
      this.jsonRpc<EthLog[]>("eth_getLogs", [
        { ...baseFilter, topics: [transferTopic, paddedAddress, null] },
      ]),
      this.jsonRpc<EthLog[]>("eth_getLogs", [
        { ...baseFilter, topics: [transferTopic, null, paddedAddress] },
      ]),
    ]);

    // Deduplicate by transactionHash + logIndex (e.g. self-transfers)
    const seen = new Set<string>();
    const allLogs = [...sentLogs, ...receivedLogs].filter((log) => {
      const key = `${log.transactionHash}-${log.logIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    allLogs.sort((a, b) => parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16));
    const sliced =
      limit !== undefined ? allLogs.slice(offset, offset + limit) : allLogs.slice(offset);

    // Fetch timestamps and token metadata in parallel for unique blocks/contracts
    const uniqueBlocks = [...new Set(sliced.map((l) => l.blockNumber))];
    const uniqueContracts = [...new Set(sliced.map((l) => l.address))];

    const blockTimestamps = new Map<string, number>();
    const tokenDecimals = new Map<string, number>();
    const tokenSymbols = new Map<string, string>();

    await Promise.all([
      ...uniqueBlocks.map(async (blockNum) => {
        const block = await this.jsonRpc<{ timestamp: string } | null>("eth_getBlockByNumber", [
          blockNum,
          false,
        ]);
        if (block) blockTimestamps.set(blockNum, parseInt(block.timestamp, 16));
      }),
      ...uniqueContracts.map(async (contractAddr) => {
        const info = await this.getErc20Info(contractAddr);
        tokenDecimals.set(contractAddr, info.decimals ?? DEFAULT_TOKEN_DECIMALS);
        tokenSymbols.set(contractAddr, info.symbol ?? contractAddr);
      }),
    ]);

    const transactions = await Promise.all(
      sliced.map(async (log) => {
        const decimals = tokenDecimals.get(log.address) ?? DEFAULT_TOKEN_DECIMALS;
        const symbol = tokenSymbols.get(log.address) ?? log.address;

        let amount = 0;
        if (isSrc20 && encryptionSk) {
          // Decrypt the calldata of the type-0x4A tx to recover the plaintext amount
          const decrypted = await this.decryptSrc20Amount(
            log.transactionHash,
            encryptionSk,
            decimals
          );
          if (decrypted !== null) {
            amount = decrypted;
          }
        } else if (!isSrc20) {
          const rawAmount = BigInt(log.data || "0x0");
          amount = Number(rawAmount) / 10 ** decimals;
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

    return { transactions, fromBlock, toBlock, source: "eth_getLogs", total: allLogs.length };
  };

  /**
   * Fetches a transaction by hash using eth_getTransactionByHash.
   * Returns null if the transaction is not found.
   */
  public getTransactionByHash = async (txHash: string): Promise<Record<string, unknown> | null> => {
    const result = await this.jsonRpc<Record<string, unknown> | null>("eth_getTransactionByHash", [
      txHash,
    ]);
    return result;
  };

  /**
   * Decrypts the calldata of a Seismic type-0x4A SRC-20 transfer and returns the token amount.
   *
   * Seismic encrypts transfer(address,suint256) calldata with AES-GCM using
   * ECDH(encryptionSk, tx.encryptionPubkey) as the shared key. The tx stores the
   * nonce as `encryptionNonce`. After decryption the plaintext is standard ABI-encoded
   * calldata: 4-byte selector + 32-byte recipient + 32-byte uint256 amount.
   *
   * @param txHash      - Transaction hash of the type-0x4A SRC-20 transfer
   * @param encryptionSk - Vault's 32-byte encryption private key (hex)
   * @param decimals    - Token decimals for human-readable conversion (default: 18)
   * @returns Human-readable token amount, or null if decryption fails
   */
  /**
   * Fetches and caches the Seismic TEE public key.
   * Used as the network public key for ECDH key agreement during decryption.
   */
  private getTeePubkey = async (): Promise<string> => {
    if (this.teePublicKey) return this.teePublicKey;
    const result = await this.jsonRpc<string>("seismic_getTeePublicKey", []);
    this.teePublicKey = result;
    return result;
  };

  public decryptSrc20Amount = async (
    txHash: string,
    encryptionSk: Hex,
    decimals: number = 18
  ): Promise<number | null> => {
    try {
      const tx = await this.getTransactionByHash(txHash);
      if (!tx) return null;

      const input = tx.input as string | undefined;
      const encryptionNonce = tx.encryptionNonce as Hex | undefined;

      if (!input || !encryptionNonce || input === "0x") return null;

      // Step 1: Derive AES key - ECDH(encryptionSk, networkTeePubkey) + HKDF
      const networkTeePubkey = await this.getTeePubkey();
      const { aesKey } = getEncryption(networkTeePubkey, encryptionSk);

      // Step 2: Build AAD using seismic-viem's encodeSeismicMetadataAsAAD.
      // Pass typed values (numbers/bigints) - the function handles zero encoding internally.
      const encPubkey = (tx.encryptionPubkey as string).startsWith("0x")
        ? (tx.encryptionPubkey as Hex)
        : (`0x${tx.encryptionPubkey}` as Hex);

      const aad = encodeSeismicMetadataAsAAD({
        sender: tx.from as `0x${string}`,
        legacyFields: {
          chainId: parseInt(tx.chainId as string, 16),
          nonce: parseInt(tx.nonce as string, 16),
          to: (tx.to ?? "0x") as `0x${string}`,
          value: BigInt((tx.value as string) ?? "0x0"),
        },
        seismicElements: {
          encryptionPubkey: encPubkey,
          encryptionNonce,
          messageVersion: parseInt((tx.messageVersion as string) ?? "0x0", 16),
          recentBlockHash: tx.recentBlockHash as Hex,
          expiresAtBlock: BigInt(tx.expiresAtBlock as string),
          signedRead: (tx.signedRead as boolean) ?? false,
        },
      });

      // Step 3: Decrypt AES-GCM ciphertext
      const aesCrypto = new AesGcmCrypto(aesKey);
      const plaintext = await aesCrypto.decrypt(input as Hex, encryptionNonce, aad);

      // ABI calldata: 0x{4-byte selector}{32-byte address}{32-byte uint256 amount}
      const plain = plaintext.replace(/^0x/, "");
      if (plain.length < 8 + 64 + 64) return null;

      const amountHex = plain.slice(8 + 64, 8 + 64 + 64); // skip selector (4B) + recipient (32B)
      const rawAmount = BigInt("0x" + amountHex);
      const divisor = BigInt(10 ** decimals);
      const whole = rawAmount / divisor;
      const remainder = rawAmount % divisor;
      return Number(whole) + Number(remainder) / 10 ** decimals;
    } catch (err) {
      this.logger.debug(`SRC-20 decryption failed for ${txHash}: ${(err as Error).message}`);
      return null;
    }
  };

  // ─── Viewing key (Directory precompile) ─────────────────────────────────────

  /**
   * Registers an AES viewing key in the Seismic Directory precompile for a given address.
   * After registration, Transfer events for that address will have `encryptedAmount`
   *
   * @param client     - ShieldedWalletClient for the vault (signs the Directory write)
   * @param viewingKey - 32-byte AES key (hex). Derive via keccak256(encryptionSk).
   * @returns Transaction hash of the registration
   */
  public registerViewingKey = async (client: SeismicClient, viewingKey: Hex): Promise<Hex> => {
    this.logger.info("Registering viewing key in Directory precompile");
    // Call shieldedWriteContract directly (instead of registerKey) so we can pass explicit gas
    // and gasPrice.
    const hexGasPrice = await this.jsonRpc<string>("eth_gasPrice", []);
    const gasPrice = BigInt(hexGasPrice);
    return shieldedWriteContract(client, {
      address: DIRECTORY_ADDRESS,
      abi: DirectoryAbi,
      functionName: "setKey",
      args: [BigInt(viewingKey)],
      gas: 200_000n,
      gasPrice,
    });
  };

  /**
   * Returns whether an address has a viewing key registered in the Directory precompile.
   *
   * @param address - The Seismic/ETH address to check
   */
  public checkViewingKeyRegistered = async (address: Address): Promise<boolean> => {
    const publicClient = this.createPublicClient();
    return checkRegistration(publicClient as unknown as SeismicClient, address);
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
   *                            via deriveKeyFromSignature - never stored on disk.
   */
  public createShieldedClient = async (
    accountOrPrivateKey: Hex | LocalAccount,
    encryptionSk?: Hex
  ): Promise<SeismicClient> => {
    const account =
      typeof accountOrPrivateKey === "string"
        ? privateKeyToAccount(accountOrPrivateKey)
        : accountOrPrivateKey;

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
    this.logger.info("Shielded client created - TEE public key fetched");
    return client as SeismicClient;
  };

  /**
   * Creates a Seismic public client for read-only operations.
   *
   * Unlike createShieldedClient, this does not require a private key - suitable for
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
   * Uses a plain unsigned eth_call (via ShieldedPublicClient)
   *
   * @param client          - ShieldedPublicClient (read-only, no private key needed)
   * @param contractAddress - SRC-20 contract address (must be a TestSRC20/SRC20-derived contract,
   *                          not a plain ERC-20 - MockERC20 does not have balanceOfSigned)
   * @param ownerAddress    - Vault's Seismic/ETH address
   * @param signature       - 65-byte packed signature from FireblocksSigner.packSignature()
   * @param expiry          - Unix timestamp from createExpiry() - must not be expired
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

    const hexGasPrice = await this.jsonRpc<string>("eth_gasPrice", []);
    const gasPrice = BigInt(hexGasPrice);
    const txHash = await contract.write.transfer([to, amount], { gas: 200_000n, gasPrice });
    this.logger.info(`Shielded transfer submitted | txHash:${txHash}`);
    return txHash;
  };

  /**
   * Polls until the transaction is confirmed on Seismic.
   * Default timeout is 60 seconds - increase for high-congestion periods.
   */
  public waitForReceipt = async (client: SeismicClient, txHash: Hex, timeoutMs = 60_000) => {
    this.logger.debug(`Waiting for receipt | txHash:${txHash}`);
    return client.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs });
  };
}
