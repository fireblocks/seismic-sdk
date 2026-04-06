import { z } from "zod";
import { vaultAccountOptsSchema } from "../../types/index.js";

// ============================================================================
// PARAMS SCHEMAS
// Extends base schemas with API-specific validation rules
// ============================================================================

/**
 * Validates vaultAccountId param with API validation rules
 */
export const vaultParams = vaultAccountOptsSchema.extend({
  vaultAccountId: z
    .string()
    .min(1, "vaultAccountId is required")
    .regex(/^\d+$/, "vaultAccountId must be numeric"),
});

/**
 * Validates vaultAccountId and assetId params
 */
export const vaultAndAssetParams = vaultParams.extend({
  assetId: z
    .string()
    .min(1, "assetId is required")
    .regex(
      /^[A-Z0-9_-]+$/i,
      "assetId must contain only alphanumeric characters, hyphens, or underscores"
    )
    .toUpperCase(),
});

// ============================================================================
// QUERY SCHEMAS
// ============================================================================

/**
 * Validates optional index query parameter
 */
export const indexQuery = z.object({
  index: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 0))
    .refine((val) => !isNaN(val) && val >= 0, {
      message: "index must be a non-negative number",
    }),
});

/**
 * Validates transaction history query parameters
 */
export const transactionHistoryQuery = z.object({
  assetId: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined))
    .refine((val) => val === undefined || (!isNaN(val) && val > 0), {
      message: "limit must be a positive number",
    }),
  offset: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined))
    .refine((val) => val === undefined || (!isNaN(val) && val >= 0), {
      message: "offset must be a non-negative number",
    }),
  status: z.string().optional(),
  startDate: z
    .string()
    .optional()
    .refine(
      (val) => {
        if (!val) return true;
        const date = new Date(val);
        return !isNaN(date.getTime());
      },
      {
        message: "startDate must be a valid ISO 8601 date string",
      }
    ),
  endDate: z
    .string()
    .optional()
    .refine(
      (val) => {
        if (!val) return true;
        const date = new Date(val);
        return !isNaN(date.getTime());
      },
      {
        message: "endDate must be a valid ISO 8601 date string",
      }
    ),
});

// ============================================================================
// BODY SCHEMAS
// ============================================================================

/**
 * Validates transaction submission body
 */
export const submitTransactionBody = z.object({
  transactionRequest: z
    .object({
      operation: z.string().min(1, "operation is required"),
    })
    .loose(),
  waitForCompletion: z.boolean().optional().default(true),
});

// ============================================================================
// SEISMIC-SPECIFIC SCHEMAS
// ============================================================================

/**
 * Validates `:txHash` route param — must be 0x-prefixed 32-byte hex (66 chars total)
 */
export const txHashParam = z.object({
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be a 0x-prefixed 32-byte hex string"),
});

/**
 * Validates contracts query — accepts comma-separated string or repeated params
 * e.g. ?contracts=0x1,0x2  or  ?contracts=0x1&contracts=0x2
 */
export const contractsQuery = z.object({
  contracts: z
    .union([z.string(), z.array(z.string())])
    .transform((val) =>
      (Array.isArray(val) ? val : val.split(",")).map((s) => s.trim()).filter(Boolean)
    )
    .refine((addrs) => addrs.length > 0 && addrs.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a)), {
      message: "each contract must be a valid 0x-prefixed EVM address",
    }),
});

/**
 * Validates POST /api/:vaultId/transfer body.
 * Destination is either a `recipient` address or a `destinationVaultId` (not both).
 * `contractAddress` is required for ERC20 and SRC20 types.
 */
export const transferBody = z
  .object({
    type: z.enum(["ETH", "ERC20", "SRC20"] as const, "type must be ETH, ERC20, or SRC20"),
    recipient: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, "recipient must be a valid EVM address")
      .optional(),
    destinationVaultId: z
      .string()
      .regex(/^\d+$/, "destinationVaultId must be a numeric string")
      .optional(),
    amount: z.number().positive("amount must be positive"),
    contractAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, "contractAddress must be a valid EVM address")
      .optional(),
    note: z.string().optional(),
  })
  .refine((data) => !!data.recipient !== !!data.destinationVaultId, {
    message: "exactly one of recipient or destinationVaultId must be provided",
  })
  .refine((data) => data.type === "ETH" || !!data.contractAddress, {
    message: "contractAddress is required for ERC20 and SRC20 transfers",
    path: ["contractAddress"],
  });
