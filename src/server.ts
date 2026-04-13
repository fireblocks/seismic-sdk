import { fileURLToPath } from "url";
import path, { dirname } from "path";
import { BasePath } from "@fireblocks/ts-sdk";
import express, { Request, Response } from "express";

import { config, Logger, getSwaggerSpec, swaggerUi } from "./utils/index.js";
import { MainSDK } from "./MainSDK.js";
import { configureRouter } from "./api/router.js";

const logger = new Logger("app:server-setup");

const startServer = () => {
  // Validate required environment variables
  (() => {
    ["FIREBLOCKS_API_USER_KEY", "FIREBLOCKS_API_USER_SECRET_KEY_PATH"].forEach((key) => {
      if (process.env[key] === undefined || process.env[key] === "") {
        throw new Error(`Missing required environment variable: ${key}`);
      }
    });
  })();

  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(errorHandler);

  // Initialize a single shared SDK instance
  const sdk = new MainSDK({
    apiKey: config.FIREBLOCKS.apiKey || "",
    apiSecret: config.FIREBLOCKS.secretKey || "",
    basePath: (config.FIREBLOCKS.basePath as BasePath) || BasePath.US,
    testnet: config.TESTNET,
  });

  // Mount API routes
  app.use("/api", configureRouter(sdk));

  /**
   * @openapi
   * /health:
   *   get:
   *     tags:
   *       - Health
   *     summary: Health check
   *     description: Returns 200 when the server is up and running.
   *     responses:
   *       200:
   *         description: Server is alive
   *         content:
   *           text/plain:
   *             schema:
   *               type: string
   *               example: Alive
   */
  app.get("/health", (_req: Request, res: Response) => {
    logger.info("alive");
    res.status(200).send("Alive");
  });

  // Swagger documentation endpoints
  const swaggerSpec = getSwaggerSpec();
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get("/api-docs-json", (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.send(swaggerSpec);
  });

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  app.use("/docs", express.static(path.join(__dirname, "../docs")));

  app.listen(config.PORT, () => {
    logger.info(`${config.APP_NAME} listening on port ${config.PORT}`);
  });
};

const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: "Internal server error" });
};

export default startServer;
