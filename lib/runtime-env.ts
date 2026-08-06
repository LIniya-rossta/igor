import { env } from "cloudflare:workers";

export interface RuntimeEnv {
  DB: D1Database;
  PRICE_FILES: R2Bucket;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_CLAIM_CODE?: string;
  PUBLIC_SITE_URL?: string;
}

export function getRuntimeEnv(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}
