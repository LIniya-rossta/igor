import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { browserUploadSessions } from "@/db/schema";
import type { RuntimeEnv } from "@/lib/runtime-env";

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
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

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

export async function issueBrowserUploadSession(chatId: string) {
  if (!/^[-0-9]{1,32}$/.test(chatId)) {
    throw new Error("Invalid Telegram chat id");
  }

  const id = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + BROWSER_UPLOAD_IDLE_TTL_MS;
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

export async function cancelSession(
  runtimeEnv: RuntimeEnv,
  session: BrowserUploadSession,
) {
  const now = Date.now();
  const result = await runtimeEnv.DB.prepare(
    `UPDATE browser_upload_sessions
     SET status = 'cancelled', operation_nonce = NULL, updated_at = ?
     WHERE id = ? AND token_hash = ?
       AND status IN ('issued', 'uploading', 'validating', 'failed')
     RETURNING id, object_key, upload_id`,
  )
    .bind(now, session.id, session.tokenHash)
    .first<{ id: string; object_key: string; upload_id: string | null }>();

  if (!result) return false;
  const cleanup: Promise<unknown>[] = [runtimeEnv.PRICE_FILES.delete(result.object_key)];
  if (result.upload_id) {
    cleanup.push(
      runtimeEnv.PRICE_FILES.resumeMultipartUpload(
        result.object_key,
        result.upload_id,
      ).abort(),
    );
  }
  await Promise.allSettled(cleanup);
  return true;
}

export async function cancelExpiredSession(
  runtimeEnv: RuntimeEnv,
  session: BrowserUploadSession,
) {
  if (session.status === "published" || session.status === "cancelled") return false;
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
) {
  if (!session.originalName || !session.fileSize) return false;
  const telegramFileUniqueId = `web:${session.id}`;
  const guard = `EXISTS (
    SELECT 1 FROM browser_upload_sessions
    WHERE id = ? AND status = 'validating' AND operation_nonce = ?
  )`;

  const results = await runtimeEnv.DB.batch([
    runtimeEnv.DB.prepare(
      `INSERT INTO price_versions
         (id, object_key, original_name, file_size, uploaded_at, uploaded_by,
          telegram_file_unique_id, is_current)
       SELECT ?, ?, ?, ?, ?, ?, ?, 0
       WHERE ${guard}
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
    ),
    runtimeEnv.DB.prepare(
      `UPDATE price_versions SET is_current = 0
       WHERE is_current = 1 AND ${guard}`,
    ).bind(session.id, operationNonce),
    runtimeEnv.DB.prepare(
      `UPDATE price_versions SET is_current = 1
       WHERE id = ? AND telegram_file_unique_id = ? AND ${guard}`,
    ).bind(session.id, telegramFileUniqueId, session.id, operationNonce),
    runtimeEnv.DB.prepare(
      `UPDATE browser_upload_sessions
       SET status = 'published', published_at = ?, operation_nonce = NULL, updated_at = ?
       WHERE id = ? AND status = 'validating' AND operation_nonce = ?`,
    ).bind(uploadedAt, uploadedAt, session.id, operationNonce),
  ]);

  return (results[3]?.meta.changes ?? 0) === 1;
}

export async function tryNotifyTelegram(
  runtimeEnv: RuntimeEnv,
  chatId: string,
  text: string,
) {
  if (!runtimeEnv.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${runtimeEnv.TELEGRAM_BOT_TOKEN}/sendMessage`,
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
