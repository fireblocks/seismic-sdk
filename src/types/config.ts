import { BasePath, ConfigurationOptions as FireblocksSDKConfig } from "@fireblocks/ts-sdk";

export interface Config {
  PORT: number;
  FIREBLOCKS: FireblocksSDKConfig;
  APP_NAME: string;
}

export interface CustomConfig {
  PORT?: number;
  FIREBLOCKS?: Partial<FireblocksSDKConfig>;
  APP_NAME?: string;
}

export { BasePath };

