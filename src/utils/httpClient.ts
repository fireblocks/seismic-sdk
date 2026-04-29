import axios, { type AxiosInstance } from "axios";
import { getPackageName, getPackageVersion } from "./package.js";

function defaultUserAgent(): string {
  try {
    return `${getPackageName()}/${getPackageVersion()}`;
  } catch {
    return "@fireblocks/seismic-sdk/unknown";
  }
}

export function createHttpClient(opts?: {
  userAgent?: string;
  timeout?: number;
  instance?: AxiosInstance;
}): AxiosInstance {
  if (opts?.instance) return opts.instance;
  return axios.create({
    headers: { "User-Agent": opts?.userAgent ?? defaultUserAgent() },
    ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
  });
}

export default createHttpClient();
