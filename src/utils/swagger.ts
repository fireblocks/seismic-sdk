import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import { config } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache the swagger spec after first creation
let cachedSwaggerSpec: ReturnType<typeof swaggerJsdoc> | null = null;

/**
 * Get or create the swagger specification
 * Lazy loads on first access
 */
export const getSwaggerSpec = (): ReturnType<typeof swaggerJsdoc> => {
  if (!cachedSwaggerSpec) {
    const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));

    const options = {
      definition: {
        openapi: "3.0.0",
        info: {
          title: `${config.APP_NAME} SDK API`,
          version: packageJson.version,
          description: `REST API for integrating Fireblocks MPC wallets with the Seismic privacy-preserving blockchain. Supports native ETH, ERC-20, and SRC-20 shielded token operations.`,
        },
        servers: [
          {
            url: `http://localhost:${config.PORT}/`,
            description: "Local server",
          },
        ],
        tags: [
          { name: "Health", description: "Service health check" },
          { name: "Vault", description: "Vault address and public key" },
          { name: "Balance", description: "Native and token balances" },
          { name: "SRC-20", description: "Seismic SRC-20 viewing key registration and status" },
          {
            name: "Transfers",
            description: "Submit ETH, ERC-20, or SRC-20 (shielded) transfers",
          },
          {
            name: "Transaction History",
            description: "Transfer event history with optional decrypted SRC-20 amounts",
          },
          { name: "Contracts", description: "ERC-20 token metadata" },
          { name: "Explorer", description: "SocialScan Explorer API key validation" },
          { name: "Metrics", description: "Prometheus metrics" },
        ],
      },
      apis: [
        "./dist/server.js",
        "./dist/api/router.js",
        "./dist/api/controllers/*.js",
        "./dist/routes/*.js",
      ],
    };

    cachedSwaggerSpec = swaggerJsdoc(options);
  }

  return cachedSwaggerSpec;
};

export { swaggerUi };
