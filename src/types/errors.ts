/*
 * Custom API Error class
 * Extends the built-in Error class to include additional properties
 * such as statusCode, errorType, errorInfo, and service
 */

export class SdkApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public errorType?: string,
    public errorInfo?: unknown,
    public service?: string
  ) {
    super(message);
    this.name = "SdkApiError"; // Configure the error name accordingly to your needs
  }
}
