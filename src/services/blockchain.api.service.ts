import { AxiosInstance } from "axios";
import {
  Logger,
  ErrorHandler,
  api_constants,
  ftInfo,
  unitsToCoin,
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

export class BlockchainApiService {
  private readonly logger = new Logger("services:blockchain-api-service");
  private axiosClient: AxiosInstance;
  private readonly rpcUrl: string;
  private readonly errorHandler = new ErrorHandler("blockchain-api", this.logger);
  private network: "mainnet" | "testnet";

  constructor(testnet: boolean = false) {
    this.axiosClient = axiosInstance;
    this.rpcUrl =
      process.env.RPC_URL || testnet ? api_constants.testnet_rpc : api_constants.mainnet_rpc;
    this.network = testnet ? "testnet" : "mainnet";
  }

  /**
   * Formarts a blockchain-specific address from a given public key.
   * @param pubKey - The public key to format the address from.
   * @returns
   */
  public formatAddress = (pubKey: string): string => {
    try {
      if (!pubKey || typeof pubKey !== "string") {
        throw this.errorHandler.handleApiError(
          new Error("Public key must be a non-empty string"),
          "formatting address"
        );
      }

      let address = ""; // Implement address derivation logic here
      return address;
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "fetching transactions history");
    }
  };

  /**   * Retrieves the native coin balance for a given blockchain address.
   * @param address - The blockchain address to retrieve the balance for.
   * @returns The native balance as a number.
   */
  public getNativeBalance = async (address: string): Promise<number> => {
    try {
      if (!validateAddress(address)) {
        throw this.errorHandler.handleApiError(
          new Error("Public key must be a non-empty string"),
          "formatting address"
        );
      }
      // Implement the logic to fetch native balance from the blockchain (as human readable amount)
      const balance = 0;
      return balance;
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "fetching native balance");
    }
  };

  /**   * Retrieves the fungible token balances for a given blockchain address.
   * @param address - The blockchain address to retrieve the fungible token balances for.
   * @returns An object representing the fungible token balances.
   */
  public getFTBalancesForAddress = async (
    address: string
  ): Promise<{ token: TokenType; balance: number }[]> => {
    try {
      if (!validateAddress(address)) {
        throw this.errorHandler.handleApiError(
          new Error("Public key must be a non-empty string"),
          "formatting address"
        );
      }
      // Implement the logic to fetch fungible token balances from the blockchain
      const ftBalances: { token: TokenType; balance: number }[] = [];
      return ftBalances;
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "fetching fungible token balances");
    }
  };

  /** Estimates the transaction fee for a standard transaction.
   * @returns The estimated transaction fee as a number.
   */
  public estimateTxFee = async (): Promise<number> => {
    try {
      // Implement the logic to estimate transaction fee
      const fee = 0;
      return fee;
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "estimating transaction fee");
    }
  };

  /**   * Builds an unsigned transaction for the specified parameters.
   * returns The unsigned transaction object that needs to be signed and broadcasted (Possibly needs to be serialized before signing).
   * @param sender - The sender's address.
   * @param recipient - The recipient's address.
   * @param amount - The amount to send.
   * @param _type - The type of transaction (default is native coin).
   * @param _token - The token type if applicable.
   * @returns The unsigned transaction object.
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
          new Error("invalid sender or recipient address"),
          "building unsigned transaction"
        );
      }

      if (!validateAmount(amount)) {
        throw this.errorHandler.handleApiError(
          new Error("invalid amount"),
          "building unsigned transaction"
        );
      }

      // Implement the logic to build the unsigned transaction.
      // This will mainly use a blockchain SDK method or API call.
      // Most times will require converting amount to Bigint so it can be
      // converted to smallest unit (like wei, satoshi, etc.).
      const unsignedTx = {};

      return unsignedTx;
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "building unsigned transaction");
    }
  };

  /**
   *  Serializes the unsigned transaction object returned from buildUnsignedTransaction to
   * the format its expected to be signed in.
   * Note : buildUnsignedTransaction may sometimes return an unsigned transaction object
   * in the final format before signing, in those cases serialization is not be needed.
   * @param sender - The sender's address.
   * @param recipient - The recipient's address.
   * @param amount - The amount to send.
   * @param type - The type of transaction (default is native coin).
   * @param token - The token type if applicable.
   * @returns The serialized unsigned transaction.
   */
  public serializeTransaction = async (
    sender: string,
    recipient: string,
    amount: number,
    type: TransactionType = TransactionType.Native,
    token?: TokenType
  ): Promise<UnsignedTransaction> => {
    try {
      await this.buildUnsignedTransaction(sender, recipient, amount, type, token);

      const serializedTx = {}; // Implement serialization logic here based on blockchain SDK or API
      return serializedTx;
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "serializing transaction");
    }
  };

  /**   * Broadcasts a signed transaction to the blockchain network.
   * @param _unsignedTransaction - The signed transaction object to broadcast.
   * @returns The result of the broadcast operation.
   */
  public broadcastTransaction = async (_unsignedTransaction: unknown): Promise<BroadcastResult> => {
    try {
      const result = {}; // Implement the logic to broadcast the signed transaction using blockchain SDK or API
      return result;
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "broadcasting transaction");
    }
  };

  /**   * Retrieves the transaction history for a given blockchain address.
   * Note: The code provided is generic for turning transactions returned from the blockchain/indexer
   * into our standard Transaction type. You will need to adapt the fetching logic to your specific blockchain.
   * @param params - Address, limit, and offset for querying transaction history.
   * @returns An array of transactions.
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

    const response = { status: 200, data: { results: [] } }; // Implement the logic to fetch transaction history from the blockchain or indexer using SDK or API

    if (!response || !response.data || response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    try {
      interface RawTxItem {
        tx_id: string;
        block_time_iso: string;
        tx_status: string;
        tx_type: string;
        sender_address: string;
        token_transfer?: { amount: string; recipient_address: string };
        contract_call?: { function_name: string; function_args: unknown[]; contract_id: string };
      }
      const items = (response.data.results || []) as RawTxItem[];
      const txs: Transaction[] = [];

      for (const tx of items) {
        const base = {
          transaction_hash: tx.tx_id as string,
          timestamp: tx.block_time_iso,
          success: tx.tx_status === "success",
        };

        // Native transfers
        if (tx.tx_type === "token_transfer" && tx.token_transfer) {
          const amountInSmallestUnit = BigInt(tx.token_transfer.amount || "0");
          const amount = unitsToCoin(amountInSmallestUnit);

          txs.push({
            type: TransactionType.Native,
            sender: tx.sender_address,
            recipient: tx.token_transfer.recipient_address,
            amount,
            tokenInfo: undefined,
            ...base,
          });

          continue;
        }

        // Fungible Token transfers
        if (
          tx.tx_type === "contract_call" &&
          tx.contract_call?.function_name === "transfer" &&
          tx.contract_call?.function_args.length >= 5
        ) {
          const contractCall = tx.contract_call!;
          const [amountArg, senderArg, recipientArg, tokenIdRaw, tokenName] =
            contractCall.function_args;
          const tokenId = tokenIdRaw as TokenType;

          const decimals = ftInfo[tokenId]?.decimals ?? 0;

          const amountInSmallestUnit = BigInt(amountArg as string);
          const amount = unitsToCoin(amountInSmallestUnit);

          txs.push({
            type: TransactionType.FungibleToken,
            tokenInfo: {
              tokenID: tokenId,
              tokenName: tokenName as string,
              decimals,
            },
            sender: senderArg as string,
            recipient: recipientArg as string,
            amount,
            ...base,
          });

          continue;
        }
      }

      return txs;
    } catch (error) {
      throw this.errorHandler.handleApiError(error, "fetching transactions history");
    }
  };
}
