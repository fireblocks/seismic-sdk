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
   * GET /api/:vaultId/native-balance
   * Returns the vault's native ETH balance on Seismic.
   */
  public getNativeBalance = async (req: Request, res: Response) => {
    const { vaultId } = req.params;
    try {
      const balance = await this.sdk.getNativeBalance(vaultId);
      res.status(200).json({ success: true, balance });
    } catch (error) {
      this.handleError(error, res, "getNativeBalance");
    }
  };

  /**
   * GET /api/:vaultId/token-balances?type=erc20|src20|all&contracts=0x...
   * Returns ERC-20 and/or SRC-20 token balances. Contracts are optional - omitting
   * them triggers auto-discovery. When type=all, each type fails independently:
   * the response is always 200 with whatever succeeded, plus error fields for what failed.
   */
  public getTokenBalances = async (req: Request, res: Response) => {
    const { vaultId } = req.params;
    const { type, contracts: rawContracts } = req.query as {
      type?: string;
      contracts?: string | string[];
    };
    const contracts = rawContracts
      ? Array.isArray(rawContracts)
        ? rawContracts
        : rawContracts.split(",").map((s) => s.trim())
      : undefined;
    try {
      const data = await this.sdk.getTokenBalances(
        vaultId,
        (type as "erc20" | "src20" | "all") ?? "all",
        contracts
      );
      // Partial failures in type=all are already encoded in data.erc20Error / data.src20Error.
      // We return 200 so callers can use whatever did succeed.
      res.status(200).json({ success: true, data });
    } catch (error) {
      this.handleError(error, res, "getTokenBalances");
    }
  };

  /**
   * GET /api/:vaultId/transactions
   * Returns ERC-20/SRC-20 Transfer event history for the vault's Seismic address.
   */
  public getTransactionHistory = async (req: Request, res: Response) => {
    const { vaultId } = req.params;
    const { type, fromBlock, toBlock, before, after, contracts, limit, offset } =
      req.query as Record<string, string>;
    try {
      const contractList = contracts
        ? Array.isArray(contracts)
          ? (contracts as string[])
          : contracts.split(",").map((s) => s.trim())
        : undefined;
      const parsedLimit = limit !== undefined ? parseInt(limit) : 50;
      const parsedOffset = offset !== undefined ? parseInt(offset) : 0;
      const result = await this.sdk.getTransactionHistory({
        vaultId,
        type: (type as "native" | "erc20" | "src20" | "all") ?? "all",
        fromBlock,
        toBlock,
        before,
        after,
        contracts: contractList,
        limit: parsedLimit,
        offset: parsedOffset,
      });
      const transactions = result.transactions;
      const total = result.total;
      res.status(200).json({
        success: true,
        data: transactions,
        meta: {
          source: result.source,
          scannedFromBlock: result.fromBlock,
          scannedToBlock: result.toBlock,
          count: transactions.length,
          total,
          limit: parsedLimit,
          offset: parsedOffset,
          hasMore: parsedOffset + transactions.length < total,
          ...(result.warning && { warning: result.warning }),
        },
      });
    } catch (error) {
      this.handleError(error, res, "getTransactionHistory");
    }
  };

  /**
   * GET /api/:vaultId/transactions/:txHash
   * Returns a transaction by hash from the Seismic RPC.
   */
  public getTransaction = async (req: Request, res: Response) => {
    const { txHash } = req.params;
    try {
      const data = await this.sdk.getTransactionByHash(txHash);
      if (!data) {
        res.status(404).json({ success: false, error: `Transaction ${txHash} not found` });
        return;
      }
      res.status(200).json({ success: true, data });
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
    const { type, recipient, destinationVaultId, amount, contractAddress, decimals, note } =
      req.body as {
        type: "ETH" | "ERC20" | "SRC20";
        recipient?: string;
        destinationVaultId?: string;
        amount: string;
        contractAddress?: string;
        decimals?: number;
        note?: string;
      };

    // Validate required parameters
    if (!destinationVaultId && !recipient) {
      res.status(400).json({
        success: false,
        error: "Either recipient or destinationVaultId must be provided",
      });
      return;
    }

    if ((type === "ERC20" || type === "SRC20") && !contractAddress) {
      res.status(400).json({
        success: false,
        error: `contractAddress is required for ${type} transfers`,
      });
      return;
    }

    try {
      const to = destinationVaultId
        ? await this.sdk.getSeismicAddress(destinationVaultId)
        : (recipient as string);

      let result;
      if (type === "SRC20") {
        result = await this.sdk.createShieldedTransaction(
          vaultId,
          to,
          amount,
          contractAddress as string,
          note
        );
      } else if (type === "ERC20") {
        result = await this.sdk.createErc20Transaction(
          vaultId,
          to,
          amount,
          contractAddress as string,
          decimals,
          note
        );
      } else {
        result = await this.sdk.createNativeTransaction(vaultId, to, amount, false, note);
      }
      res.status(200).json({ success: true, txHash: result.txHash });
    } catch (error) {
      this.handleError(error, res, "transfer");
    }
  };

  /**
   * POST /api/:vaultId/src20/register-key
   * Registers the vault's AES viewing key in the Seismic Directory precompile.
   * One-time operation. After registration, Transfer events are encrypted to this key.
   */
  public registerViewingKey = async (req: Request, res: Response) => {
    const { vaultId } = req.params;
    try {
      const result = await this.sdk.registerViewingKey(vaultId);
      res.status(200).json({ success: true, txHash: result.txHash });
    } catch (error) {
      this.handleError(error, res, "registerViewingKey");
    }
  };

  /**
   * GET /api/:vaultId/src20/key-status
   * Returns whether the vault has a viewing key registered in the Seismic Directory.
   */
  public checkViewingKeyStatus = async (req: Request, res: Response) => {
    const { vaultId } = req.params;
    try {
      const registered = await this.sdk.checkViewingKeyRegistered(vaultId);
      res.status(200).json({ success: true, data: { vaultId, registered } });
    } catch (error) {
      this.handleError(error, res, "checkViewingKeyStatus");
    }
  };

  /**
   * GET /api/contracts/:contractAddress
   * Returns ERC-20 metadata: name, symbol, decimals, totalSupply.
   */
  public getContractInfo = async (req: Request, res: Response) => {
    const { contractAddress } = req.params;
    try {
      const data = await this.sdk.getErc20Info(contractAddress);
      res.status(200).json({ success: true, data: { contractAddress, ...data } });
    } catch (error) {
      this.handleError(error, res, "getContractInfo");
    }
  };

  /**
   * POST /api/explorer/validate-key
   * Validates a SocialScan Explorer API key provided in the request body.
   */
  public validateExplorerApiKey = async (req: Request, res: Response) => {
    const { apiKey } = req.body as { apiKey?: string };
    if (!apiKey) {
      res.status(400).json({ success: false, error: "apiKey is required in request body" });
      return;
    }
    try {
      const result = await this.sdk.validateExplorerApiKey(apiKey);
      const statusCodeMap: Record<string, number> = {
        valid: 200,
        invalid_key: 401,
        service_error: 502,
      };
      const statusCode = statusCodeMap[result.status] ?? 500;
      res.status(statusCode).json({ success: result.valid, data: result });
    } catch (error) {
      this.handleError(error, res, "validateExplorerApiKey");
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
      res.status(statusCode).json({
        success: false,
        error: isClientError ? message : "Internal server error",
      });
    }
  }
}
