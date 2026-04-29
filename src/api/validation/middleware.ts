import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

import { Logger } from "../../utils/index.js";

const logger = new Logger("app:server-initializer");

/**
 * Configuration for validation middleware
 */
interface ValidationConfig {
  params?: { parseAsync: (data: unknown) => Promise<Record<string, string>> };
  query?: { parseAsync: (data: unknown) => Promise<Record<string, unknown>> };
  body?: { parseAsync: (data: unknown) => Promise<Record<string, unknown>> };
}

/**
 * Validation middleware that validates request params, query, and body.
 *
 * @param config - Object containing optional schemas for params, query, and body
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * router.get(
 *   '/vaults/:vaultAccountId/addresses/:assetId',
 *   validate({
 *     params: vaultAndAssetParams,
 *     query: indexQuery
 *   }),
 *   controller.getVaultAccountAddress
 * );
 * ```
 */
export const validate = (config: ValidationConfig) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Validate each part of the request independently
      if (config.params) {
        const validatedParams = await config.params.parseAsync(req.params);
        req.params = { ...validatedParams } as Record<string, string>;
      }
      if (config.query) {
        const validatedQuery = await config.query.parseAsync(req.query);
        (req.query as unknown) = { ...validatedQuery };
      }
      if (config.body) {
        req.body = await config.body.parseAsync(req.body);
      }

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        // Format Zod validation errors into a user-friendly structure
        const formattedErrors = error.issues.map((err) => ({
          field: err.path.join("."),
          message: err.message,
          code: err.code,
        }));

        // Respond with 400 Bad Request and validation error details

        logger.warn("Validation error", { errors: formattedErrors });

        res.status(400).json({
          success: false,
          error: "Validation failed",
          statusCode: 400,
          type: "VALIDATION_ERROR",
          details: formattedErrors,
        });
        return;
      }

      logger.error("Internal server error during validation", error);

      // Handle unexpected errors
      res.status(500).json({
        success: false,
        error: "Internal server error during validation",
        statusCode: 500,
      });
    }
  };
};
