import { env } from "cloudflare:workers";
import { getRailwayRuntime, isRailwayNodeRuntime } from "@/lib/railway-runtime";

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
  return env as unknown as RuntimeEnv;
}
