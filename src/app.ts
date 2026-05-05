import { EventEmitter } from "events";
EventEmitter.defaultMaxListeners = 50;

import dotenv from "dotenv";
dotenv.config();

import startServer from "./server.js";

import { Logger, LogLevel } from "./utils/index.js";

const logger = new Logger("app:server-initializer");

if (process.env.LOG_LEVEL) {
  const envLevel = process.env.LOG_LEVEL.toUpperCase();
  const levelMap: Record<string, LogLevel> = {
    DEBUG: LogLevel.DEBUG,
    INFO: LogLevel.INFO,
    WARN: LogLevel.WARN,
    ERROR: LogLevel.ERROR,
    NONE: LogLevel.NONE,
  };
  if (levelMap[envLevel] !== undefined) {
    Logger.setLogLevel(levelMap[envLevel]);
  }
}

(() => {
  try {
    logger.info("server starting...");
    startServer();
  } catch (e) {
    if (e instanceof Error) {
      logger.error("Error starting server:", { message: e.message, stack: e.stack });
    } else {
      logger.error("Error starting server:", e);
    }
    process.exit(1);
  }
})();
