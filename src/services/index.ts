/**
 * Services Index
 *
 * This file exports all service classes for easy import throughout the application.
 * Each service class is defined in its own file within the services directory.
 *
 * Current Services:
 * - FireblocksService: Core service for interacting with the Fireblocks API
 * - TransactionRouter: Type-safe routing of operations to SDK methods
 * - BlockchainApiService: Service for blockchain API interactions
 *
 * To add new services:
 * 1. Create a new service file in this directory (e.g., myService.service.ts)
 * 2. Implement your service class with proper documentation
 * 3. Export it here: export * from "./myService.service.js";
 *
 * Example custom service:
 * ```typescript
 * // services/blockchain.service.ts
 * export class BlockchainService {
 *   constructor(private rpcUrl: string) {}
 *
 *   async getBalance(address: string): Promise<string> {
 *     // Implementation
 *   }
 * }
 * ```
 */

export * from "./fireblocks.service.js";
export * from "./blockchain.api.service.js";
