// Utility functions and helpers

import fs, { readFileSync } from "fs";
import { BasePath } from "@fireblocks/ts-sdk";
import {
  FireblocksConfig,
  GetFtBalancesResponse,
  GetNativeBalanceResponse,
  TokenType,
  TransactionType,
} from "../types/index.js";
import { config, chain_info } from "./index.js";
import { MainSDK } from "../MainSDK.js";

// Returns credentials for Fireblocks SDK initialization
export const getFinalFireblocksSDKParams = (
  fireblocksConfig?: FireblocksConfig
): {
  apiKey: string;
  secretKey: string;
  basePath: string;
} => {
  var privateKey: string;
  if (fireblocksConfig && fireblocksConfig.apiSecret) {
    privateKey =
      fireblocksConfig.apiSecret.endsWith(".pem") || fireblocksConfig.apiSecret.endsWith(".key")
        ? readFileSync(fireblocksConfig.apiSecret, "utf8")
        : fireblocksConfig.apiSecret;
  } else {
    const secretKeyPath = process.env.FIREBLOCKS_API_USER_SECRET_KEY_PATH || "";
    privateKey = fs.readFileSync(secretKeyPath, "utf8");
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
  sdk: MainSDK,
  vaultAccountId: string,
  recipientAddress: string,
  amount: number,
  grossTransaction: boolean | undefined,
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

    let smallestUnitAmount =
      type == TransactionType.FungibleToken ? ftToUnits(amount, token!) : coinToUnits(amount);

    let fee = 0;

    if (type == TransactionType.Native) {
      fee = await sdk.getBlockchainApiService().estimateTxFee();
    }

    const balanceResponse =
      type == TransactionType.FungibleToken
        ? await sdk.getFtBalances(vaultAccountId)
        : await sdk.getBalance(vaultAccountId);

    if (!balanceResponse.success) {
      throw new Error(`Could not fetch account balance to check funds sufficiency`);
    }

    // if its a gross STX transfer, deduct fee from transferred amount
    if (type == TransactionType.Native && grossTransaction) {
      console.log(`Gross transaction: deducting fee from transferred amount`);
      amount -= fee;
      if (amount <= 0) {
        return {
          validParams: false,
          reason: `Amount after fee deduction is zero or negative`,
        };
      }
    }

    let balance;
    // to do : check amount against balance
    if (type == TransactionType.FungibleToken) {
      balance = (balanceResponse as GetFtBalancesResponse).data?.find(
        (b) => b.token === token
      )?.balance;
    } else {
      balance = (balanceResponse as GetNativeBalanceResponse).balance;
    }

    if (amount + fee > balance!) {
      return {
        validParams: false,
        reason: `Insufficient funds. Available balance: ${balance}, required: ${amount}`,
      };
    }

    // Recalculate microAmount after any adjustments
    smallestUnitAmount =
      type == TransactionType.FungibleToken ? ftToUnits(amount, token!) : coinToUnits(amount);

    console.log(
      `Converted amount to micro: ${smallestUnitAmount} (from ${amount} ${token ? token : "STX"})`
    );

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

  // Implement blockchain-specific address validation logic here
  return true; // Placeholder
};

// Converts ETH (human-readable) to wei (10^18 smallest units)
export const coinToUnits = (amount: number | string): bigint => {
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  return BigInt(Math.round(n * 10 ** chain_info.coinDecimals));
};

// Converts wei back to ETH (human-readable)
export const unitsToCoin = (units: bigint | number | string): number => {
  return Number(units) / 10 ** chain_info.coinDecimals;
};

// Use this function to convert fungible token amount to smallest units for that token
export const ftToUnits = (_amount: number | string, _token: TokenType): bigint => {
  // implement conversion logic here
  return BigInt(0); // Placeholder
};

// Use this function to convert fungible token amount in smallest units to human readable amount
export const unitsToFt = (_units: bigint | number | string, _token: TokenType): number => {
  // implement conversion logic here
  return 0; // Placeholder
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
  if (error instanceof Error) {
    // Axios/SDK errors: prefer the response body if present
    const maybeAxios = error as { response?: { data?: unknown } };
    if (maybeAxios.response?.data) {
      return safeStringify(maybeAxios.response.data);
    }
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    return safeStringify(error);
  }
  return String(error);
};
