import { BasePath, ConfigurationOptions as FireblocksSDKConfig } from "@fireblocks/ts-sdk";

export interface Config {
  PORT: number;
  FIREBLOCKS: FireblocksSDKConfig;
  APP_NAME: string;
  TESTNET: boolean;
  RPC_URL?: string;
  SOCIALSCAN_API_KEY?: string;
}

export interface CustomConfig {
  PORT?: number;
  FIREBLOCKS?: Partial<FireblocksSDKConfig>;
  APP_NAME?: string;
  TESTNET?: boolean;
  RPC_URL?: string;
  SOCIALSCAN_API_KEY?: string;
}

export { BasePath };
