import {
  OperationType,
  GetVaultAccountAddressOpts,
  GetVaultAccountAddressesOpts,
  SubmitTransactionOpts,
  GetTransactionsHistoryOpts,
} from "./index.js";
/**
 * Result returned by broadcastTransaction and buildSignSendTransaction.
 * Implementors populate txid on success or err on failure.
 */
export interface BroadcastResult {
  txid?: string;
  err?: unknown;
}

/**
 * Options for executing a transaction through the API service
 */
export interface ExecuteTransactionOpts {
  /** The vault account ID to use */
  vaultAccountId: string;
  /** The type of transaction to execute */
  transactionType: OperationType;
  /** Parameters specific to the transaction type */
  params:
    | GetVaultAccountAddressOpts
    | GetVaultAccountAddressesOpts
    | SubmitTransactionOpts
    | GetTransactionsHistoryOpts;
}
