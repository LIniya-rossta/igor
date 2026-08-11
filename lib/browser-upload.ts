import { and, eq, gt, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { browserUploadSessions } from "@/db/schema";
import type { RuntimeEnv } from "@/lib/runtime-env";
import { telegramMethodUrl } from "@/lib/telegram-api";

export const BROWSER_UPLOAD_PART_SIZE = 8 * 1024 * 1024;
export const BROWSER_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const BROWSER_UPLOAD_IDLE_TTL_MS = 30 * 60 * 1000;
export const BROWSER_UPLOAD_TTL_MS = BROWSER_UPLOAD_IDLE_TTL_MS;
export const BROWSER_UPLOAD_ABSOLUTE_LIFETIME_MS = 4 * 60 * 60 * 1000;
export const BROWSER_UPLOAD_VALIDATION_LEASE_MS = 10 * 60 * 1000;

export const UPLOAD_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

export type BrowserUploadStatus =
  | "issued"
  | "uploading"
  | "validating"
  | "published"
  | "failed"
  | "cancelled";

export type BrowserUploadSession = Omit<
  typeof browserUploadSessions.$inferSelect,
  "status"
> & { status: BrowserUploadStatus };

export class UploadHttpError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type BrowserUploadSource = {
  pendingId: string;
  fileUniqueId: string;
};

function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  return match?.[1] ?? null;
}

export function jsonNoStore(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(UPLOAD_RESPONSE_HEADERS)) {
    headers.set(name, value);
  }
  return Response.json(body, { ...init, headers });
}

export function assertSameOrigin(request: Request) {
  const suppliedOrigin = request.headers.get("origin");
  let requestOrigin: string;
  let normalizedOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
    normalizedOrigin = suppliedOrigin ? new URL(suppliedOrigin).origin : "";
  } catch {
    throw new UploadHttpError(403, "invalid_origin", "Недопустимый источник запроса.");
  }
  if (!suppliedOrigin || normalizedOrigin !== requestOrigin) {
    throw new UploadHttpError(403, "invalid_origin", "Недопустимый источник запроса.");
  }
}

export async function readSmallJson<T>(request: Request, maxBytes = 8 * 1024) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim();
  if (contentType !== "application/json") {
    throw new UploadHttpError(415, "json_required", "Ожидается JSON.");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new UploadHttpError(413, "request_too_large", "Запрос слишком большой.");
  }
  if (!request.body) {
    throw new UploadHttpError(400, "missing_body", "Пустой запрос.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UploadHttpError(413, "request_too_large", "Запрос слишком большой.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new UploadHttpError(400, "invalid_json", "Некорректный JSON.");
  }
}

export async function issueBrowserUploadSession(
  chatId: string,
  initialTtlMs = BROWSER_UPLOAD_IDLE_TTL_MS,
  source?: BrowserUploadSource,
) {
  if (!/^[-0-9]{1,32}$/.test(chatId)) {
    throw new Error("Invalid Telegram chat id");
  }
  if (!Number.isSafeInteger(initialTtlMs) || initialTtlMs <= 0) {
    throw new Error("Invalid upload session lifetime");
  }
  if (
    source &&
    (!/^[0-9a-f-]{36}$/i.test(source.pendingId) ||
      source.fileUniqueId.length < 1 ||
      source.fileUniqueId.length > 256 ||
      [...source.fileUniqueId].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      }))
  ) {
    throw new Error("Invalid Telegram upload source");
  }

  const id = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + Math.min(initialTtlMs, BROWSER_UPLOAD_ABSOLUTE_LIFETIME_MS);
  const objectKey = `price/versions/${id}.excel`;

  await getDb().insert(browserUploadSessions).values({
    id,
    tokenHash,
    chatId,
    status: "issued",
    objectKey,
    uploadId: null,
    originalName: null,
    fileSize: null,
    partSize: BROWSER_UPLOAD_PART_SIZE,
    sourcePendingId: source?.pendingId ?? null,
    sourceFileUniqueId: source?.fileUniqueId ?? null,
    operationNonce: null,
    createdAt: now,
    expiresAt,
    updatedAt: now,
    publishedAt: null,
  });

  return {
    id,
    token,
    expiresAt,
  };
}

export async function revokeIssuedBrowserUploadSession(id: string) {
  const [revoked] = await getDb()
    .delete(browserUploadSessions)
    .where(
      and(
        eq(browserUploadSessions.id, id),
        eq(browserUploadSessions.status, "issued"),
      ),
    )
    .returning({ id: browserUploadSessions.id });
  return Boolean(revoked);
}

export async function authenticateBrowserUpload(request: Request) {
  const token = bearerToken(request);
  if (!token) {
    throw new UploadHttpError(401, "invalid_token", "Ссылка недействительна.");
  }
  const tokenHash = await sha256Hex(token);
  const [session] = await getDb()
    .select()
    .from(browserUploadSessions)
    .where(eq(browserUploadSessions.tokenHash, tokenHash))
    .limit(1);
  if (!session) {
    throw new UploadHttpError(401, "invalid_token", "Ссылка недействительна.");
  }
  return session as BrowserUploadSession;
}

export async function getBrowserUploadSession(id: string) {
  const [session] = await getDb()
    .select()
    .from(browserUploadSessions)
    .where(eq(browserUploadSessions.id, id))
    .limit(1);
  return (session as BrowserUploadSession | undefined) ?? null;
}

export async function resetBrowserUploadSessionsForSource(
  runtimeEnv: RuntimeEnv,
  sourcePendingId: string,
) {
  const sessions = (await getDb()
    .select()
    .from(browserUploadSessions)
    .where(eq(browserUploadSessions.sourcePendingId, sourcePendingId))) as BrowserUploadSession[];

  for (const session of sessions) {
    if (session.status === "cancelled") {
      await cleanupCancelledSession(runtimeEnv, session);
    } else if (session.status !== "published") {
      await cancelSession(runtimeEnv, session);
    }
  }

  const [published] = await getDb()
    .select()
    .from(browserUploadSessions)
    .where(
      and(
        eq(browserUploadSessions.sourcePendingId, sourcePendingId),
        eq(browserUploadSessions.status, "published"),
      ),
    )
    .limit(1);
  if (published) return published as BrowserUploadSession;

  const [cleanupPending] = await getDb()
    .select({ id: browserUploadSessions.id })
    .from(browserUploadSessions)
    .where(
      and(
        eq(browserUploadSessions.sourcePendingId, sourcePendingId),
        ne(browserUploadSessions.status, "published"),
      ),
    )
    .limit(1);
  if (cleanupPending) {
    throw new UploadHttpError(
      503,
      "cleanup_pending",
      "Предыдущая загрузка ещё очищается. Повторите через несколько секунд.",
    );
  }
  return null;
}

export async function getPublishedBrowserUploadSessionForSource(
  sourcePendingId: string,
) {
  const [session] = await getDb()
    .select()
    .from(browserUploadSessions)
    .where(
      and(
        eq(browserUploadSessions.sourcePendingId, sourcePendingId),
        eq(browserUploadSessions.status, "published"),
      ),
    )
    .limit(1);
  return (session as BrowserUploadSession | undefined) ?? null;
}

export async function claimIssuedSession(
  session: BrowserUploadSession,
  uploadId: string,
  originalName: string,
  fileSize: number,
) {
  const now = Date.now();
  const expiresAt = Math.min(
    session.createdAt + BROWSER_UPLOAD_ABSOLUTE_LIFETIME_MS,
    now + BROWSER_UPLOAD_IDLE_TTL_MS,
  );
  const [claimed] = await getDb()
    .update(browserUploadSessions)
    .set({
      status: "uploading",
      uploadId,
      originalName,
      fileSize,
      expiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(browserUploadSessions.id, session.id),
        eq(browserUploadSessions.tokenHash, session.tokenHash),
        eq(browserUploadSessions.status, "issued"),
        gt(browserUploadSessions.expiresAt, now),
      ),
    )
    .returning();
  return (claimed as BrowserUploadSession | undefined) ?? null;
}

export async function touchUploadingSession(
  runtimeEnv: RuntimeEnv,
  session: BrowserUploadSession,
) {
  if (!session.uploadId) return null;
  const now = Date.now();
  const expiresAt = Math.min(
    session.createdAt + BROWSER_UPLOAD_ABSOLUTE_LIFETIME_MS,
    now + BROWSER_UPLOAD_IDLE_TTL_MS,
  );
  if (expiresAt <= now) return null;

  const touched = await runtimeEnv.DB.prepare(
    `UPDATE browser_upload_sessions
     SET expires_at = ?, updated_at = ?
     WHERE id = ? AND token_hash = ? AND upload_id = ?
       AND status = 'uploading' AND expires_at > ?
     RETURNING expires_at`,
  )
    .bind(
      expiresAt,
      now,
      session.id,
      session.tokenHash,
      session.uploadId,
      now,
    )
    .first<{ expires_at: number }>();
  return touched?.expires_at ?? null;
}

type CancelledCleanupTarget = Pick<
  BrowserUploadSession,
  "id" | "objectKey" | "uploadId"
>;

function missingMultipartUpload(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (
    candidate.status === 404 ||
    candidate.code === 10024 ||
    candidate.code === "10024"
  ) {
    return true;
  }
  return (
    typeof candidate.message === "string" &&
    /(?:not found|does not exist|already (?:aborted|completed))/i.test(
      candidate.message,
    )
  );
}

async function cleanupCancelledSession(
  runtimeEnv: RuntimeEnv,
  session: CancelledCleanupTarget,
) {
  if (session.uploadId) {
    try {
      await runtimeEnv.PRICE_FILES.resumeMultipartUpload(
        session.objectKey,
        session.uploadId,
      ).abort();
    } catch (error) {
      if (!missingMultipartUpload(error)) return false;
    }
  }

  try {
    await runtimeEnv.PRICE_FILES.delete(session.objectKey);
  } catch {
    return false;
  }

  const deleted = await runtimeEnv.DB.prepare(
    `DELETE FROM browser_upload_sessions
     WHERE id = ? AND status = 'cancelled' AND object_key = ?
       AND upload_id IS ?`,
  )
    .bind(session.id, session.objectKey, session.uploadId)
    .run();
  if ((deleted.meta.changes ?? 0) === 1) return true;

  const remaining = await runtimeEnv.DB.prepare(
    `SELECT id FROM browser_upload_sessions WHERE id = ? LIMIT 1`,
  )
    .bind(session.id)
    .first<{ id: string }>();
  return !remaining;
}

export async function cancelSession(
  runtimeEnv: RuntimeEnv,
  session: BrowserUploadSession,
) {
  const now = Date.now();
  let result = await runtimeEnv.DB.prepare(
    `UPDATE browser_upload_sessions
     SET status = 'cancelled', operation_nonce = NULL, updated_at = ?
     WHERE id = ? AND token_hash = ?
       AND status IN ('issued', 'uploading', 'validating', 'failed')
     RETURNING id, object_key, upload_id`,
  )
    .bind(now, session.id, session.tokenHash)
    .first<{ id: string; object_key: string; upload_id: string | null }>();

  if (!result) {
    result = await runtimeEnv.DB.prepare(
      `SELECT id, object_key, upload_id
       FROM browser_upload_sessions
       WHERE id = ? AND token_hash = ? AND status = 'cancelled'
       LIMIT 1`,
    )
      .bind(session.id, session.tokenHash)
      .first<{ id: string; object_key: string; upload_id: string | null }>();
  }
  if (!result) return false;

  return cleanupCancelledSession(runtimeEnv, {
    id: result.id,
    objectKey: result.object_key,
    uploadId: result.upload_id,
  });
}

export async function cancelExpiredSession(
  runtimeEnv: RuntimeEnv,
  session: BrowserUploadSession,
) {
  if (session.status === "published") return false;
  if (session.status === "cancelled") return cancelSession(runtimeEnv, session);
  if (session.expiresAt > Date.now()) return false;
  return cancelSession(runtimeEnv, session);
}

export function uploadShape(session: BrowserUploadSession) {
  if (!session.fileSize || !session.originalName) return null;
  return {
    id: session.id,
    status: session.status,
    filename: session.originalName,
    size: session.fileSize,
    partSize: session.partSize,
    totalParts: Math.ceil(session.fileSize / session.partSize),
    expiresAt: session.expiresAt,
  };
}

export async function claimValidationLease(
  runtimeEnv: RuntimeEnv,
  session: BrowserUploadSession,
) {
  const now = Date.now();
  const operationNonce = crypto.randomUUID();

  if (session.status === "uploading") {
    const claimed = await runtimeEnv.DB.prepare(
      `UPDATE browser_upload_sessions
       SET status = 'validating', operation_nonce = ?, updated_at = ?
       WHERE id = ? AND token_hash = ? AND status = 'uploading' AND expires_at > ?
       RETURNING id`,
    )
      .bind(
        operationNonce,
        now,
        session.id,
        session.tokenHash,
        now,
      )
      .first<{ id: string }>();
    return claimed ? operationNonce : null;
  }

  if (
    session.status === "validating" &&
    session.updatedAt <= now - BROWSER_UPLOAD_VALIDATION_LEASE_MS
  ) {
    const claimed = await runtimeEnv.DB.prepare(
      `UPDATE browser_upload_sessions
       SET operation_nonce = ?, updated_at = ?
       WHERE id = ? AND token_hash = ? AND status = 'validating'
         AND updated_at = ? AND expires_at > ?
       RETURNING id`,
    )
      .bind(
        operationNonce,
        now,
        session.id,
        session.tokenHash,
        session.updatedAt,
        now,
      )
      .first<{ id: string }>();
    return claimed ? operationNonce : null;
  }

  return null;
}

export async function failValidation(
  runtimeEnv: RuntimeEnv,
  session: BrowserUploadSession,
  operationNonce: string,
) {
  const failed = await runtimeEnv.DB.prepare(
    `UPDATE browser_upload_sessions
     SET status = 'failed', operation_nonce = NULL, updated_at = ?
     WHERE id = ? AND status = 'validating' AND operation_nonce = ?
     RETURNING id`,
  )
    .bind(Date.now(), session.id, operationNonce)
    .first<{ id: string }>();
  if (!failed) return false;

  if (session.sourcePendingId && session.sourceFileUniqueId) {
    await runtimeEnv.DB.prepare(
      `DELETE FROM pending_uploads
       WHERE id = ? AND chat_id = ? AND file_unique_id = ?`,
    )
      .bind(session.sourcePendingId, session.chatId, session.sourceFileUniqueId)
      .run();
  }

  const cleanup: Promise<unknown>[] = [runtimeEnv.PRICE_FILES.delete(session.objectKey)];
  if (session.uploadId) {
    cleanup.push(
      runtimeEnv.PRICE_FILES.resumeMultipartUpload(
        session.objectKey,
        session.uploadId,
      ).abort(),
    );
  }
  await Promise.allSettled(cleanup);
  return true;
}

export async function releaseValidationLease(
  runtimeEnv: RuntimeEnv,
  session: BrowserUploadSession,
  operationNonce: string,
) {
  const released = await runtimeEnv.DB.prepare(
    `UPDATE browser_upload_sessions
     SET status = 'uploading', operation_nonce = NULL, updated_at = ?
     WHERE id = ? AND token_hash = ? AND status = 'validating' AND operation_nonce = ?
     RETURNING id`,
  )
    .bind(Date.now(), session.id, session.tokenHash, operationNonce)
    .first<{ id: string }>();
  return Boolean(released);
}

export async function publishValidatedSession(
  runtimeEnv: RuntimeEnv,
  session: BrowserUploadSession,
  operationNonce: string,
  uploadedAt: number,
  newItemNames: string[] = [],
) {
  if (!session.originalName || !session.fileSize) return false;
  if (Boolean(session.sourcePendingId) !== Boolean(session.sourceFileUniqueId)) {
    return false;
  }
  const telegramFileUniqueId = session.sourceFileUniqueId ?? `web:${session.id}`;
  const guard = `EXISTS (
    SELECT 1 FROM browser_upload_sessions
    WHERE id = ? AND status = 'validating' AND operation_nonce = ?
  )`;
  const versionGuard = `EXISTS (
    SELECT 1 FROM price_versions
    WHERE id = ? AND telegram_file_unique_id = ?
  )`;
  const sourceGuard = session.sourcePendingId
    ? `AND EXISTS (
         SELECT 1 FROM pending_uploads
         WHERE id = ? AND chat_id = ? AND file_unique_id = ?
           AND original_name = ? AND file_size = ?
       )`
    : "";
  const sourceBindings = session.sourcePendingId
    ? [
        session.sourcePendingId,
        session.chatId,
        session.sourceFileUniqueId,
        session.originalName,
        session.fileSize,
      ]
    : [];

  const results = await runtimeEnv.DB.batch([
    runtimeEnv.DB.prepare(
      `INSERT INTO price_versions
         (id, object_key, original_name, file_size, uploaded_at, uploaded_by,
          telegram_file_unique_id, is_current)
       SELECT ?, ?, ?, ?, ?, ?, ?, 0
       WHERE ${guard} ${sourceGuard}
       ON CONFLICT(telegram_file_unique_id) DO NOTHING`,
    ).bind(
      session.id,
      session.objectKey,
      session.originalName,
      session.fileSize,
      uploadedAt,
      session.chatId,
      telegramFileUniqueId,
      session.id,
      operationNonce,
      ...sourceBindings,
    ),
    runtimeEnv.DB.prepare(
      `UPDATE price_versions SET is_current = 0
       WHERE is_current = 1 AND ${versionGuard} AND ${guard}`,
    ).bind(
      session.id,
      telegramFileUniqueId,
      session.id,
      operationNonce,
    ),
    runtimeEnv.DB.prepare(
      `UPDATE price_versions SET is_current = 1
       WHERE id = ? AND telegram_file_unique_id = ? AND ${guard}`,
    ).bind(session.id, telegramFileUniqueId, session.id, operationNonce),
    runtimeEnv.DB.prepare(
      `DELETE FROM pending_uploads
       WHERE id = ? AND chat_id = ? AND file_unique_id = ?
         AND ${versionGuard} AND ${guard}`,
    ).bind(
      session.sourcePendingId,
      session.chatId,
      session.sourceFileUniqueId,
      session.id,
      telegramFileUniqueId,
      session.id,
      operationNonce,
    ),
    runtimeEnv.DB.prepare(
      `UPDATE browser_upload_sessions
       SET status = 'published', published_at = ?, operation_nonce = NULL, updated_at = ?
       WHERE id = ? AND status = 'validating' AND operation_nonce = ?
         AND ${versionGuard}`,
    ).bind(
      uploadedAt,
      uploadedAt,
      session.id,
      operationNonce,
      session.id,
      telegramFileUniqueId,
    ),
    runtimeEnv.DB.prepare(
      `UPDATE browser_upload_sessions
       SET status = 'cancelled', operation_nonce = NULL, updated_at = ?
       WHERE id = ? AND token_hash = ?
         AND status = 'validating' AND operation_nonce = ?
         AND source_pending_id = ? AND source_file_unique_id = ?
         AND ? IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pending_uploads
           WHERE id = ? AND chat_id = ? AND file_unique_id = ?
             AND original_name = ? AND file_size = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM price_versions
           WHERE id = ? AND telegram_file_unique_id = ?
         )
       RETURNING id`,
    ).bind(
      uploadedAt,
      session.id,
      session.tokenHash,
      operationNonce,
      session.sourcePendingId,
      session.sourceFileUniqueId,
      session.sourcePendingId,
      session.sourcePendingId,
      session.chatId,
      session.sourceFileUniqueId,
      session.originalName,
      session.fileSize,
      session.id,
      telegramFileUniqueId,
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
        session.id,
        position,
        productName,
        session.id,
        telegramFileUniqueId,
      ),
    ),
  ]);

  const published = (results[4]?.meta.changes ?? 0) === 1;
  if (!published && (results[5]?.meta.changes ?? 0) === 1) {
    await cancelSession(runtimeEnv, session);
  }
  return published;
}

export async function tryNotifyTelegram(
  runtimeEnv: RuntimeEnv,
  chatId: string,
  text: string,
) {
  if (!runtimeEnv.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(
      telegramMethodUrl(runtimeEnv, "sendMessage"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      },
    );
  } catch {
    // The upload result is authoritative even when the notification cannot be delivered.
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof UploadHttpError) {
    return jsonNoStore(
      { ok: false, error: error.code, message: error.message },
      { status: error.status },
    );
  }
  return jsonNoStore(
    { ok: false, error: "internal_error", message: "Не удалось обработать загрузку." },
    { status: 500 },
  );
}
