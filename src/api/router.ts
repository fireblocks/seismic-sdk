import { Router } from "express";
import { MainSDK } from "../MainSDK.js";
import { ApiController } from "./controllers/controller.js";
import {
  validate,
  vaultAndAssetParams,
  vaultParams,
  indexQuery,
  transactionHistoryQuery,
  submitTransactionBody,
} from "./validation/index.js";

/**
 * Creates and configures an Express router with RESTful API endpoints.
 *
 * This sets up routes for the four core Fireblocks operations:
 * 1. Get a specific vault account address
 * 2. Get all vault account addresses for an asset
 * 3. Submit a transaction
 * 4. Get transaction history
 *
 * @param sdkManager - The SdkManager instance to use for handling requests
 * @returns Configured Express router
 */
export const configureRouter = (sdk: MainSDK): Router => {
  const router = Router();
  const controller = new ApiController(sdk);

  /**
   * @route GET /vaults/:vaultAccountId/addresses/:assetId
   * @description Get a specific vault account address
   */
  router.get(
    "/vaults/:vaultAccountId/addresses/:assetId",
    validate({
      params: vaultAndAssetParams,
      query: indexQuery,
    }),
    controller.getVaultAccountAddress
  );

  /**
   * @route GET /vaults/:vaultAccountId/addresses/:assetId/all
   * @description Get all vault account addresses for a specific asset
   */
  router.get(
    "/vaults/:vaultAccountId/addresses/:assetId/all",
    validate({
      params: vaultAndAssetParams,
    }),
    controller.getVaultAccountAddresses
  );

  /**
   * @route GET /vaults/:vaultAccountId/transactions
   * @description Get transaction history for a vault account
   */
  router.get(
    "/vaults/:vaultAccountId/transactions",
    validate({
      params: vaultParams,
      query: transactionHistoryQuery,
    }),
    controller.getTransactionsHistory
  );

  /**
   * @route POST /vaults/:vaultAccountId/transactions
   * @description Submit a transaction through Fireblocks
   */
  router.post(
    "/vaults/:vaultAccountId/transactions",
    validate({
      params: vaultParams,
      body: submitTransactionBody,
    }),
    controller.submitTransaction
  );

  return router;
};
