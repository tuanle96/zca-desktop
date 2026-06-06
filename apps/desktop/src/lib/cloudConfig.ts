import { env } from "$env/dynamic/public";

const PRODUCTION_CLOUD_BASE_URL = "https://zca.tuanle.dev";

export const DEFAULT_CLOUD_BASE_URL = (
  env.PUBLIC_ZCA_CLOUD_BASE_URL || PRODUCTION_CLOUD_BASE_URL
).replace(/\/+$/, "");

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("127.")
  );
}

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

export function cloudBaseUrlFromStorage(storage: Storage | undefined): string {
  return normalizeCloudBaseUrl(storage?.getItem("zca.cloud.baseUrl"));
}
