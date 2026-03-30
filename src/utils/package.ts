/**
 * Package.json utilities
 *
 * Provides centralized access to package.json metadata throughout the application.
 * This avoids duplicating the file reading logic across multiple modules.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Interface for package.json structure
 */
export interface PackageJson {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  repository?: {
    type: string;
    url: string;
  };
  [key: string]: unknown;
}

/**
 * Cached package.json contents
 * Read once at module initialization to avoid repeated file I/O
 */
let packageJsonCache: PackageJson | null = null;

/**
 * Get package.json contents
 *
 * @returns Parsed package.json object
 * @throws Error if package.json cannot be read or parsed
 */
export function getPackageJson(): PackageJson {
  if (!packageJsonCache) {
    try {
      const packageJsonPath = join(__dirname, "../../package.json");
      const contents = readFileSync(packageJsonPath, "utf-8");
      packageJsonCache = JSON.parse(contents) as PackageJson;
    } catch (error) {
      throw new Error(`Failed to read package.json: ${error}`);
    }
  }
  return packageJsonCache;
}

/**
 * Get the package name
 * @returns Package name from package.json
 */
export function getPackageName(): string {
  return getPackageJson().name;
}

/**
 * Get the package version
 * @returns Package version from package.json
 */
export function getPackageVersion(): string {
  return getPackageJson().version;
}

/**
 * Get the package description
 * @returns Package description from package.json or empty string if not set
 */
export function getPackageDescription(): string {
  return getPackageJson().description || "";
}
