/**
 * Fireblocks Custom Development SDK
 *
 * Main entry point for the SDK. This file exports all public APIs, types, and utilities
 * for use by consumers of this package.
 *
 * Primary Entry Point:
 * - MainSDK: Main class for all Fireblocks operations (recommended)
 *
 * Advanced/Optional:
 * - SdkManager: For custom SDK pooling implementations
 * - ApiController: For Express integration
 * - Resilience patterns: RetryPolicy, CircuitBreaker
 * - Utilities: Logger, ErrorHandler, etc.
 *
 * @packageDocumentation
 * @example
 * ```typescript
 * import { MainSDK } from '@fireblocks/custom-sdk';
 * import { BasePath } from "@fireblocks/ts-sdk";
 *
 * const sdk = new MainSDK({
 *   apiKey: process.env.FIREBLOCKS_API_KEY!,
 *   secretKey: process.env.FIREBLOCKS_SECRET_KEY!,
 *   basePath: BasePath.US
 * });
 *
 * // Get vault address
 * const address = await sdk.getVaultAccountAddress('vault-123', 'BTC', 0);
 *
 * // Express integration
 * import express from 'express';
 * const app = express();
 * app.use('/api/fireblocks', sdk.createExpressRouter());
 * ```
 */

// ============================================================================
// PRIMARY ENTRY POINT - Use this for most applications
// ============================================================================

/**
 * Main FireblocksSDK class - primary interface for all Fireblocks operations
 * @see {@link FireblocksSDK}
 */
export * from "./MainSDK.js";

// ============================================================================
// ADVANCED - For custom implementations
// ============================================================================

/**
 * Express controller for REST API integration
 * Note: Most users should use sdk.createExpressRouter() instead
 */
export * from "./api/controllers/controller.js";

/**
 * Core services - for advanced custom implementations
 */
export * from "./services/index.js";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export * from "./types/index.js";

// ============================================================================
// UTILITIES
// ============================================================================

export * from "./utils/index.js";

// ============================================================================
// CONSTANTS
// ============================================================================

export * from "./constants.js";
