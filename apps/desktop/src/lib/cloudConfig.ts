import { env } from "$env/dynamic/public";

const PRODUCTION_CLOUD_BASE_URL = "https://zca.tuanle.dev";

export const DEFAULT_CLOUD_BASE_URL = (
  env.PUBLIC_ZCA_CLOUD_BASE_URL || PRODUCTION_CLOUD_BASE_URL
).replace(/\/+$/, "");
