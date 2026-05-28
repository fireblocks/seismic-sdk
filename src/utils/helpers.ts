// Utility functions and helpers

import { readFileSync } from "fs";
import { BasePath } from "@fireblocks/ts-sdk";
import { isAddress, parseUnits } from "viem";
import { FireblocksConfig, TokenType, TransactionType } from "../types/index.js";
import { config, chain_info } from "./index.js";

interface BalanceChecker {
  estimateTxFee(): Promise<number>;
  getFtBalances(vaultId: string): Promise<{ token: TokenType; balance: number }[]>;
}

// Returns credentials for Fireblocks SDK initialization
export const getFinalFireblocksSDKParams = (
  fireblocksConfig?: FireblocksConfig
): {
  apiKey: string;
  secretKey: string;
  basePath: string;
} => {
  let privateKey: string;
  if (fireblocksConfig && fireblocksConfig.apiSecret) {
    privateKey =
      fireblocksConfig.apiSecret.endsWith(".pem") || fireblocksConfig.apiSecret.endsWith(".key")
        ? readFileSync(fireblocksConfig.apiSecret, "utf8")
        : fireblocksConfig.apiSecret;
  } else {
    privateKey = config.FIREBLOCKS.secretKey ?? "";
  }

  const apiKey: string = fireblocksConfig?.apiKey ?? config.FIREBLOCKS.apiKey ?? "";
  const basePath: string =
    fireblocksConfig && fireblocksConfig.basePath
      ? fireblocksConfig.basePath
      : (config.FIREBLOCKS.basePath as BasePath);

  return {
    apiKey,
    secretKey: privateKey,
    basePath,
  };
};

/**
 * Checks and validates transaction parameters, adjusting the amount if necessary.
 *
 * @param recipientAddress - The address of the recipient.
 * @param amount - The amount to transfer in native coin.
 * @param grossTransaction - Optional flag indicating if the transaction is gross, if so fee will be deducted from recipient (default is false).
 * @param type - The type of transaction (default is native coin).
 * @param token - The type of fungible token to transfer (required if type is FungibleToken).
 * @returns A promise that resolves to an object indicating if parameters are valid, the final amount, and reason if invalid.
 * @throws {Error} If parameter validation fails.
 */
export const checkParamsAndAdjustAmount = async (
  sdk: BalanceChecker,
  vaultAccountId: string,
  recipientAddress: string,
  amount: string,
  type: TransactionType,
  token?: TokenType
): Promise<{
  validParams: boolean;
  finalAmount?: bigint;
  reason?: string;
}> => {
  try {
    if (!validateAddress(recipientAddress)) {
      return {
        validParams: false,
        reason: `Not a valid recipient address`,
      };
    }

    if (!validateAmount(amount)) {
      return {
        validParams: false,
        reason: `invalid amount`,
      };
    }

    if (type == TransactionType.FungibleToken && !token) {
      return {
        validParams: false,
        reason: `Token type must be provided for fungible token transfers`,
      };
    }

    const numAmount = typeof amount === "string" ? parseFloat(amount) : amount;
    const smallestUnitAmount = ftToUnits(numAmount, token!);

    const balances = await sdk.getFtBalances(vaultAccountId);
    const balance = balances.find((b) => b.token === token)?.balance;

    if (balance === undefined) {
      return {
        validParams: false,
        reason: `Balance not found for the requested token or account`,
      };
    }

    if (numAmount > balance) {
      return {
        validParams: false,
        reason: `Insufficient funds. Available balance: ${balance}, required: ${numAmount}`,
      };
    }

    return {
      validParams: true,
      finalAmount: smallestUnitAmount,
    };
  } catch (error) {
    throw new Error(`Parameter validation failed: ${formatErrorMessage(error)}`);
  }
};

// Trim spaces and ensure only digit characters remain
export const trimVaultAccountId = (vaultAccountId: string | number): number => {
  if (typeof vaultAccountId === "string") {
    // Trim spaces and ensure only digit characters remain
    const trimmedVaultAccountId =
      vaultAccountId
        .trim()
        .replace(/^\s+|\s+$/g, "")
        .replace(/\D/g, "") || vaultAccountId.trim();
    return Number(trimmedVaultAccountId);
  } else {
    return vaultAccountId;
  }
};

// Use this function to validate transfer amounts
export const validateAmount = (amount: string | number): boolean => {
  try {
    const num = typeof amount === "number" ? amount : Number(amount);
    if (isNaN(num) || num <= 0) {
      console.log("Invalid Amount: amount must be a positive number");
      return false;
    }
    return true;
  } catch {
    throw new Error("validateAmount Failed : Error validating amounts");
  }
};

// Use this function to verify if an address is valid for the blockchain
export const validateAddress = (address: string): boolean => {
  if (!address) return false;
  return isAddress(address);
};

// Converts ETH (human-readable) to wei (10^18 smallest units)
export const coinToUnits = (amount: number | string): bigint => {
  return parseUnits(String(amount), chain_info.coinDecimals);
};

// Converts wei back to ETH (human-readable)
export const unitsToCoin = (units: bigint | number | string): number => {
  return Number(units) / 10 ** chain_info.coinDecimals;
};

// Use this function to convert fungible token amount to smallest units for that token
export const ftToUnits = (
  amount: number | string,
  _token: TokenType,
  decimals: number = 18
): bigint => {
  return parseUnits(String(amount), decimals);
};

const safeStringify = (obj: unknown): string => {
  const seen = new WeakSet();
  try {
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  } catch {
    return String(obj);
  }
};

// Format error messages consistently
export const formatErrorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    // Axios / Fireblocks SDK errors: only return the response body
    const maybeAxios = error as {
      response?: { data?: { message?: string; code?: unknown } };
      message?: string;
    };
    if (maybeAxios.response?.data) {
      const { message, code } = maybeAxios.response.data;
      return code !== undefined
        ? `${message} (code ${code})`
        : (message ?? safeStringify(maybeAxios.response.data));
    }
    if (error instanceof Error) return error.message;
    // Plain object without response - stringify but omit request/response noise
    const obj = error as Record<string, unknown>;
    const rest = Object.fromEntries(
      Object.entries(obj).filter(([k]) => k !== "request" && k !== "response")
    );
    return safeStringify(Object.keys(rest).length ? rest : obj);
  }
  return String(error);
};
