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
  contractsQuery,
  transferBody,
  txHashParam,
} from "./validation/index.js";
import { z } from "zod";

/** Validates `:vaultId` path param — numeric string */
const vaultIdParam = z.object({
  vaultId: z.string().min(1, "vaultId is required").regex(/^\d+$/, "vaultId must be numeric"),
});

/**
 * Configures all API routes for the Seismic + Fireblocks SDK.
 *
 * HLD routes (all under /api):
 *   GET  /api/:vaultId/address
 *   GET  /api/:vaultId/public-key
 *   GET  /api/:vaultId/balance
 *   GET  /api/:vaultId/erc20-balances?contracts=0x...
 *   GET  /api/:vaultId/src20-balances?contracts=0x...
 *   GET  /api/:vaultId/transactions?limit=N&offset=N
 *   GET  /api/:vaultId/transactions/:txHash
 *   POST /api/:vaultId/transfer
 *   GET  /api/metrics
 *
 * Legacy Fireblocks routes are preserved for backwards compatibility.
 */
export const configureRouter = (sdk: MainSDK): Router => {
  const router = Router();
  const controller = new ApiController(sdk);

  // ─── Seismic routes ────────────────────────────────────────────────────

  /**
   * @openapi
   * /api/{vaultId}/address:
   *   get:
   *     tags: [Vault]
   *     summary: Get vault Seismic/ETH address derived from its MPC public key
   *     parameters:
   *       - in: path
   *         name: vaultId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Vault address
   *       400:
   *         description: Invalid vaultId
   */
  router.get("/:vaultId/address", validate({ params: vaultIdParam }), controller.getAddress);

  /**
   * @openapi
   * /api/{vaultId}/public-key:
   *   get:
   *     tags: [Vault]
   *     summary: Get vault compressed secp256k1 MPC public key
   *     parameters:
   *       - in: path
   *         name: vaultId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Public key
   *       400:
   *         description: Invalid vaultId
   */
  router.get("/:vaultId/public-key", validate({ params: vaultIdParam }), controller.getPublicKey);

  /**
   * @openapi
   * /api/{vaultId}/balance:
   *   get:
   *     tags: [Balance]
   *     summary: Get vault native ETH balance on Seismic
   *     parameters:
   *       - in: path
   *         name: vaultId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Native balance
   *       400:
   *         description: Invalid vaultId
   */
  router.get("/:vaultId/balance", validate({ params: vaultIdParam }), controller.getBalance);

  /**
   * @openapi
   * /api/{vaultId}/erc20-balances:
   *   get:
   *     tags: [Balance]
   *     summary: Get plaintext ERC-20 balances for a list of contracts
   *     parameters:
   *       - in: path
   *         name: vaultId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: contracts
   *         required: true
   *         style: form
   *         explode: true
   *         schema:
   *           type: array
   *           items:
   *             type: string
   *     responses:
   *       200:
   *         description: ERC-20 balances
   *       400:
   *         description: Invalid parameters
   */
  router.get(
    "/:vaultId/erc20-balances",
    validate({ params: vaultIdParam, query: contractsQuery }),
    controller.getErc20Balances
  );

  /**
   * @openapi
   * /api/{vaultId}/src20-balances:
   *   get:
   *     tags: [Balance]
   *     summary: Get SRC-20 shielded balances using Fireblocks-signed reads
   *     parameters:
   *       - in: path
   *         name: vaultId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: contracts
   *         required: true
   *         style: form
   *         explode: true
   *         schema:
   *           type: array
   *           items:
   *             type: string
   *     responses:
   *       200:
   *         description: SRC-20 shielded balances
   *       400:
   *         description: Invalid parameters
   */
  router.get(
    "/:vaultId/src20-balances",
    validate({ params: vaultIdParam, query: contractsQuery }),
    controller.getSrc20Balances
  );

  /**
   * @openapi
   * /api/{vaultId}/transactions:
   *   get:
   *     tags: [Transaction History]
   *     summary: Get transaction history for a vault
   *     parameters:
   *       - in: path
   *         name: vaultId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *       - in: query
   *         name: order
   *         schema:
   *           type: string
   *           enum: [ASC, DESC]
   *     responses:
   *       200:
   *         description: Transaction list
   *       400:
   *         description: Invalid parameters
   */
  router.get(
    "/:vaultId/transactions",
    validate({ params: vaultIdParam, query: transactionHistoryQuery }),
    controller.getTransactionHistory
  );

  /**
   * @openapi
   * /api/{vaultId}/transactions/{txHash}:
   *   get:
   *     tags: [Transaction History]
   *     summary: Get a single transaction by hash
   *     parameters:
   *       - in: path
   *         name: vaultId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: txHash
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Transaction details
   *       400:
   *         description: Invalid parameters
   */
  router.get(
    "/:vaultId/transactions/:txHash",
    validate({ params: vaultIdParam.merge(txHashParam) }),
    controller.getTransaction
  );

  /**
   * @openapi
   * /api/{vaultId}/transfer:
   *   post:
   *     tags: [Transfers]
   *     summary: Submit a transfer from a vault
   *     description: |
   *       Transfers assets from the given vault to a destination.
   *
   *       **Transfer types:**
   *       - `ETH` — native coin transfer
   *       - `ERC20` — standard ERC-20 token transfer (requires `contractAddress`)
   *       - `SRC20` — Seismic shielded token transfer with encrypted calldata (requires `contractAddress`)
   *
   *       **Destination (exactly one required):**
   *       - `recipient` — a direct EVM address (`0x...`)
   *       - `destinationVaultId` — a Fireblocks vault ID; its Seismic address is resolved automatically
   *     parameters:
   *       - in: path
   *         name: vaultId
   *         required: true
   *         description: Source Fireblocks vault account ID
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [type, amount]
   *             properties:
   *               type:
   *                 type: string
   *                 enum: [ETH, ERC20, SRC20]
   *                 description: |
   *                   Asset type to transfer:
   *                   - `ETH`: native coin
   *                   - `ERC20`: standard token (requires contractAddress)
   *                   - `SRC20`: Seismic shielded token (requires contractAddress)
   *               recipient:
   *                 type: string
   *                 description: Destination EVM address. Mutually exclusive with destinationVaultId.
   *                 example: "0xd07afc9df1333f577ee83f92250dc854b227720f"
   *               destinationVaultId:
   *                 type: string
   *                 description: Destination Fireblocks vault ID. Its Seismic address is resolved automatically. Mutually exclusive with recipient.
   *                 example: "1"
   *               amount:
   *                 type: number
   *                 description: Amount to transfer in whole units (e.g. 0.5 for 0.5 ETH)
   *                 example: 0.5
   *               contractAddress:
   *                 type: string
   *                 description: Token contract address. Required for ERC20 and SRC20 transfers.
   *                 example: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
   *               note:
   *                 type: string
   *                 description: Optional label attached to the Fireblocks signing request
   *           examples:
   *             ETH to address:
   *               value:
   *                 type: ETH
   *                 recipient: "0xd07afc9df1333f577ee83f92250dc854b227720f"
   *                 amount: 0.5
   *             ETH to vault:
   *               value:
   *                 type: ETH
   *                 destinationVaultId: "1"
   *                 amount: 0.5
   *             ERC20 to address:
   *               value:
   *                 type: ERC20
   *                 recipient: "0xd07afc9df1333f577ee83f92250dc854b227720f"
   *                 amount: 10
   *                 contractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
   *             SRC20 shielded to vault:
   *               value:
   *                 type: SRC20
   *                 destinationVaultId: "1"
   *                 amount: 5
   *                 contractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
   *     responses:
   *       200:
   *         description: Transfer submitted successfully
   *       400:
   *         description: Invalid request body
   */
  router.post(
    "/:vaultId/transfer",
    validate({ params: vaultIdParam, body: transferBody }),
    controller.transfer
  );

  // ─── Fireblocks routes ──────────────────────────────────────────────

  /**
   * @openapi
   * /api/vaults/{vaultAccountId}/addresses/{assetId}:
   *   get:
   *     tags: [Vault]
   *     summary: (Legacy) Get vault address for an asset at a derivation index
   *     parameters:
   *       - in: path
   *         name: vaultAccountId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: assetId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: index
   *         schema:
   *           type: integer
   *           default: 0
   *     responses:
   *       200:
   *         description: Vault address
   */
  router.get(
    "/vaults/:vaultAccountId/addresses/:assetId",
    validate({ params: vaultAndAssetParams, query: indexQuery }),
    controller.getVaultAccountAddress
  );

  /**
   * @openapi
   * /api/vaults/{vaultAccountId}/addresses/{assetId}/all:
   *   get:
   *     tags: [Vault]
   *     summary: (Legacy) Get all addresses for a vault asset
   *     parameters:
   *       - in: path
   *         name: vaultAccountId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: assetId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: All vault addresses
   */
  router.get(
    "/vaults/:vaultAccountId/addresses/:assetId/all",
    validate({ params: vaultAndAssetParams }),
    controller.getVaultAccountAddresses
  );

  /**
   * @openapi
   * /api/vaults/{vaultAccountId}/transactions:
   *   get:
   *     tags: [Transaction History]
   *     summary: (Legacy) Get transaction history for a vault account
   *     parameters:
   *       - in: path
   *         name: vaultAccountId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: assetId
   *         schema:
   *           type: string
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *       - in: query
   *         name: startDate
   *         schema:
   *           type: string
   *       - in: query
   *         name: endDate
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Transaction history
   *   post:
   *     tags: [Transfers]
   *     summary: (Legacy) Submit a transaction
   *     parameters:
   *       - in: path
   *         name: vaultAccountId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               transactionRequest:
   *                 type: object
   *               waitForCompletion:
   *                 type: boolean
   *                 default: true
   *     responses:
   *       200:
   *         description: Transaction result
   */
  router.get(
    "/vaults/:vaultAccountId/transactions",
    validate({ params: vaultParams, query: transactionHistoryQuery }),
    controller.getTransactionsHistory
  );

  router.post(
    "/vaults/:vaultAccountId/transactions",
    validate({ params: vaultParams, body: submitTransactionBody }),
    controller.submitTransaction
  );

  return router;
};
