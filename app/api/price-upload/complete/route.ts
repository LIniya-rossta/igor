import {
  assertSameOrigin,
  authenticateBrowserUpload,
  cancelExpiredSession,
  claimValidationLease,
  errorResponse,
  failValidation,
  getBrowserUploadSession,
  jsonNoStore,
  publishValidatedSession,
  readSmallJson,
  releaseValidationLease,
  tryNotifyTelegram,
  UploadHttpError,
  type BrowserUploadSession,
} from "@/lib/browser-upload";
import { formatPriceDate, formatPriceVersion } from "@/lib/price";
import { getRuntimeEnv, type RuntimeEnv } from "@/lib/runtime-env";
import { formatFileSize, isValidXlsxObject } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

type CompleteBody = {
  parts?: unknown;
};

function completedPayload(session: BrowserUploadSession) {
  return {
    ok: true,
    id: session.id,
    status: "published",
    filename: session.originalName,
    size: session.fileSize,
    publishedAt: session.publishedAt,
    downloadUrl: "/api/price/download",
  };
}

function uploadedPartsFor(value: unknown, fileSize: number, partSize: number) {
  const totalParts = Math.ceil(fileSize / partSize);
  if (!Array.isArray(value) || value.length !== totalParts) return null;

  const uploadedParts: R2UploadedPart[] = [];
  const seen = new Set<number>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    const part = candidate as { partNumber?: unknown; etag?: unknown };
    if (
      typeof part.partNumber !== "number" ||
      !Number.isInteger(part.partNumber) ||
      typeof part.etag !== "string" ||
      !/^[\x21-\x7e]{1,256}$/.test(part.etag) ||
      part.partNumber < 1 ||
      part.partNumber > totalParts ||
      seen.has(part.partNumber)
    ) {
      return null;
    }
    seen.add(part.partNumber);
    uploadedParts.push({ partNumber: part.partNumber, etag: part.etag });
  }
  uploadedParts.sort((left, right) => left.partNumber - right.partNumber);
  for (let index = 0; index < uploadedParts.length; index += 1) {
    if (uploadedParts[index].partNumber !== index + 1) return null;
  }
  return uploadedParts;
}

async function completeMultipart(
  runtimeEnv: RuntimeEnv,
  session: BrowserUploadSession,
  parts: R2UploadedPart[],
) {
  const existing = await runtimeEnv.PRICE_FILES.head(session.objectKey);
  if (existing) return existing;
  if (!session.uploadId) throw new Error("Multipart upload id is missing");

  try {
    return await runtimeEnv.PRICE_FILES.resumeMultipartUpload(
      session.objectKey,
      session.uploadId,
    ).complete(parts);
  } catch (error) {
    const completed = await runtimeEnv.PRICE_FILES.head(session.objectKey);
    if (completed) return completed;
    throw error;
  }
}

function publicSiteUrl(runtimeEnv: RuntimeEnv, request: Request) {
  return (runtimeEnv.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, "");
}

function isDeterministicValidationError(error: unknown) {
  return (
    error instanceof UploadHttpError &&
    (error.code === "invalid_xlsx" || error.code === "size_mismatch")
  );
}

export async function POST(request: Request) {
  let leasedSession: BrowserUploadSession | null = null;
  let operationNonce: string | null = null;
  try {
    assertSameOrigin(request);
    const runtimeEnv = getRuntimeEnv();
    const session = await authenticateBrowserUpload(request);

    if (session.status === "published") {
      return jsonNoStore(completedPayload(session));
    }
    if (session.expiresAt <= Date.now()) {
      await cancelExpiredSession(runtimeEnv, session);
      throw new UploadHttpError(410, "expired", "Срок действия ссылки истёк.");
    }
    if (!session.fileSize || !session.originalName || !session.uploadId) {
      throw new UploadHttpError(409, "not_started", "Сначала выберите файл.");
    }
    if (session.status !== "uploading" && session.status !== "validating") {
      throw new UploadHttpError(
        409,
        "invalid_state",
        session.status === "failed"
          ? "Файл не прошёл проверку. Запросите новую ссылку."
          : "Загрузка была отменена.",
      );
    }

    const body = await readSmallJson<CompleteBody>(request, 128 * 1024);
    const parts = uploadedPartsFor(body.parts, session.fileSize, session.partSize);
    if (!parts) {
      throw new UploadHttpError(
        400,
        "invalid_parts",
        "Список загруженных частей неполный или повреждён.",
      );
    }

    operationNonce = await claimValidationLease(runtimeEnv, session);
    if (!operationNonce) {
      throw new UploadHttpError(
        409,
        "validation_in_progress",
        "Файл уже проверяется. Подождите немного.",
      );
    }
    leasedSession = { ...session, status: "validating", operationNonce };

    const object = await completeMultipart(runtimeEnv, leasedSession, parts);
    if (object.size !== leasedSession.fileSize) {
      throw new UploadHttpError(
        422,
        "size_mismatch",
        "Размер собранного файла не совпал с исходным.",
      );
    }

    const valid = await isValidXlsxObject(
      runtimeEnv.PRICE_FILES,
      leasedSession.objectKey,
      leasedSession.fileSize,
    );
    if (!valid) {
      throw new UploadHttpError(
        422,
        "invalid_xlsx",
        "Файл повреждён или не является корректным документом XLSX.",
      );
    }

    const uploadedAt = Date.now();
    const published = await publishValidatedSession(
      runtimeEnv,
      leasedSession,
      operationNonce,
      uploadedAt,
    );
    if (published) operationNonce = null;
    if (!published) {
      const current = await getBrowserUploadSession(leasedSession.id);
      if (current?.status === "published") {
        operationNonce = null;
        return jsonNoStore(completedPayload(current));
      }
      if (current?.status === "cancelled" || current?.status === "failed") {
        operationNonce = null;
        await runtimeEnv.PRICE_FILES.delete(leasedSession.objectKey).catch(() => undefined);
      }
      throw new UploadHttpError(
        409,
        "state_changed",
        "Состояние загрузки изменилось. Обновите страницу.",
      );
    }

    const publishedSession: BrowserUploadSession = {
      ...leasedSession,
      status: "published",
      operationNonce: null,
      publishedAt: uploadedAt,
      updatedAt: uploadedAt,
    };
    const siteUrl = publicSiteUrl(runtimeEnv, request);
    await tryNotifyTelegram(
      runtimeEnv,
      leasedSession.chatId,
      [
        "Готово — большой прайс опубликован.",
        `Файл: ${leasedSession.originalName}`,
        `Версия: ${formatPriceVersion(uploadedAt)}`,
        `Дата на сайте: ${formatPriceDate(uploadedAt)}`,
        `Размер: ${formatFileSize(leasedSession.fileSize)}`,
        "",
        `${siteUrl}/api/price/download`,
      ].join("\n"),
    );

    return jsonNoStore(completedPayload(publishedSession));
  } catch (error) {
    if (leasedSession && operationNonce) {
      try {
        const runtimeEnv = getRuntimeEnv();
        if (isDeterministicValidationError(error)) {
          const failed = await failValidation(runtimeEnv, leasedSession, operationNonce);
          if (failed) {
            const reason =
              error instanceof UploadHttpError && error.code === "size_mismatch"
                ? "размер собранного файла не совпал с исходным"
                : "это повреждённый или некорректный документ XLSX";
            await tryNotifyTelegram(
              runtimeEnv,
              leasedSession.chatId,
              `Файл «${leasedSession.originalName ?? "price.xlsx"}» отклонён: ${reason}. Запросите новую ссылку и загрузите файл ещё раз.`,
            );
          }
        } else {
          await releaseValidationLease(runtimeEnv, leasedSession, operationNonce);
        }
      } catch {
        // A stale validation lease can still be recovered by the timed CAS path.
      }
    }
    return errorResponse(error);
  }
}
