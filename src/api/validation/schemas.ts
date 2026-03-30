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
