import { env } from "$env/dynamic/public";

const PRODUCTION_CLOUD_BASE_URL = "https://zca.tuanle.dev";
export const CLOUD_BASE_URL_STORAGE_KEY = "zca.cloud.baseUrl";

export const DEFAULT_CLOUD_BASE_URL = productionSafeCloudBaseUrl(env.PUBLIC_ZCA_CLOUD_BASE_URL);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("127.")
  );
}

function productionSafeCloudBaseUrl(value: string | null | undefined): string {
  const candidate = (value || "").trim().replace(/\/+$/, "");
  if (!candidate) return PRODUCTION_CLOUD_BASE_URL;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) return PRODUCTION_CLOUD_BASE_URL;
    if (isLoopbackHost(url.hostname)) return PRODUCTION_CLOUD_BASE_URL;
    return candidate;
  } catch {
    return PRODUCTION_CLOUD_BASE_URL;
  }
}

/** Normalize a user-entered base URL, falling back to the default (rejects
 * loopback + non-http(s)). Mirrors the desktop cloudConfig helper. */
export function normalizeCloudBaseUrl(value: string | null | undefined): string {
  const candidate = (value || "").trim().replace(/\/+$/, "");
  if (!candidate) return DEFAULT_CLOUD_BASE_URL;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) return DEFAULT_CLOUD_BASE_URL;
    if (isLoopbackHost(url.hostname)) return DEFAULT_CLOUD_BASE_URL;
    return candidate;
  } catch {
    return DEFAULT_CLOUD_BASE_URL;
  }
}

/** Read + self-heal the persisted base URL from web storage. */
export function cloudBaseUrlFromStorage(storage: Storage | undefined): string {
  const saved = storage?.getItem(CLOUD_BASE_URL_STORAGE_KEY);
  const normalized = normalizeCloudBaseUrl(saved);
  if (storage && saved !== normalized) {
    storage.setItem(CLOUD_BASE_URL_STORAGE_KEY, normalized);
  }
  return normalized;
}
