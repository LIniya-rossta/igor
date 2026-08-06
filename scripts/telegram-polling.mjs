import { readFile } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);

async function readDevVars() {
  const values = {};
  const content = await readFile(new URL(".dev.vars", projectRoot), "utf8");
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

const devVars = await readDevVars();
const botToken = process.env.TELEGRAM_BOT_TOKEN || devVars.TELEGRAM_BOT_TOKEN;
const webhookSecret =
  process.env.TELEGRAM_WEBHOOK_SECRET || devVars.TELEGRAM_WEBHOOK_SECRET;
const localWebhookUrl =
  process.env.LOCAL_WEBHOOK_URL ||
  devVars.LOCAL_WEBHOOK_URL ||
  "http://localhost:3000/api/telegram/webhook";
const allowWebhookTakeover =
  (process.env.LOCAL_BOT_TAKEOVER || devVars.LOCAL_BOT_TAKEOVER) === "1";

if (!botToken || !webhookSecret) {
  throw new Error("Add TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET to .dev.vars");
}

const apiBase = `https://api.telegram.org/bot${botToken}`;
let running = true;
let offset = 0;
let previousWebhookUrl = "";

process.on("SIGINT", () => {
  running = false;
  process.stdout.write("\nStopping Telegram polling…\n");
  if (previousWebhookUrl) {
    process.stdout.write(
      "The previous webhook remains disabled. " +
        "Restore it explicitly before expecting the production bot to answer.\n",
    );
  }
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function telegram(method, payload = {}) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
  }
  return data.result;
}

async function waitForLocalSite() {
  const healthUrl = new URL("/api/price/meta", localWebhookUrl);
  for (let attempt = 1; attempt <= 60 && running; attempt += 1) {
    try {
      const response = await fetch(healthUrl, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // The local site is still starting.
    }
    if (attempt === 1) process.stdout.write("Waiting for the local site…\n");
    await delay(1000);
  }
  throw new Error(`Local site is unavailable at ${healthUrl.origin}`);
}

function updateLabel(update) {
  if (update.callback_query) return "button";
  if (update.message?.document) return `document ${update.message.document.file_name || ""}`.trim();
  if (update.message?.text) return `message ${update.message.text.split(/\s+/, 1)[0]}`;
  return "update";
}

await waitForLocalSite();
const webhookInfo = await telegram("getWebhookInfo");
previousWebhookUrl = typeof webhookInfo.url === "string" ? webhookInfo.url : "";
if (previousWebhookUrl && !allowWebhookTakeover) {
  throw new Error(
    "Bot already uses an existing webhook. " +
      "Set LOCAL_BOT_TAKEOVER=1 only when you intentionally want local polling to disable it.",
  );
}
if (previousWebhookUrl) {
  process.stdout.write("Disabling an existing webhook for local polling.\n");
}
await telegram("deleteWebhook", { drop_pending_updates: false });
const bot = await telegram("getMe");
await telegram("setMyCommands", {
  commands: [
    { command: "start", description: "Открыть главное меню" },
    { command: "status", description: "Показать актуальный прайс" },
    { command: "upload", description: "Загрузить большой XLSX до 1 ГБ" },
    { command: "history", description: "История версий и откат" },
    { command: "help", description: "Инструкция по управлению" },
  ],
});
process.stdout.write(`@${bot.username} → ${localWebhookUrl}\n`);
process.stdout.write("Polling is active. Press Ctrl+C to stop.\n");

while (running) {
  try {
    const updates = await telegram("getUpdates", {
      offset,
      timeout: 25,
      allowed_updates: ["message", "callback_query"],
    });

    for (const update of updates) {
      process.stdout.write(`→ ${updateLabel(update)}\n`);
      const response = await fetch(localWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
        },
        body: JSON.stringify(update),
      });
      if (!response.ok) {
        throw new Error(`Local webhook returned ${response.status}`);
      }
      offset = update.update_id + 1;
      process.stdout.write(`✓ processed ${update.update_id}\n`);
    }
  } catch (error) {
    if (!running) break;
    const message = error instanceof Error ? error.message : "Unknown polling error";
    process.stderr.write(`${message}. Retrying…\n`);
    await delay(2000);
  }
}
