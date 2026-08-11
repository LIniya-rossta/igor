import { getRailwayRuntime, isRailwayNodeRuntime } from "@/lib/railway-runtime";

// Keep the Cloudflare binding lazy: Railway runs the same route modules in
// Node, where the `cloudflare:` URL scheme is not understood by Node's loader.
// The dynamic import is evaluated only in the Cloudflare deployment path.
const cloudflareEnv = isRailwayNodeRuntime()
  ? null
  : ((await import("cloudflare:workers")).env as unknown as RuntimeEnv);

export interface RuntimeEnv {
  DB: D1Database;
  PRICE_FILES: R2Bucket;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_CLAIM_CODE?: string;
  TELEGRAM_API_BASE_URL?: string;
  TELEGRAM_LOCAL_BRIDGE_SECRET?: string;
  PUBLIC_SITE_URL?: string;
}

export function getRuntimeEnv(): RuntimeEnv {
  if (isRailwayNodeRuntime()) {
    return getRailwayRuntime() as unknown as RuntimeEnv;
  }
  if (!cloudflareEnv) {
    throw new Error("Cloudflare runtime environment is unavailable");
  }
  return cloudflareEnv;
}
