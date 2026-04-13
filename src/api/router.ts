import { Router } from "express";
import { MainSDK } from "../MainSDK.js";
import { ApiController } from "./controllers/controller.js";
import { validate, contractsQuery, transferBody, txHashParam } from "./validation/index.js";
import { z } from "zod";

/** Validates `:vaultId` path param - numeric string */
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
 */
export const configureRouter = (sdk: MainSDK): Router => {
  const router = Router();
  const controller = new ApiController(sdk);

  // ─── Contract info ─────────────────────────────────────────────────────

  /**
   * @openapi
   * /api/contracts/{contractAddress}:
   *   get:
   *     tags: [Contracts]
   *     summary: Get ERC-20 token metadata (name, symbol, decimals, totalSupply)
   *     parameters:
   *       - in: path
   *         name: contractAddress
   *         required: true
   *         schema:
   *           type: string
   *         example: "0xb0d4afd8879ed9f52b28595d31b441d079b2ca07"
   *     responses:
   *       200:
   *         description: Token metadata
   *       400:
   *         description: Invalid contract address
   */
  router.get(
    "/contracts/:contractAddress",
    validate({
      params: z.object({
        contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "invalid address"),
      }),
    }),
    controller.getContractInfo
  );

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
   * /api/{vaultId}/src20/register-key:
   *   post:
   *     tags: [SRC-20]
   *     summary: Register the vault's AES viewing key in the Seismic Directory precompile
   *     description: |
   *       One-time operation per vault address. After registration, all incoming SRC-20
   *       Transfer events will have `encryptedAmount` encrypted to this vault's viewing key.
   *     parameters:
   *       - in: path
   *         name: vaultId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Viewing key registered
   *       400:
   *         description: Invalid vaultId
   */
  router.post(
    "/:vaultId/src20/register-key",
    validate({ params: vaultIdParam }),
    controller.registerViewingKey
  );

  /**
   * @openapi
   * /api/{vaultId}/src20/key-status:
   *   get:
   *     tags: [SRC-20]
   *     summary: Check if the vault has a viewing key registered in the Seismic Directory
   *     parameters:
   *       - in: path
   *         name: vaultId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Registration status
   *       400:
   *         description: Invalid vaultId
   */
  router.get(
    "/:vaultId/src20/key-status",
    validate({ params: vaultIdParam }),
    controller.checkViewingKeyStatus
  );

  /**
   * @openapi
   * /api/{vaultId}/transactions:
   *   get:
   *     tags: [Transaction History]
   *     summary: Get ERC-20/SRC-20 Transfer event history for a vault's Seismic address
   *     description: |
   *       Returns transaction history for the vault's Seismic address.
   *
   *       **`type` parameter controls which asset class is fetched:**
   *       - `erc20` (default) - standard ERC-20 Transfer events. Uses SocialScan `tokentx` if
   *         `SOCIALSCAN_API_KEY` is set, otherwise falls back to `eth_getLogs` (last 99k blocks).
   *       - `native` - native ETH transfers. **Requires `SOCIALSCAN_API_KEY`** (ETH transfers
   *         produce no logs on any EVM chain; only the explorer indexes them).
   *       - `src20` - Seismic SRC-20 Transfer events.
   *       - `all` - native + ERC-20 merged. **Requires `SOCIALSCAN_API_KEY`** for native portion.
   *     parameters:
   *       - in: path
   *         name: vaultId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: type
   *         schema:
   *           type: string
   *           enum: [native, erc20, src20, all]
   *           default: erc20
   *         description: Asset type to fetch (see description above).
   *       - in: query
   *         name: fromBlock
   *         schema:
   *           type: string
   *         description: Start block (hex). Only used for eth_getLogs fallback; ignored when using explorer.
   *       - in: query
   *         name: toBlock
   *         schema:
   *           type: string
   *         description: End block (hex). Only used for eth_getLogs fallback; ignored when using explorer.
   *       - in: query
   *         name: contracts
   *         schema:
   *           type: string
   *         description: Comma-separated contract addresses to filter by. Required for type=src20.
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           default: 50
   *         description: Maximum number of results to return per page.
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *           default: 0
   *         description: Number of results to skip (for pagination).
   *     responses:
   *       200:
   *         description: List of Transfer events with pagination metadata
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   type: array
   *                 meta:
   *                   type: object
   *                   properties:
   *                     count:
   *                       type: integer
   *                       description: Number of items in this page
   *                     total:
   *                       type: integer
   *                       description: Total matching items across all pages
   *                     limit:
   *                       type: integer
   *                     offset:
   *                       type: integer
   *                     hasMore:
   *                       type: boolean
   *                       description: True if there are more pages after this one
   *                     source:
   *                       type: string
   *       400:
   *         description: Invalid parameters
   */
  router.get(
    "/:vaultId/transactions",
    validate({ params: vaultIdParam }),
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
   *       - `ETH` - native coin transfer
   *       - `ERC20` - standard ERC-20 token transfer (requires `contractAddress`)
   *       - `SRC20` - Seismic shielded token transfer with encrypted calldata (requires `contractAddress`)
   *
   *       **Destination (exactly one required):**
   *       - `recipient` - a direct EVM address (`0x...`)
   *       - `destinationVaultId` - a Fireblocks vault ID; its Seismic address is resolved automatically
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
   *               decimals:
   *                 type: integer
   *                 description: Token decimals. Defaults to 18.
   *                 example: 18
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
   *             ERC20 to vault:
   *               value:
   *                 type: ERC20
   *                 destinationVaultId: "1"
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

  return router;
};
