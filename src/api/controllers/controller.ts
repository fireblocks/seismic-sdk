import { Request, Response } from "express";
import { MainSDK } from "../../MainSDK.js";
import { Logger } from "../../utils/index.js";
import { SdkApiError, GetTransactionsHistoryOpts } from "../../types/index.js";

/**
 * Controller class that handles HTTP requests for Fireblocks operations.
 *
 * This controller serves as the interface between Express routes and the SdkManager,
 * handling the four core operations:
 * 1. Get vault account address
 * 2. Get vault account addresses
 * 3. Submit transaction
 * 4. Get transaction history
 *
 * @class ApiController
 * @example
 * ```typescript
 * const sdkManager = new SdkManager(config);
 * const controller = new ApiController(sdkManager);
 *
 * app.use('/api', controller.getRouter());
 * ```
 */
export class ApiController {
  private sdk: MainSDK;
  private readonly logger = new Logger("api:controller");

  /**
   * Creates an instance of ApiController.
   *
   * @param sdk - The MainSDK instance to use for SDK operations
   */
  constructor(sdk: MainSDK) {
    this.sdk = sdk;
  }

  /**
   * Get a specific vault account address
   *
   * Route: `GET /vaults/:vaultAccountId/addresses/:assetId`
   * @param req.params.vaultAccountId - The vault account ID
   * @param req.params.assetId - The asset ID (e.g., 'BTC', 'ETH')
   * @param req.query.index - Optional address index (defaults to 0)
   */
  public getVaultAccountAddress = async (req: Request, res: Response) => {
    const { vaultAccountId, assetId } = req.params;
    const index = req.query.index ? parseInt(req.query.index as string) : 0;

    try {
      this.logger.info(
        `Getting address for vault ${vaultAccountId}, asset ${assetId}, index ${index}`
      );

      const result = await this.sdk.getVaultAccountAddress(vaultAccountId, assetId, index);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: unknown) {
      this.handleError(error, res, "getVaultAccountAddress");
    }
  };

  /**
   * Get all vault account addresses for a specific asset
   *
   * Route: `GET /vaults/:vaultAccountId/addresses/:assetId/all`
   */
  public getVaultAccountAddresses = async (req: Request, res: Response) => {
    const { vaultAccountId, assetId } = req.params;

    try {
      this.logger.info(`Getting all addresses for vault ${vaultAccountId}, asset ${assetId}`);

      const result = await this.sdk.getVaultAccountAddresses(vaultAccountId, assetId);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: unknown) {
      this.handleError(error, res, "getVaultAccountAddresses");
    }
  };

  /**
   * Submit a transaction through Fireblocks
   *
   * Route: `POST /vaults/:vaultAccountId/transactions`
   * @param req.body.transactionRequest - The Fireblocks transaction request
   * @param req.body.waitForCompletion - Optional, whether to wait for completion (default: true)
   */
  public submitTransaction = async (req: Request, res: Response) => {
    const { vaultAccountId } = req.params;
    const { transactionRequest, waitForCompletion = true } = req.body;

    try {
      this.logger.info(
        `Submitting transaction for vault ${vaultAccountId}, operation: ${transactionRequest.operation}`
      );

      const result = await this.sdk.submitTransaction(
        vaultAccountId,
        transactionRequest,
        waitForCompletion
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: unknown) {
      this.handleError(error, res, "submitTransaction");
    }
  };

  /**
   * Get transaction history
   *
   * Route: `GET /vaults/:vaultAccountId/transactions`
   * @param req.query.assetId - Optional asset ID filter
   * @param req.query.limit - Optional limit on results
   * @param req.query.offset - Optional offset for pagination
   * @param req.query.status - Optional status filter
   * @param req.query.startDate - Optional start date (ISO 8601)
   * @param req.query.endDate - Optional end date (ISO 8601)
   */
  public getTransactionsHistory = async (req: Request, res: Response) => {
    const { vaultAccountId } = req.params;
    const { assetId, limit, offset, status, startDate, endDate } =
      req.query as unknown as GetTransactionsHistoryOpts;

    try {
      this.logger.info(`Getting transaction history for vault ${vaultAccountId}`);

      const params: GetTransactionsHistoryOpts = {
        ...(assetId && { assetId }),
        ...(limit && { limit }),
        ...(offset !== undefined && { offset }),
        ...(status && { status }),
        ...(startDate && { startDate }),
        ...(endDate && { endDate }),
      };

      const result = await this.sdk.getTransactionsHistory(vaultAccountId, params);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: unknown) {
      this.handleError(error, res, "getTransactionsHistory");
    }
  };

  /**
   * Handles errors that occur during API operations.
   *
   * This private method provides centralized error handling, distinguishing between
   * SdkApiError instances (which have structured error information) and generic
   * errors. It logs the error details and sends an appropriate HTTP response.
   *
   * @param error - The error that occurred
   * @param res - Express response object
   * @param endpoint - The name of the endpoint where the error occurred (for logging)
   * @returns void
   *
   * @remarks
   * For SdkApiError instances, returns a structured JSON response with statusCode,
   * errorType, service, message, and additional error info.
   * For generic errors, returns a 500 status with a simple error message.
   */
  private handleError(error: unknown, res: Response, endpoint: string): void {
    if (error instanceof SdkApiError) {
      const statusCode = error.statusCode || 500;

      this.logger.error(`${endpoint} - SdkApiError:`, {
        statusCode: error.statusCode,
        errorType: error.errorType,
        service: error.service,
        message: error.message,
      });

      res.status(statusCode).json({
        success: false,
        error: error.message,
        statusCode: error.statusCode,
        type: error.errorType,
        info: error.errorInfo,
        service: error.service,
      });
    } else {
      const message = error instanceof Error ? error.message : "Unknown error";

      // Check if this is a client error from Fireblocks SDK
      // These indicate invalid input that passed Zod validation but was rejected by Fireblocks
      const isClientError =
        message.includes("is not supported by Fireblocks") ||
        message.includes("Invalid request") ||
        message.includes("should match format") ||
        message.includes("Validation failed") ||
        message.includes("Invalid") ||
        message.includes("required");

      const statusCode = isClientError ? 400 : 500;

      if (isClientError) {
        this.logger.warn(`${endpoint} - Client Error:`, message);
      } else {
        this.logger.error(`${endpoint} - Server Error:`, message);
      }

      res.status(statusCode).json({
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      });
    }
  }
}
