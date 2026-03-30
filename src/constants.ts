/**
 * Application Constants
 *
 * This file is a placeholder for application-wide constants that are used across
 * multiple modules. Constants defined here should be truly constant values that
 * don't change at runtime.
 *
 * Common constants you might add:
 * - API endpoints and URLs
 * - Configuration defaults
 * - Blockchain-specific values (chain IDs, contract addresses, etc.)
 * - Error codes and messages
 * - Rate limits and timeouts
 * - Feature flags
 * - Magic numbers with business meaning
 *
 * Guidelines:
 * - Use UPPER_SNAKE_CASE for constant names
 * - Group related constants into objects or enums
 * - Add comments explaining the purpose and usage
 * - Prefer const assertions (as const) for type safety
 * - Document units for time/size values (ms, seconds, bytes, etc.)
 *
 * Example constants:
 * ```typescript
 * // API Configuration
 * export const API_VERSION = 'v1';
 * export const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds
 * export const MAX_RETRY_ATTEMPTS = 3;
 * export const RETRY_DELAY_MS = 1000; // 1 second
 *
 * // Blockchain Constants
 * export const SUPPORTED_CHAINS = {
 *   ETHEREUM: 'ETH',
 *   BITCOIN: 'BTC',
 *   CARDANO: 'ADA',
 * } as const;
 *
 * export const CHAIN_IDS = {
 *   ETHEREUM_MAINNET: 1,
 *   ETHEREUM_SEPOLIA: 11155111,
 *   POLYGON_MAINNET: 137,
 * } as const;
 *
 * // Transaction Statuses
 * export const TX_STATUS = {
 *   PENDING: 'PENDING',
 *   SUBMITTED: 'SUBMITTED',
 *   CONFIRMING: 'CONFIRMING',
 *   COMPLETED: 'COMPLETED',
 *   FAILED: 'FAILED',
 *   CANCELLED: 'CANCELLED',
 * } as const;
 *
 * // Error Codes
 * export const ERROR_CODES = {
 *   INVALID_ADDRESS: 'ERR_INVALID_ADDRESS',
 *   INSUFFICIENT_BALANCE: 'ERR_INSUFFICIENT_BALANCE',
 *   NETWORK_ERROR: 'ERR_NETWORK',
 *   TIMEOUT: 'ERR_TIMEOUT',
 * } as const;
 *
 * // Pagination Defaults
 * export const DEFAULT_PAGE_SIZE = 20;
 * export const MAX_PAGE_SIZE = 100;
 *
 * // Cache TTLs (in seconds)
 * export const CACHE_TTL = {
 *   SHORT: 60,        // 1 minute
 *   MEDIUM: 300,      // 5 minutes
 *   LONG: 3600,       // 1 hour
 * } as const;
 * ```
 */

// Add your application constants below this line
