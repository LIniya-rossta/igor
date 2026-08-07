import { readFile } from "node:fs/promises";

export function parseDevVars(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export async function readDevVars(projectRoot) {
  const content = await readFile(new URL(".dev.vars", projectRoot), "utf8");
  return parseDevVars(content);
}

export function normalizeTelegramApiBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TELEGRAM_API_BASE_URL is invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("TELEGRAM_API_BASE_URL is invalid");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function isLocalTelegramApiBaseUrl(value) {
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    (url.pathname === "/" || url.pathname === "")
  );
}

export function requireLocalTelegramApiOrigin(value) {
  const normalized = normalizeTelegramApiBaseUrl(value);
  const url = new URL(normalized);
  if (!isLocalTelegramApiBaseUrl(normalized)) {
    throw new Error(
      "TELEGRAM_API_BASE_URL must be an HTTP origin on 127.0.0.1",
    );
  }
  return url.origin;
}

export function isTelegramBotToken(value) {
  return /^\d{6,12}:[A-Za-z0-9_-]{20,}$/.test(value);
}

export async function assertLocalTelegramApiReachable(
  origin,
  botToken,
  {
    fetchImpl = fetch,
    signal = AbortSignal.timeout(3000),
  } = {},
) {
  const localOrigin = requireLocalTelegramApiOrigin(origin);
  if (!isTelegramBotToken(botToken)) {
    throw new Error("Add a valid TELEGRAM_BOT_TOKEN to .dev.vars");
  }
  let response;
  try {
    response = await fetchImpl(`${localOrigin}/bot${botToken}/getMe`, {
      method: "POST",
      signal,
    });
  } catch {
    throw new Error(
      "Telegram Local Bot API is not reachable; cloud logOut was not attempted",
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      "Local endpoint is not Telegram Bot API; cloud logOut was not attempted",
    );
  }
  if (
    !response.ok ||
    payload?.ok !== true ||
    payload?.result?.is_bot !== true ||
    !Number.isSafeInteger(payload?.result?.id) ||
    typeof payload?.result?.username !== "string" ||
    payload.result.username.length < 1
  ) {
    throw new Error(
      "Local endpoint did not authenticate this bot; cloud logOut was not attempted",
    );
  }
}

export async function logOutCloudBot(
  botToken,
  {
    fetchImpl = fetch,
    signal = AbortSignal.timeout(15_000),
  } = {},
) {
  if (!isTelegramBotToken(botToken)) {
    throw new Error("Add a valid TELEGRAM_BOT_TOKEN to .dev.vars");
  }

  let response;
  try {
    response = await fetchImpl(
      `https://api.telegram.org/bot${botToken}/logOut`,
      { method: "POST", signal },
    );
  } catch {
    throw new Error("Cloud Telegram API is unavailable; logOut was not completed");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Cloud Telegram API returned an invalid logOut response");
  }
  if (!response.ok || payload?.ok !== true || payload?.result !== true) {
    throw new Error(`Cloud Telegram logOut failed with HTTP ${response.status}`);
  }
}

export async function waitForReady({
  probe,
  attempts = 120,
  intervalMs = 1000,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  shouldContinue = () => true,
  onWaiting = () => {},
}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts && shouldContinue(); attempt += 1) {
    try {
      return await probe();
    } catch (error) {
      lastError = error;
      if (attempt === 1) onWaiting();
      if (attempt < attempts && shouldContinue()) await sleep(intervalMs);
    }
  }
  if (!shouldContinue()) return null;
  throw new Error("Telegram Local Bot API did not become ready", {
    cause: lastError,
  });
}
