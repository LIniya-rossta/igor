import { uploadLocalExcelFile } from "./local-multipart-upload.mjs";
import { fileURLToPath } from "node:url";
import {
  isLocalTelegramApiBaseUrl,
  normalizeTelegramApiBaseUrl,
  readDevVars,
  waitForReady,
} from "./telegram-script-utils.mjs";

const projectRoot = new URL("../", import.meta.url);
const devVars = await readDevVars(projectRoot);
const botToken = process.env.TELEGRAM_BOT_TOKEN || devVars.TELEGRAM_BOT_TOKEN;
const webhookSecret =
  process.env.TELEGRAM_WEBHOOK_SECRET || devVars.TELEGRAM_WEBHOOK_SECRET;
const localWebhookUrl =
  process.env.LOCAL_WEBHOOK_URL ||
  devVars.LOCAL_WEBHOOK_URL ||
  "http://localhost:3000/api/telegram/webhook";
const allowWebhookTakeover =
  (process.env.LOCAL_BOT_TAKEOVER || devVars.LOCAL_BOT_TAKEOVER) === "1";
const telegramApiBaseUrl = normalizeTelegramApiBaseUrl(
  process.env.TELEGRAM_API_BASE_URL ||
    devVars.TELEGRAM_API_BASE_URL ||
    "https://api.telegram.org",
);
const localBridgeSecret =
  process.env.TELEGRAM_LOCAL_BRIDGE_SECRET ||
  devVars.TELEGRAM_LOCAL_BRIDGE_SECRET ||
  "";
const configuredLocalFilesRoot =
  process.env.TELEGRAM_LOCAL_FILES_ROOT ||
  devVars.TELEGRAM_LOCAL_FILES_ROOT ||
  "";

if (!botToken || !webhookSecret) {
  throw new Error("Add TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET to .dev.vars");
}

const directUploadEnabled = isLocalTelegramApiBaseUrl(telegramApiBaseUrl);
const localFilesRoot =
  configuredLocalFilesRoot ||
  (directUploadEnabled
    ? fileURLToPath(new URL(".telegram-bot-api/data/", projectRoot))
    : "");
if (new URL(telegramApiBaseUrl).protocol === "http:" && !directUploadEnabled) {
  throw new Error(
    "An HTTP TELEGRAM_API_BASE_URL is allowed only on 127.0.0.1",
  );
}
if (directUploadEnabled && (!localBridgeSecret || !localFilesRoot)) {
  throw new Error(
    "Local Bot API mode requires TELEGRAM_LOCAL_BRIDGE_SECRET and TELEGRAM_LOCAL_FILES_ROOT",
  );
}
if (!directUploadEnabled && (localBridgeSecret || configuredLocalFilesRoot)) {
  throw new Error(
    "Local bridge settings require a loopback TELEGRAM_API_BASE_URL",
  );
}

const apiBase = `${telegramApiBaseUrl}/bot${botToken}`;
const localSiteOrigin = new URL(localWebhookUrl).origin;
const shutdownController = new AbortController();
const queuedUploads = [];
const activeUploadJobs = new Set();
let running = true;
let offset = 0;
let previousWebhookUrl = "";

function requestShutdown() {
  if (!running) return;
  running = false;
  queuedUploads.length = 0;
  shutdownController.abort();
  process.stdout.write("\nStopping Telegram polling…\n");
  if (previousWebhookUrl) {
    process.stdout.write(
      "The previous webhook remains disabled. " +
        "Restore it explicitly before expecting the production bot to answer.\n",
    );
  }
}

process.on("SIGINT", requestShutdown);
process.on("SIGTERM", requestShutdown);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function telegram(
  method,
  payload = {},
  { signal, timeoutMs = method === "getUpdates" ? 35_000 : 15_000 } = {},
) {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(`${apiBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: requestSignal,
    });
  } catch (error) {
    throw new Error(`Telegram ${method} is unavailable`, { cause: error });
  }
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(`Telegram ${method} returned invalid JSON`, { cause: error });
  }
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
  }
  return data.result;
}

async function waitForLocalSite() {
  const healthUrl = new URL("/api/price/meta", localWebhookUrl);
  for (let attempt = 1; attempt <= 60 && running; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        cache: "no-store",
        signal: AbortSignal.any([
          shutdownController.signal,
          AbortSignal.timeout(2000),
        ]),
      });
      if (response.ok) return;
    } catch {
      // The local site is still starting.
    }
    if (attempt === 1) process.stdout.write("Waiting for the local site…\n");
    await delay(1000);
  }
  if (!running) return;
  throw new Error(`Local site is unavailable at ${healthUrl.origin}`);
}

async function waitForLocalBotApi() {
  return waitForReady({
    attempts: 120,
    intervalMs: 1000,
    shouldContinue: () => running,
    onWaiting() {
      process.stdout.write("Waiting for Telegram Local Bot API…\n");
    },
    probe: () =>
      telegram(
        "getMe",
        {},
        { signal: shutdownController.signal, timeoutMs: 1000 },
      ),
  });
}

function updateLabel(update) {
  if (update.callback_query) return "button";
  if (update.message?.document) return `document ${update.message.document.file_name || ""}`.trim();
  if (update.message?.text) return `message ${update.message.text.split(/\s+/, 1)[0]}`;
  return "update";
}

function localUploadInstruction(value) {
  if (!value || typeof value !== "object") return null;
  if (
    typeof value.chatId !== "string" ||
    !/^[-0-9]{1,32}$/.test(value.chatId) ||
    typeof value.fileId !== "string" ||
    value.fileId.length < 1 ||
    value.fileId.length > 512 ||
    typeof value.filename !== "string" ||
    typeof value.fileSize !== "number" ||
    !Number.isSafeInteger(value.fileSize) ||
    value.fileSize <= 0 ||
    value.fileSize > 1024 * 1024 * 1024 ||
    typeof value.uploadToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.uploadToken)
  ) {
    throw new Error("Local webhook returned an invalid upload instruction");
  }
  return value;
}

async function uploadTelegramFile(instruction, signal) {
  const file = await telegram(
    "getFile",
    { file_id: instruction.fileId },
    { signal },
  );
  if (!file || typeof file.file_path !== "string") {
    throw new Error("Telegram Local Bot API did not return file_path");
  }
  if (
    typeof file.file_size === "number" &&
    file.file_size !== instruction.fileSize
  ) {
    throw new Error("Telegram file size changed before upload");
  }

  let lastPercent = -1;
  await uploadLocalExcelFile({
    filePath: file.file_path,
    filename: instruction.filename,
    expectedSize: instruction.fileSize,
    token: instruction.uploadToken,
    baseUrl: localSiteOrigin,
    allowedRoots: [localFilesRoot],
    signal,
    onProgress({ uploadedBytes, totalBytes }) {
      const percent = Math.floor((uploadedBytes / totalBytes) * 100);
      if (percent === 100 || percent >= lastPercent + 10) {
        lastPercent = percent;
        process.stdout.write(`  upload ${percent}%\n`);
      }
    },
  });
}

async function reportUploadFailure(chatId) {
  try {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        "Не удалось загрузить файл. Проверьте, что локальный сервис запущен, затем нажмите «Повторить» под сообщением о файле.",
      disable_web_page_preview: true,
    });
  } catch {
    // Keep polling even if Telegram is temporarily unavailable.
  }
}

async function runUploadJob(instruction) {
  try {
    await uploadTelegramFile(instruction, shutdownController.signal);
  } catch (error) {
    if (shutdownController.signal.aborted) return;
    const message = error instanceof Error ? error.message : "Unknown upload error";
    process.stderr.write(`File upload failed: ${message}\n`);
    await reportUploadFailure(instruction.chatId);
  }
}

function startNextUpload() {
  if (!running || activeUploadJobs.size > 0) return;
  const instruction = queuedUploads.shift();
  if (!instruction) return;

  const job = runUploadJob(instruction);
  activeUploadJobs.add(job);
  void job.finally(() => {
    activeUploadJobs.delete(job);
    startNextUpload();
  });
}

function enqueueUpload(instruction) {
  if (queuedUploads.length >= 8) {
    process.stderr.write("Local upload queue is full; use the Retry button later.\n");
    void reportUploadFailure(instruction.chatId);
    return;
  }
  queuedUploads.push(instruction);
  startNextUpload();
}

async function runPolling() {
  await waitForLocalSite();
  if (!running) return;
  let bot = directUploadEnabled ? await waitForLocalBotApi() : null;
  if (!running || (!bot && directUploadEnabled)) return;

  const webhookInfo = await telegram(
    "getWebhookInfo",
    {},
    { signal: shutdownController.signal },
  );
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
  await telegram(
    "deleteWebhook",
    { drop_pending_updates: false },
    { signal: shutdownController.signal },
  );
  bot ||= await telegram("getMe", {}, { signal: shutdownController.signal });
  await telegram(
    "setMyCommands",
    {
      commands: [
        { command: "start", description: "Открыть главное меню" },
        { command: "status", description: "Показать актуальный прайс" },
        {
          command: "upload",
          description: directUploadEnabled
            ? "Как отправить Excel-прайс"
            : "Загрузить большой Excel-прайс до 1 ГБ",
        },
        { command: "history", description: "История версий и откат" },
        { command: "help", description: "Инструкция по управлению" },
      ],
    },
    { signal: shutdownController.signal },
  );
  process.stdout.write(`@${bot.username} → ${localWebhookUrl}\n`);
  if (directUploadEnabled) {
    process.stdout.write("Direct Telegram uploads are active up to 1 GiB.\n");
  }
  process.stdout.write("Polling is active. Press Ctrl+C to stop.\n");

  while (running) {
    try {
      const updates = await telegram(
        "getUpdates",
        {
          offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        },
        { signal: shutdownController.signal },
      );

      for (const update of updates) {
        if (!running) break;
        process.stdout.write(`→ ${updateLabel(update)}\n`);
        const response = await fetch(localWebhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
            ...(directUploadEnabled
              ? { "X-UnB-Telegram-Local-Bridge-Secret": localBridgeSecret }
              : {}),
          },
          body: JSON.stringify(update),
          signal: AbortSignal.any([
            shutdownController.signal,
            AbortSignal.timeout(30_000),
          ]),
        });
        if (!response.ok) {
          throw new Error(`Local webhook returned ${response.status}`);
        }
        const webhookResult = await response.json();
        if (!webhookResult || webhookResult.ok !== true) {
          throw new Error("Local webhook rejected the update");
        }
        offset = update.update_id + 1;
        const instruction = localUploadInstruction(webhookResult.localUpload);
        if (instruction) enqueueUpload(instruction);
        process.stdout.write(`✓ processed ${update.update_id}\n`);
      }
    } catch (error) {
      if (!running) break;
      const message = error instanceof Error ? error.message : "Unknown polling error";
      process.stderr.write(`${message}. Retrying…\n`);
      await delay(2000);
    }
  }

  if (activeUploadJobs.size > 0) {
    await Promise.allSettled([...activeUploadJobs]);
  }
}

try {
  await runPolling();
} catch (error) {
  if (running) throw error;
}
