

import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  appSettings,
  claimAttempts,
  pendingUploads,
  priceVersions,
} from "@/db/schema";
import {
  BROWSER_UPLOAD_ABSOLUTE_LIFETIME_MS,
  getPublishedBrowserUploadSessionForSource,
  issueBrowserUploadSession,
  resetBrowserUploadSessionsForSource,
  revokeIssuedBrowserUploadSession,
} from "@/lib/browser-upload";
import {
  excelFileFormat,
  excelMimeType,
  isValidExcelBytes,
  MAX_TELEGRAM_EXCEL_BYTES,
} from "@/lib/excel";
import {
  safeExcelUploadFilename,
  XLS_MIME,
} from "@/lib/excel-file";
import {
  formatPriceDate,
  formatPriceVersion,
  getCurrentPriceVersion,
  getRecentPriceVersions,
} from "@/lib/price";
import { getRuntimeEnv, type RuntimeEnv } from "@/lib/runtime-env";
import { telegramMethodUrl } from "@/lib/telegram-api";
import { extractNewProductNamesFromExcelBytes } from "@/lib/xlsx-new-items";
import {
  addAuthorizedChatId,
  parseAuthorizedChatIds,
  TELEGRAM_ALLOWED_CHATS_SETTING,
} from "@/lib/telegram-access";
import {
  formatFileSize,
} from "@/lib/xlsx";

export const dynamic = "force-dynamic";

const OWNER_SETTING = "telegram_owner_chat_id";
const PENDING_TTL_MS = 30 * 60 * 1000;
const CLAIM_WINDOW_MS = 10 * 60 * 1000;
const CLAIM_BLOCK_MS = 60 * 60 * 1000;
const CLAIM_ATTEMPT_LIMIT = 5;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_BROWSER_UPLOAD_BYTES = 1024 * 1024 * 1024;

type TelegramDocument = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramMessage = {
  message_id: number;
  text?: string;
  document?: TelegramDocument;
  chat: { id: number; type: string };
};

type TelegramCallback = {
  id: string;
  data?: string;
  from: { id: number };
  message?: TelegramMessage;
};

type TelegramUpdate = {
  message?: TelegramMessage;
  callback_query?: TelegramCallback;
};

type LocalUploadInstruction = {
  chatId: string;
  fileId: string;
  filename: string;
  fileSize: number;
  uploadToken: string;
};

type ReplyMarkup = {
  inline_keyboard: Array<
    Array<
      | { text: string; callback_data: string; url?: never }
      | { text: string; url: string; callback_data?: never }
    >
  >;
};

type TelegramResult<T> = { ok: boolean; result?: T; description?: string };

class RequestTooLargeError extends Error {}

function secureEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function telegramRequest<T>(
  runtimeEnv: RuntimeEnv,
  method: string,
  payload: Record<string, unknown>,
) {
  const token = runtimeEnv.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram bot is not configured");

  const response = await fetch(telegramMethodUrl(runtimeEnv, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as TelegramResult<T>;
  if (!response.ok || !data.ok || data.result === undefined) {
    throw new Error(`Telegram method ${method} failed`);
  }
  return data.result;
}

async function sendMessage(
  runtimeEnv: RuntimeEnv,
  chatId: string,
  text: string,
  replyMarkup?: ReplyMarkup,
) {
  return telegramRequest<TelegramMessage>(runtimeEnv, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function trySendMessage(
  runtimeEnv: RuntimeEnv,
  chatId: string,
  text: string,
  replyMarkup?: ReplyMarkup,
) {
  try {
    await sendMessage(runtimeEnv, chatId, text, replyMarkup);
  } catch {
    // Denial and status notices must not trigger Telegram webhook redelivery loops.
  }
}

async function answerCallback(runtimeEnv: RuntimeEnv, callbackId: string, text: string) {
  try {
    await telegramRequest<boolean>(runtimeEnv, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text,
    });
  } catch {
    // Callback acknowledgement is best-effort; the actual action remains authoritative.
  }
}

async function editCallbackMessage(
  runtimeEnv: RuntimeEnv,
  callback: TelegramCallback,
  text: string,
  replyMarkup?: ReplyMarkup,
) {
  if (!callback.message) return;
  await telegramRequest<TelegramMessage>(runtimeEnv, "editMessageText", {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function tryEditCallbackMessage(
  runtimeEnv: RuntimeEnv,
  callback: TelegramCallback,
  text: string,
  replyMarkup?: ReplyMarkup,
) {
  try {
    await editCallbackMessage(runtimeEnv, callback, text, replyMarkup);
  } catch {
    // The database/storage action must not be retried only because Telegram UI failed.
  }
}

async function getOwnerChatId() {
  const [setting] = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, OWNER_SETTING))
    .limit(1);
  return setting?.value ?? null;
}

async function getAuthorizedChatIds() {
  const owner = await getOwnerChatId();
  const [setting] = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, TELEGRAM_ALLOWED_CHATS_SETTING))
    .limit(1);
  return new Set([owner, ...parseAuthorizedChatIds(setting?.value)].filter(Boolean));
}

async function isAuthorizedChat(chatId: string) {
  return (await getAuthorizedChatIds()).has(chatId);
}

async function grantChatAccess(chatId: string) {
  const db = getDb();
  const [setting] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, TELEGRAM_ALLOWED_CHATS_SETTING))
    .limit(1);
  const value = addAuthorizedChatId(setting?.value, chatId);
  await db
    .insert(appSettings)
    .values({ key: TELEGRAM_ALLOWED_CHATS_SETTING, value, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: Date.now() },
    });
}

async function claimBlockedUntil(chatId: string) {
  const [attempt] = await getDb()
    .select({ blockedUntil: claimAttempts.blockedUntil })
    .from(claimAttempts)
    .where(eq(claimAttempts.chatId, chatId))
    .limit(1);
  return attempt?.blockedUntil ?? 0;
}

async function registerClaimFailure(chatId: string) {
  const db = getDb();
  const now = Date.now();
  await db
    .insert(claimAttempts)
    .values({ chatId, attempts: 1, windowStartedAt: now, blockedUntil: 0, updatedAt: now })
    .onConflictDoUpdate({
      target: claimAttempts.chatId,
      set: {
        attempts: sql`CASE WHEN ${now} - ${claimAttempts.windowStartedAt} < ${CLAIM_WINDOW_MS} THEN ${claimAttempts.attempts} + 1 ELSE 1 END`,
        windowStartedAt: sql`CASE WHEN ${now} - ${claimAttempts.windowStartedAt} < ${CLAIM_WINDOW_MS} THEN ${claimAttempts.windowStartedAt} ELSE ${now} END`,
        blockedUntil: sql`CASE WHEN ${now} - ${claimAttempts.windowStartedAt} < ${CLAIM_WINDOW_MS} AND ${claimAttempts.attempts} + 1 >= ${CLAIM_ATTEMPT_LIMIT} THEN ${now + CLAIM_BLOCK_MS} ELSE 0 END`,
        updatedAt: now,
      },
    });
  return claimBlockedUntil(chatId);
}

function claimBlockedMessage(blockedUntil: number) {
  const minutes = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60_000));
  return `Слишком много неверных попыток. Попробуйте снова через ${minutes} мин.`;
}

function siteUrl(runtimeEnv: RuntimeEnv, requestOrigin: string) {
  return (runtimeEnv.PUBLIC_SITE_URL || requestOrigin).replace(/\/$/, "");
}

function helpText(origin: string, directUploadEnabled = false) {
  return [
    "UnB Price Manager готов к работе.",
    "",
    "/status — текущая версия",
    "/history — история и откат",
    directUploadEnabled
      ? "/upload — подсказка по отправке Excel-прайса"
      : "/upload — загрузить большой Excel-прайс",
    "/help — эта памятка",
    "",
    `Сайт: ${origin}`,
  ].join("\n");
}

async function sendBrowserUploadLink(
  runtimeEnv: RuntimeEnv,
  chatId: string,
  requestOrigin: string,
  filename?: string,
) {
  const { id, token } = await issueBrowserUploadSession(chatId);
  try {
    const publicOrigin = siteUrl(runtimeEnv, requestOrigin);
    const uploadUrl = `${publicOrigin}/price-upload#${encodeURIComponent(token)}`;
    const uploadHostname = new URL(publicOrigin).hostname;
    const isLocalUrl =
      uploadHostname === "localhost" ||
      uploadHostname === "127.0.0.1" ||
      uploadHostname === "[::1]" ||
      uploadHostname === "::1";

    await sendMessage(
      runtimeEnv,
      chatId,
      [
        "Защищённая загрузка готова.",
        "",
        ...(filename ? [`Файл: ${filename}`, ""] : []),
        "Откройте личную ссылку и выберите XLS- или XLSX-файл размером до 1 ГБ.",
        "",
        "Начните загрузку в течение 30 минут. Пока файл передаётся, срок продлевается автоматически. Ссылка предназначена только для вас — не пересылайте её.",
        ...(isLocalUrl
          ? ["", "Локальный адрес (откройте на этом компьютере):", uploadUrl]
          : []),
      ].join("\n"),
      isLocalUrl
        ? undefined
        : {
            inline_keyboard: [[{ text: "Открыть загрузку", url: uploadUrl }]],
          },
    );
  } catch (error) {
    await revokeIssuedBrowserUploadSession(id).catch(() => undefined);
    throw error;
  }
}

async function claimOwner(
  runtimeEnv: RuntimeEnv,
  chatId: string,
  suppliedCode: string,
  requestOrigin: string,
  directUploadEnabled: boolean,
) {
  const existingOwner = await getOwnerChatId();
  if (existingOwner === chatId) {
    await trySendMessage(
      runtimeEnv,
      chatId,
      "Этот чат уже подключён как владелец. Отправьте /help, чтобы увидеть команды.",
    );
    return;
  }

  const existingBlock = await claimBlockedUntil(chatId);
  if (existingBlock > Date.now()) {
    await trySendMessage(runtimeEnv, chatId, claimBlockedMessage(existingBlock));
    return;
  }

  const expectedCode = runtimeEnv.TELEGRAM_CLAIM_CODE ?? "";
  if (!expectedCode || !secureEqual(suppliedCode, expectedCode)) {
    const blockedUntil = await registerClaimFailure(chatId);
    await trySendMessage(
      runtimeEnv,
      chatId,
      blockedUntil ? claimBlockedMessage(blockedUntil) : "Неверный код подключения.",
    );
    return;
  }

  if (existingOwner) {
    await grantChatAccess(chatId);
    await getDb().delete(claimAttempts).where(eq(claimAttempts.chatId, chatId));
    await trySendMessage(
      runtimeEnv,
      chatId,
      `Готово — этот Telegram-чат получил доступ к прайсу.\n\n${helpText(siteUrl(runtimeEnv, requestOrigin), directUploadEnabled)}`,
    );
    return;
  }

  await getDb()
    .insert(appSettings)
    .values({ key: OWNER_SETTING, value: chatId, updatedAt: Date.now() })
    .onConflictDoNothing();

  const owner = await getOwnerChatId();
  if (owner !== chatId) {
    await trySendMessage(runtimeEnv, chatId, "Бот уже был подключён в другом чате.");
    return;
  }

  await getDb().delete(claimAttempts).where(eq(claimAttempts.chatId, chatId));

  await trySendMessage(
    runtimeEnv,
    chatId,
    `Готово — этот чат теперь управляет прайсом.\n\n${helpText(siteUrl(runtimeEnv, requestOrigin), directUploadEnabled)}`,
  );
}

async function showStatus(runtimeEnv: RuntimeEnv, chatId: string, requestOrigin: string) {
  const current = await getCurrentPriceVersion();
  const currentObject = current ? await runtimeEnv.PRICE_FILES.head(current.objectKey) : null;
  if (!current || !currentObject) {
    await sendMessage(
      runtimeEnv,
      chatId,
      `Новый прайс через Telegram ещё не публиковался. Сейчас сайт отдаёт резервный файл.\n\n${siteUrl(runtimeEnv, requestOrigin)}/api/price/download`,
    );
    return;
  }

  await sendMessage(
    runtimeEnv,
    chatId,
    [
      "Текущий прайс",
      `Файл: ${current.originalName}`,
      `Версия: ${formatPriceVersion(current.uploadedAt)}`,
      `Обновлён: ${formatPriceDate(current.uploadedAt)}`,
      `Размер: ${formatFileSize(current.fileSize)}`,
      "",
      `${siteUrl(runtimeEnv, requestOrigin)}/api/price/download`,
    ].join("\n"),
  );
}

function historyMarkup(
  versions: Awaited<ReturnType<typeof getRecentPriceVersions>>,
): ReplyMarkup | undefined {
  const buttons = versions
    .filter((version) => !version.isCurrent)
    .map((version) => [
      {
        text: `↩ ${formatPriceVersion(version.uploadedAt)} · ${version.originalName.slice(0, 28)}`,
        callback_data: `rollback:${version.id}`,
      },
    ]);
  return buttons.length ? { inline_keyboard: buttons } : undefined;
}

async function showHistory(runtimeEnv: RuntimeEnv, chatId: string) {
  const versions = await getRecentPriceVersions(5);
  if (!versions.length) {
    await sendMessage(runtimeEnv, chatId, "История пока пуста. Отправьте первый файл .xls или .xlsx.");
    return;
  }

  const lines = versions.map(
    (version, index) =>
      `${version.isCurrent ? "●" : "○"} ${index + 1}. ${formatPriceVersion(version.uploadedAt)} — ${version.originalName}`,
  );
  await sendMessage(
    runtimeEnv,
    chatId,
    ["Последние версии", "", ...lines, "", "Чтобы вернуть старую версию, нажмите кнопку:"].join("\n"),
    historyMarkup(versions),
  );
}

async function queueDocument(
  runtimeEnv: RuntimeEnv,
  chatId: string,
  message: TelegramMessage,
  requestOrigin: string,
  directUploadEnabled: boolean,
) {
  const document = message.document;
  if (!document) return;

  const fallbackFilename = document.mime_type === XLS_MIME ? "price.xls" : "price.xlsx";
  const filename = safeExcelUploadFilename(document.file_name ?? fallbackFilename);
  const fileSize = document.file_size ?? 0;
  if (!filename) {
    await sendMessage(runtimeEnv, chatId, "Нужен файл Excel с расширением .xls или .xlsx.");
    return;
  }
  if (fileSize <= 0) {
    await sendMessage(runtimeEnv, chatId, "Файл должен быть не пустым.");
    return;
  }
  if (fileSize > MAX_BROWSER_UPLOAD_BYTES) {
    await sendMessage(runtimeEnv, chatId, "Максимальный размер Excel-файла для защищённой загрузки — 1 ГБ.");
    return;
  }
  if (fileSize > MAX_TELEGRAM_EXCEL_BYTES && !directUploadEnabled) {
    await sendBrowserUploadLink(runtimeEnv, chatId, requestOrigin, filename);
    return;
  }

  const db = getDb();
  const [published] = await db
    .select({ id: priceVersions.id })
    .from(priceVersions)
    .where(eq(priceVersions.telegramFileUniqueId, document.file_unique_id))
    .limit(1);
  if (published) {
    await sendMessage(runtimeEnv, chatId, "Этот файл уже есть в истории версий.");
    return;
  }

  const now = Date.now();
  await db.delete(pendingUploads).where(lt(pendingUploads.expiresAt, now));
  const pendingId = crypto.randomUUID();
  const [inserted] = await db
    .insert(pendingUploads)
    .values({
      id: pendingId,
      chatId,
      telegramFileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      originalName: filename,
      mimeType: document.mime_type,
      fileSize,
      messageId: message.message_id,
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
    })
    .onConflictDoNothing()
    .returning({ id: pendingUploads.id });
  if (!inserted) {
    const [existingPending] = await db
      .select({ messageId: pendingUploads.messageId })
      .from(pendingUploads)
      .where(eq(pendingUploads.fileUniqueId, document.file_unique_id))
      .limit(1);
    if (existingPending && existingPending.messageId !== message.message_id) {
      await sendMessage(runtimeEnv, chatId, "Этот файл уже ожидает подтверждения выше в чате.");
    }
    return;
  }

  try {
    await sendMessage(
      runtimeEnv,
      chatId,
      [
        "Проверим перед публикацией:",
        `Файл: ${filename}`,
        `Размер: ${formatFileSize(fileSize)}`,
        "",
        "После подтверждения этот файл станет актуальным прайсом на сайте.",
      ].join("\n"),
      {
        inline_keyboard: [
          [
            { text: "Опубликовать", callback_data: `publish:${pendingId}` },
            { text: "Отмена", callback_data: `cancel:${pendingId}` },
          ],
        ],
      },
    );
  } catch (error) {
    await db.delete(pendingUploads).where(eq(pendingUploads.id, pendingId));
    throw error;
  }
}

async function downloadTelegramFile(runtimeEnv: RuntimeEnv, telegramFileId: string) {
  const file = await telegramRequest<{ file_path?: string }>(runtimeEnv, "getFile", {
    file_id: telegramFileId,
  });
  if (!file.file_path) throw new Error("Telegram file path is missing");

  const token = runtimeEnv.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram bot is not configured");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error("Telegram file download failed");

  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_TELEGRAM_EXCEL_BYTES) {
    throw new Error("Telegram file is too large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_TELEGRAM_EXCEL_BYTES) {
    throw new Error("Telegram file is too large");
  }
  return bytes;
}

async function cleanupUnpublishedTelegramObject(
  runtimeEnv: RuntimeEnv,
  pendingId: string,
) {
  await runtimeEnv.PRICE_FILES.delete(`price/versions/${pendingId}.xls`);
  await runtimeEnv.PRICE_FILES.delete(`price/versions/${pendingId}.xlsx`);
}

async function publishPending(
  runtimeEnv: RuntimeEnv,
  callback: TelegramCallback,
  pendingId: string,
  chatId: string,
  requestOrigin: string,
  directUploadEnabled: boolean,
) {
  const db = getDb();
  const [pending] = await db
    .select()
    .from(pendingUploads)
    .where(and(eq(pendingUploads.id, pendingId), eq(pendingUploads.chatId, chatId)))
    .limit(1);

  if (!pending) {
    let [published] = await db
      .select()
      .from(priceVersions)
      .where(eq(priceVersions.id, pendingId))
      .limit(1);
    if (!published) {
      const sourceSession =
        await getPublishedBrowserUploadSessionForSource(pendingId);
      if (sourceSession) {
        [published] = await db
          .select()
          .from(priceVersions)
          .where(eq(priceVersions.id, sourceSession.id))
          .limit(1);
      }
    }
    if (published) {
      await tryEditCallbackMessage(
        runtimeEnv,
        callback,
        [
          "Готово — прайс опубликован.",
          `Файл: ${published.originalName}`,
          `Версия: ${formatPriceVersion(published.uploadedAt)}`,
          `Дата на сайте: ${formatPriceDate(published.uploadedAt)}`,
          "",
          `${siteUrl(runtimeEnv, requestOrigin)}/api/price/download`,
        ].join("\n"),
      );
      return;
    }
    await cleanupUnpublishedTelegramObject(runtimeEnv, pendingId);
    await tryEditCallbackMessage(runtimeEnv, callback, "Срок подтверждения истёк. Отправьте файл ещё раз.");
    return;
  }

  if (pending.expiresAt < Date.now()) {
    await db.delete(pendingUploads).where(eq(pendingUploads.id, pending.id));
    await tryEditCallbackMessage(runtimeEnv, callback, "Срок подтверждения истёк. Отправьте файл ещё раз.");
    return;
  }

  const [duplicate] = await db
    .select()
    .from(priceVersions)
    .where(eq(priceVersions.telegramFileUniqueId, pending.fileUniqueId))
    .limit(1);
  if (duplicate) {
    await db.delete(pendingUploads).where(eq(pendingUploads.id, pending.id));
    await tryEditCallbackMessage(
      runtimeEnv,
      callback,
      `Этот файл уже опубликован как версия ${formatPriceVersion(duplicate.uploadedAt)}.`,
    );
    return;
  }

  if (directUploadEnabled) {
    const [extendedPending] = await db
      .update(pendingUploads)
      .set({ expiresAt: Date.now() + BROWSER_UPLOAD_ABSOLUTE_LIFETIME_MS })
      .where(
        and(
          eq(pendingUploads.id, pending.id),
          eq(pendingUploads.chatId, chatId),
          eq(pendingUploads.fileUniqueId, pending.fileUniqueId),
        ),
      )
      .returning({ id: pendingUploads.id });
    if (!extendedPending) return;

    const alreadyPublished = await resetBrowserUploadSessionsForSource(
      runtimeEnv,
      pending.id,
    );
    if (alreadyPublished) {
      await tryEditCallbackMessage(
        runtimeEnv,
        callback,
        `Этот файл уже опубликован.\n\n${siteUrl(runtimeEnv, requestOrigin)}/api/price/download`,
      );
      return;
    }
    const issued = await issueBrowserUploadSession(
      chatId,
      BROWSER_UPLOAD_ABSOLUTE_LIFETIME_MS,
      { pendingId: pending.id, fileUniqueId: pending.fileUniqueId },
    );

    try {
      await tryEditCallbackMessage(
        runtimeEnv,
        callback,
        [
          "Файл подтверждён — бот загружает и проверяет его.",
          `Файл: ${pending.originalName}`,
          `Размер: ${formatFileSize(pending.fileSize)}`,
          "",
          "Для большого прайса это может занять несколько минут. Если передача прервётся, нажмите «Повторить».",
        ].join("\n"),
        {
          inline_keyboard: [
            [
              { text: "Повторить", callback_data: `publish:${pending.id}` },
              { text: "Отмена", callback_data: `cancel:${pending.id}` },
            ],
          ],
        },
      );

      return {
        chatId,
        fileId: pending.telegramFileId,
        filename: pending.originalName,
        fileSize: pending.fileSize,
        uploadToken: issued.token,
      } satisfies LocalUploadInstruction;
    } catch (error) {
      await revokeIssuedBrowserUploadSession(issued.id).catch(() => undefined);
      throw error;
    }
  }

  const bytes = await downloadTelegramFile(runtimeEnv, pending.telegramFileId);
  if (!(await isValidExcelBytes(bytes, pending.originalName))) {
    await db.delete(pendingUploads).where(eq(pendingUploads.id, pending.id));
    await tryEditCallbackMessage(
      runtimeEnv,
      callback,
      "Файл отклонён: содержимое не соответствует корректному XLS/XLSX, файл зашифрован или содержит макросы. Пересохраните прайс и отправьте его ещё раз.",
    );
    return;
  }

  const newItemNames = await extractNewProductNamesFromExcelBytes(
    bytes,
    pending.originalName,
  );

  const now = Date.now();
  const versionId = pending.id;
  const format = excelFileFormat(pending.originalName);
  if (!format) throw new Error("Pending Excel filename is invalid");
  const objectKey = `price/versions/${versionId}.${format}`;
  await runtimeEnv.PRICE_FILES.put(objectKey, bytes, {
    httpMetadata: { contentType: excelMimeType(pending.originalName) },
  });

  try {
    await runtimeEnv.DB.batch([
      runtimeEnv.DB.prepare(
        `INSERT INTO price_versions
           (id, object_key, original_name, file_size, uploaded_at, uploaded_by,
            telegram_file_unique_id, is_current)
         SELECT ?, ?, ?, ?, ?, ?, ?, 0
         WHERE EXISTS (
           SELECT 1 FROM pending_uploads
           WHERE id = ? AND chat_id = ? AND file_unique_id = ?
             AND original_name = ? AND file_size = ?
         )
         ON CONFLICT(telegram_file_unique_id) DO NOTHING`,
      ).bind(
        versionId,
        objectKey,
        pending.originalName,
        bytes.byteLength,
        now,
        chatId,
        pending.fileUniqueId,
        pending.id,
        chatId,
        pending.fileUniqueId,
        pending.originalName,
        pending.fileSize,
      ),
      ...newItemNames.map((productName, position) =>
        runtimeEnv.DB.prepare(
          `INSERT INTO price_new_items (price_version_id, position, product_name)
           SELECT ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM price_versions
             WHERE id = ? AND telegram_file_unique_id = ?
           )
           ON CONFLICT(price_version_id, position) DO NOTHING`,
        ).bind(
          versionId,
          position,
          productName,
          versionId,
          pending.fileUniqueId,
        ),
      ),
      runtimeEnv.DB.prepare(
        `UPDATE price_versions SET is_current = 0
         WHERE is_current = 1 AND EXISTS (
           SELECT 1 FROM price_versions
           WHERE id = ? AND telegram_file_unique_id = ?
         )`,
      ).bind(versionId, pending.fileUniqueId),
      runtimeEnv.DB.prepare(
        `UPDATE price_versions SET is_current = 1
         WHERE id = ? AND telegram_file_unique_id = ?`,
      ).bind(versionId, pending.fileUniqueId),
      runtimeEnv.DB.prepare(
        `DELETE FROM pending_uploads
         WHERE id = ? AND chat_id = ? AND file_unique_id = ?
           AND EXISTS (
             SELECT 1 FROM price_versions
             WHERE id = ? AND telegram_file_unique_id = ?
           )`,
      ).bind(
        pending.id,
        chatId,
        pending.fileUniqueId,
        versionId,
        pending.fileUniqueId,
      ),
    ]);
  } catch (error) {
    const [committed] = await db
      .select({ id: priceVersions.id })
      .from(priceVersions)
      .where(
        and(
          eq(priceVersions.id, versionId),
          eq(priceVersions.telegramFileUniqueId, pending.fileUniqueId),
        ),
      )
      .limit(1);
    if (!committed) {
      await cleanupUnpublishedTelegramObject(runtimeEnv, versionId);
      throw error;
    }
  }

  const [publishedVersion] = await db
    .select({ uploadedAt: priceVersions.uploadedAt })
    .from(priceVersions)
    .where(
      and(
        eq(priceVersions.id, versionId),
        eq(priceVersions.telegramFileUniqueId, pending.fileUniqueId),
      ),
    )
    .limit(1);
  if (!publishedVersion) {
    await cleanupUnpublishedTelegramObject(runtimeEnv, versionId);
    return;
  }

  await tryEditCallbackMessage(
    runtimeEnv,
    callback,
    [
      "Готово — прайс опубликован.",
      `Файл: ${pending.originalName}`,
      `Версия: ${formatPriceVersion(publishedVersion.uploadedAt)}`,
      `Дата на сайте: ${formatPriceDate(publishedVersion.uploadedAt)}`,
      `Новинок найдено: ${newItemNames.length}`,
      "",
      `${siteUrl(runtimeEnv, requestOrigin)}/api/price/download`,
    ].join("\n"),
  );
}

async function rollbackVersion(
  runtimeEnv: RuntimeEnv,
  callback: TelegramCallback,
  versionId: string,
) {
  const db = getDb();
  const [version] = await db
    .select()
    .from(priceVersions)
    .where(eq(priceVersions.id, versionId))
    .limit(1);
  if (!version) {
    await tryEditCallbackMessage(runtimeEnv, callback, "Версия не найдена.");
    return;
  }

  const object = await runtimeEnv.PRICE_FILES.head(version.objectKey);
  if (!object) {
    await tryEditCallbackMessage(runtimeEnv, callback, "Файл этой версии недоступен в хранилище.");
    return;
  }

  await db.batch([
    db.update(priceVersions).set({ isCurrent: false }),
    db.update(priceVersions).set({ isCurrent: true }).where(eq(priceVersions.id, version.id)),
  ]);
  await tryEditCallbackMessage(
    runtimeEnv,
    callback,
    `Версия восстановлена.\nФайл: ${version.originalName}\nВерсия: ${formatPriceVersion(version.uploadedAt)}`,
  );
}

async function handleMessage(
  runtimeEnv: RuntimeEnv,
  message: TelegramMessage,
  requestOrigin: string,
  directUploadEnabled: boolean,
) {
  const chatId = String(message.chat.id);
  if (message.chat.type !== "private") {
    await trySendMessage(runtimeEnv, chatId, "Управление прайсом доступно только в личном чате с ботом.");
    return;
  }

  const text = message.text?.trim() ?? "";
  const [rawCommand = "", commandArgument = ""] = text.split(/\s+/, 2);
  const command = rawCommand.split("@", 1)[0].toLowerCase();
  if (command === "/claim") {
    await claimOwner(
      runtimeEnv,
      chatId,
      commandArgument,
      requestOrigin,
      directUploadEnabled,
    );
    return;
  }

  const owner = await getOwnerChatId();
  if (!owner) {
    await trySendMessage(runtimeEnv, chatId, "Бот ещё не подключён. Владельцу нужно отправить команду /claim и личный код подключения.");
    return;
  }
  if (!(await isAuthorizedChat(chatId))) {
    await trySendMessage(runtimeEnv, chatId, "Доступ закрыт: этот бот управляется владельцем UnB computers.");
    return;
  }

  if (message.document) {
    await queueDocument(
      runtimeEnv,
      chatId,
      message,
      requestOrigin,
      directUploadEnabled,
    );
    return;
  }
  if (command === "/status") {
    await showStatus(runtimeEnv, chatId, requestOrigin);
    return;
  }
  if (command === "/history" || command === "/rollback") {
    await showHistory(runtimeEnv, chatId);
    return;
  }
  if (command === "/upload") {
    if (directUploadEnabled) {
      await sendMessage(
        runtimeEnv,
        chatId,
        "Отправьте сюда файл .xls или .xlsx размером до 1 ГБ. После подтверждения бот сам загрузит и опубликует его — открывать отдельную ссылку не нужно.",
      );
    } else {
      await sendBrowserUploadLink(runtimeEnv, chatId, requestOrigin);
    }
    return;
  }
  if (command === "/start" || command === "/help") {
    await sendMessage(
      runtimeEnv,
      chatId,
      helpText(siteUrl(runtimeEnv, requestOrigin), directUploadEnabled),
    );
    return;
  }

  await sendMessage(
    runtimeEnv,
    chatId,
    directUploadEnabled
      ? "Отправьте файл .xls или .xlsx размером до 1 ГБ или откройте /help."
      : "Отправьте файл .xls или .xlsx, используйте /upload для большого файла или откройте /help.",
  );
}

async function handleCallback(
  runtimeEnv: RuntimeEnv,
  callback: TelegramCallback,
  requestOrigin: string,
  directUploadEnabled: boolean,
) {
  const chatId = callback.message ? String(callback.message.chat.id) : String(callback.from.id);
  const owner = await getOwnerChatId();
  if (!owner || !(await isAuthorizedChat(chatId)) || String(callback.from.id) !== chatId) {
    await answerCallback(runtimeEnv, callback.id, "Нет доступа");
    return;
  }

  const [action, id] = (callback.data ?? "").split(":", 2);
  if (!id) {
    await answerCallback(runtimeEnv, callback.id, "Команда устарела");
    return;
  }

  await answerCallback(runtimeEnv, callback.id, action === "publish" ? "Проверяю файл…" : "Выполняю…");
  if (action === "cancel") {
    if (directUploadEnabled) {
      const published = await resetBrowserUploadSessionsForSource(runtimeEnv, id);
      if (published) {
        await tryEditCallbackMessage(
          runtimeEnv,
          callback,
          `Файл уже опубликован.\n\n${siteUrl(runtimeEnv, requestOrigin)}/api/price/download`,
        );
        return;
      }
    }
    await getDb()
      .delete(pendingUploads)
      .where(and(eq(pendingUploads.id, id), eq(pendingUploads.chatId, chatId)));
    await tryEditCallbackMessage(runtimeEnv, callback, "Публикация отменена.");
    return;
  }
  if (action === "publish") {
    return publishPending(
      runtimeEnv,
      callback,
      id,
      chatId,
      requestOrigin,
      directUploadEnabled,
    );
  }
  if (action === "rollback") {
    await rollbackVersion(runtimeEnv, callback, id);
  }
}

async function readWebhookUpdate(request: Request) {
  if (!request.body) throw new SyntaxError("Missing request body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      throw new RequestTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as TelegramUpdate;
}

export async function POST(request: Request) {
  const runtimeEnv = getRuntimeEnv();
  const expectedSecret = runtimeEnv.TELEGRAM_WEBHOOK_SECRET ?? "";
  const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!expectedSecret || !secureEqual(suppliedSecret, expectedSecret)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const expectedBridgeSecret = runtimeEnv.TELEGRAM_LOCAL_BRIDGE_SECRET ?? "";
  const suppliedBridgeSecret =
    request.headers.get("X-UnB-Telegram-Local-Bridge-Secret") ?? "";
  if (
    suppliedBridgeSecret &&
    (!expectedBridgeSecret || !secureEqual(suppliedBridgeSecret, expectedBridgeSecret))
  ) {
    return Response.json({ ok: false }, { status: 403 });
  }
  const directUploadEnabled =
    Boolean(expectedBridgeSecret) &&
    Boolean(suppliedBridgeSecret) &&
    secureEqual(suppliedBridgeSecret, expectedBridgeSecret);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_WEBHOOK_BYTES) {
    return Response.json({ ok: false }, { status: 413 });
  }

  let update: TelegramUpdate;
  try {
    update = await readWebhookUpdate(request);
  } catch (error) {
    return Response.json(
      { ok: false },
      { status: error instanceof RequestTooLargeError ? 413 : 400 },
    );
  }

  try {
    const requestOrigin = new URL(request.url).origin;
    if (update.message) {
      await handleMessage(
        runtimeEnv,
        update.message,
        requestOrigin,
        directUploadEnabled,
      );
    }
    let localUpload: LocalUploadInstruction | undefined;
    if (update.callback_query) {
      localUpload = await handleCallback(
        runtimeEnv,
        update.callback_query,
        requestOrigin,
        directUploadEnabled,
      );
    }
    return Response.json(localUpload ? { ok: true, localUpload } : { ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
