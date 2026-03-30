import { z } from "zod";

// ============================================================================
// Base Zod Schemas - Single source of truth
// ============================================================================

export const vaultAccountOptsSchema = z.object({
  vaultAccountId: z.string(),
});

export const vaultDestinationOptsSchema = vaultAccountOptsSchema.extend({
  destAddress: z.string(),
});

export const vaultIndexOptsSchema = vaultAccountOptsSchema.extend({
  index: z.number(),
});

export const vaultIndexDestinationOptsSchema = vaultIndexOptsSchema.extend({
  destAddress: z.string(),
});

export const transactionStatusOptsSchema = z.object({
  destAddress: z.string(),
  transactionId: z.string(),
});

// ============================================================================
// TypeScript Types - Inferred from Zod schemas
// ============================================================================

export type VaultAccountOpts = z.infer<typeof vaultAccountOptsSchema>;
export type VaultDestinationOpts = z.infer<typeof vaultDestinationOptsSchema>;
export type VaultIndexOpts = z.infer<typeof vaultIndexOptsSchema>;
export type VaultIndexDestinationOpts = z.infer<typeof vaultIndexDestinationOptsSchema>;
export type TransactionStatusOpts = z.infer<typeof transactionStatusOptsSchema>;
