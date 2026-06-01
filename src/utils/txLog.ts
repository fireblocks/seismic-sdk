import fs from "fs";
import path from "path";
import { Logger } from "./logger.js";

const logger = new Logger("utils:txLog");

export interface TxLogEntry {
  timestamp: string;
  vault: string;
  type: string;
  to: string;
  amount: string;
  contract?: string;
  nonce?: number;
  txHash: string;
}

/**
 * Appends a broadcast transaction to the persistent tx log file (tx-log.ndjson).
 *
 * Each line is a JSON object (newline-delimited JSON / NDJSON). Safe to tail -f.
 * Errors are swallowed so a log failure never breaks a broadcast.
 *
 * @param entry - Transaction details to record
 */
export const logTx = (entry: TxLogEntry): void => {
  try {
    const logDir = process.env.TX_LOG_DIR ?? ".";
    const logFile = path.join(logDir, "tx-log.ndjson");
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(logFile, line, "utf8");
    logger.info(
      `TX logged | hash:${entry.txHash} | vault:${entry.vault} | type:${entry.type} | to:${entry.to} | amount:${entry.amount}`
    );
  } catch (err) {
    // Never let logging break a broadcast
    logger.warn(
      `Failed to write tx log entry: ${err instanceof Error ? err.message : String(err)}`
    );
  }
};
