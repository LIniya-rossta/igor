import type { RuntimeEnv } from "@/lib/runtime-env";

export const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";

export function normalizeTelegramApiBaseUrl(value?: string) {
  const candidate = (value || DEFAULT_TELEGRAM_API_BASE_URL).trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Telegram API base URL is invalid");
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Telegram API base URL is invalid");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function telegramMethodUrl(runtimeEnv: RuntimeEnv, method: string) {
  const token = runtimeEnv.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram bot is not configured");
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(method)) {
    throw new Error("Telegram method is invalid");
  }

  const baseUrl = normalizeTelegramApiBaseUrl(runtimeEnv.TELEGRAM_API_BASE_URL);
  return `${baseUrl}/bot${token}/${method}`;
}
