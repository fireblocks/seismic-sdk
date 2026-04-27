import { RateLimitError, SdkApiError } from "../types/errors.js";

/**
 * Delay execution for a specified time
 */
export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Determines if an error is retriable (transient)
 * @param err - The error to check
 * @returns true if the error should be retried
 */
function isRetriableError(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (err instanceof SdkApiError) {
    const status = err.statusCode ?? 0;
    // Retry on 5xx server errors and 408 Request Timeout
    return status >= 500 || status === 408 || status === 429;
  }
  return false;
}

/**
 * Retries an async function with exponential backoff on transient errors.
 *
 * Only retries on retriable errors (5xx, 429, 408). Throws immediately on
 * client errors (4xx except 408/429) and other non-retriable errors.
 *
 * @param fn - The async function to retry
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param baseDelayMs - Base delay in milliseconds between retries (default: 1000)
 * @returns The result of the function
 * @throws The final error if all retries are exhausted
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fireblocks.transactions.createTransaction(payload),
 *   3,
 *   1000
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetriable = isRetriableError(err);
      if (!isRetriable || attempt === maxRetries) {
        throw err;
      }
      // Exponential backoff: 2^attempt * baseDelayMs
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      await sleep(delayMs);
    }
  }
  throw new Error("unreachable");
}
