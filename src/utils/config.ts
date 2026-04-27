import { readFileSync } from "fs";
import { BasePath } from "@fireblocks/ts-sdk";
import dotenv from "dotenv";
import { getPackageName } from "./index.js";
import { Config, CustomConfig } from "../types/index.js";
import { Logger } from "./logger.js";

const logger = new Logger("utils:config");

let configCache: Config | null = null;

const getSecretKey = (secretKeyPath?: string): string => {
  const path = secretKeyPath || process.env.FIREBLOCKS_API_USER_SECRET_KEY_PATH;

  if (!path) {
    throw new Error(
      "FIREBLOCKS_API_USER_SECRET_KEY_PATH environment variable or secretKeyPath parameter is required"
    );
  }

  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read secret key file at ${path}: ${error}`);
  }
};

const validateBasePath = (basePath: string): BasePath => {
  if (basePath && !Object.values(BasePath).includes(basePath as BasePath)) {
    logger.warn(
      `Invalid BASE_PATH: ${basePath}. Must be one of: ${Object.values(BasePath).join(", ")}`
    );
  }
  return (basePath as BasePath) || BasePath.US;
};

const loadConfigFromEnv = (): Config => {
  dotenv.config();

  return {
    PORT: Number(process.env.PORT) || 8000,
    FIREBLOCKS: {
      apiKey: process.env.FIREBLOCKS_API_USER_KEY || "",
      secretKey: getSecretKey(),
      basePath: validateBasePath(process.env.BASE_PATH || ""),
    },
    APP_NAME: getPackageName() || "Fireblocks SDK",
    TESTNET: process.env.NETWORK === "testnet",
  };
};

const mergeConfig = (customConfig: CustomConfig): Config => {
  const defaults: Config = {
    PORT: Number(process.env.PORT) || 8000,
    FIREBLOCKS: {
      apiKey: "",
      secretKey: "",
      basePath: BasePath.US,
    },
    APP_NAME: getPackageName() || "Fireblocks SDK",
    TESTNET: process.env.NETWORK === "testnet",
  };

  return {
    PORT: customConfig.PORT ?? defaults.PORT,
    FIREBLOCKS: {
      apiKey: customConfig.FIREBLOCKS?.apiKey ?? defaults.FIREBLOCKS.apiKey,
      secretKey: customConfig.FIREBLOCKS?.secretKey ?? defaults.FIREBLOCKS.secretKey,
      basePath: customConfig.FIREBLOCKS?.basePath ?? defaults.FIREBLOCKS.basePath,
    },
    APP_NAME: customConfig.APP_NAME ?? defaults.APP_NAME,
    TESTNET: customConfig.TESTNET ?? defaults.TESTNET,
  };
};

/**
 * Manually initialize config with custom values (for library usage).
 * Call this before accessing config if you want to provide custom configuration.
 */
export const initConfig = (customConfig?: CustomConfig): void => {
  if (configCache) {
    logger.warn("Config already initialized. Reinitializing with new values.");
  }

  if (customConfig) {
    configCache = mergeConfig(customConfig);
    logger.info("Config manually initialized with custom values");
  } else {
    configCache = loadConfigFromEnv();
    logger.info("Config initialized from environment variables");
  }
};

/**
 * Get the config object (lazy initialization from environment variables on first access).
 */
export const getConfig = (): Config => {
  if (!configCache) {
    logger.info("Lazy loading config from environment variables");
    configCache = loadConfigFromEnv();
  }
  return configCache;
};

export const isConfigInitialized = (): boolean => configCache !== null;

export const resetConfig = (): void => {
  configCache = null;
  logger.info("Config reset");
};

export const config: Config = new Proxy({} as Config, {
  get(_target, prop: string) {
    if (!configCache) {
      configCache = loadConfigFromEnv();
    }
    return configCache[prop as keyof Config];
  },
  set(_target, prop: string) {
    throw new Error(
      `Config is read-only. Property '${prop}' cannot be modified. Use initConfig() to set custom config.`
    );
  },
});
