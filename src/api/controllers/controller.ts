import { Request, Response } from "express";
import { MainSDK } from "../../MainSDK.js";
import { Logger } from "../../utils/index.js";
import { SdkApiError } from "../../types/index.js";

export class ApiController {
  private sdk: MainSDK;
  private readonly logger = new Logger("api:controller");

  constructor(sdk: MainSDK) {
    this.sdk = sdk;
  }

  // ─── Seismic routes ──────────────────────────────────────────────────────

  /**
   * GET /api/:vaultId/address
   * Returns the vault's Seismic/ETH address derived from its MPC public key.
   */
  public getAddress = async (req: Request, res: Response) => {
    const { vaultId } = req.params;
    try {
      const address = await this.sdk.getSeismicAddress(vaultId);
      res.status(200).json({ success: true, data: { vaultId, address } });
    } catch (error) {
      this.handleError(error, res, "getAddress");
    }
  };

  /**
   * GET /api/:vaultId/public-key
   * Returns the vault's compressed secp256k1 MPC public key.
   */
  public getPublicKey = async (req: Request, res: Response) => {
    const { vaultId } = req.params;
    try {
      const publicKey = await this.sdk.getVaultPublicKey(vaultId);
      res.status(200).json({ success: true, data: { vaultId, publicKey } });
    } catch (error) {
      this.handleError(error, res, "getPublicKey");
    }
  };

  /**
   * GET /api/:vaultId/balance
   * Returns the vault's native ETH balance on Seismic.
   */
  public getBalance = async (req: Request, res: Response) => {
    const { vaultId } = req.params;
    try {
      const result = await this.sdk.getBalance(vaultId);
      res.status(200).json(result);
    } catch (error) {
      this.handleError(error, res, "getBalance");
    }
  };

  /**
   * GET /api/:vaultId/erc20-balances?contracts=0x...
   * Returns plaintext ERC-20 balances for a list of contracts.
   */
  public getErc20Balances = async (req: Request, res: Response) => {
    const { vaultId } = req.params;
    const raw = req.query.contracts;
    const contracts = Array.isArray(raw)
      ? (raw as string[])
      : (raw as string).split(",").map((s) => s.trim());
    try {
      const balances = await this.sdk.getErc20Balances(vaultId, contracts);
      res.status(200).json({ success: true, data: balances });
    } catch (error) {
      this.handleError(error, res, "getErc20Balances");
    }
  };

  /**
   * GET /api/:vaultId/src20-balances?contracts=0x...
   * Returns SRC-20 shielded balances using Fireblocks-signed reads.
   */
  public getSrc20Balances = async (req: Request, res: Response) => {
    const { vaultId } = req.params;
    const raw = req.query.contracts;
    const contracts = Array.isArray(raw)
      ? (raw as string[])
      : (raw as string).split(",").map((s) => s.trim());
    try {
      const balances = await Promise.all(
        contracts.map(async (contractAddress) => {
          const result = await this.sdk.getSrc20Balance(vaultId, contractAddress);
          return { contractAddress, ...result };
        })
      );
      res.status(200).json({ success: true, data: balances });
    } catch (error) {
      this.handleError(error, res, "getSrc20Balances");
    }
  };

  /**
   * GET /api/:vaultId/transactions?limit=N&offset=N
   * Returns transaction history for the vault.
   */
  public getTransactionHistory = async (req: Request, res: Response) => {
    const { vaultId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : undefined;
    const order = req.query.order as "ASC" | "DESC" | undefined;
    try {
      const result = await this.sdk.getTransactionHistory(vaultId, { limit, offset, order });
      res.status(200).json(result);
    } catch (error) {
      this.handleError(error, res, "getTransactionHistory");
    }
  };

  /**
   * GET /api/:vaultId/transactions/:txHash
   * Returns details for a single transaction.
   */
  public getTransaction = async (req: Request, res: Response) => {
    const { vaultId, txHash } = req.params;
    try {
      res.status(200).json({
        success: true,
        data: { vaultId, txHash, note: "Individual transaction lookup not yet implemented" },
      });
    } catch (error) {
      this.handleError(error, res, "getTransaction");
    }
  };

  /**
   * POST /api/:vaultId/transfer
   * Submits an ETH, ERC-20, or SRC-20 (shielded) transfer.
   */
  public transfer = async (req: Request, res: Response) => {
    const { vaultId } = req.params;
    const { type, recipient, destinationVaultId, amount, contractAddress, note } = req.body as {
      type: "ETH" | "ERC20" | "SRC20";
      recipient?: string;
      destinationVaultId?: string;
      amount: number;
      contractAddress?: string;
      note?: string;
    };
    try {
      const to = destinationVaultId
        ? await this.sdk.getSeismicAddress(destinationVaultId)
        : recipient!;

      let result;
      if (type === "SRC20") {
        result = await this.sdk.createShieldedTransaction(
          vaultId,
          to,
          amount,
          contractAddress!,
          note
        );
      } else if (type === "ERC20") {
        result = await this.sdk.createFTTransaction(vaultId, to, amount, "SRC20" as never, note);
      } else {
        result = await this.sdk.createNativeTransaction(vaultId, to, amount, false, note);
      }
      res.status(200).json(result);
    } catch (error) {
      this.handleError(error, res, "transfer");
    }
  };

  // ─── Error handling ──────────────────────────────────────────────────────────

  private handleError(error: unknown, res: Response, endpoint: string): void {
    if (error instanceof SdkApiError) {
      this.logger.error(`${endpoint} - SdkApiError:`, {
        statusCode: error.statusCode,
        errorType: error.errorType,
        service: error.service,
        message: error.message,
      });
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message,
        statusCode: error.statusCode,
        type: error.errorType,
        info: error.errorInfo,
        service: error.service,
      });
    } else {
      const message = error instanceof Error ? error.message : "Unknown error";
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
      res.status(statusCode).json({ success: false, error: message });
    }
  }
}
