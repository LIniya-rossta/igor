import {
  assertSameOrigin,
  authenticateBrowserUpload,
  cancelExpiredSession,
  errorResponse,
  getBrowserUploadSession,
  jsonNoStore,
  touchUploadingSession,
  UploadHttpError,
} from "@/lib/browser-upload";
import { getRuntimeEnv } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ number: string }>;
};

function parseContentLength(request: Request) {
  const rawLength = request.headers.get("content-length");
  if (!rawLength || !/^\d+$/.test(rawLength)) {
    throw new UploadHttpError(
      411,
      "content_length_required",
      "Не удалось определить размер части файла.",
    );
  }
  const size = Number(rawLength);
  if (!Number.isSafeInteger(size)) {
    throw new UploadHttpError(400, "invalid_part_size", "Размер части указан неверно.");
  }
  return size;
}

function fixedLengthPartStream(body: ReadableStream<Uint8Array>, expectedSize: number) {
  const fixedLength = new FixedLengthStream(expectedSize);
  const reader = body.getReader();
  const writer = fixedLength.writable.getWriter();
  let abortPromise: Promise<void> | null = null;
  const abort = (reason: unknown) => {
    if (!abortPromise) {
      abortPromise = Promise.allSettled([
        reader.cancel(reason),
        writer.abort(reason),
        fixedLength.readable.cancel(reason),
      ]).then(() => undefined);
    }
    return abortPromise;
  };
  let bytesSeen = 0;
  const completed = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesSeen += value.byteLength;
        if (bytesSeen > expectedSize) {
          throw new UploadHttpError(
            400,
            "invalid_part_size",
            "Переданная часть имеет неверный размер.",
          );
        }
        await writer.write(value);
      }
      if (bytesSeen !== expectedSize) {
        throw new UploadHttpError(
          400,
          "invalid_part_size",
          "Переданная часть имеет неверный размер.",
        );
      }
      await writer.close();
    } catch (error) {
      await abort(error);
      throw error;
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  })();
  return { stream: fixedLength.readable, completed, abort };
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const runtimeEnv = getRuntimeEnv();
    const session = await authenticateBrowserUpload(request);
    if (session.expiresAt <= Date.now()) {
      await cancelExpiredSession(runtimeEnv, session);
      throw new UploadHttpError(410, "expired", "Срок действия ссылки истёк.");
    }
    if (
      session.status !== "uploading" ||
      !session.uploadId ||
      !session.fileSize ||
      !session.originalName
    ) {
      throw new UploadHttpError(409, "invalid_state", "Загрузка сейчас недоступна.");
    }

    const { number: rawPartNumber } = await context.params;
    if (!/^[1-9]\d*$/.test(rawPartNumber)) {
      throw new UploadHttpError(400, "invalid_part", "Номер части указан неверно.");
    }
    const partNumber = Number(rawPartNumber);
    const totalParts = Math.ceil(session.fileSize / session.partSize);
    if (!Number.isSafeInteger(partNumber) || partNumber > totalParts) {
      throw new UploadHttpError(400, "invalid_part", "Номер части указан неверно.");
    }

    const expectedSize =
      partNumber < totalParts
        ? session.partSize
        : session.fileSize - session.partSize * (totalParts - 1);
    const contentLength = parseContentLength(request);
    if (contentLength !== expectedSize) {
      throw new UploadHttpError(
        400,
        "invalid_part_size",
        `Эта часть должна занимать ${expectedSize} байт.`,
      );
    }
    const contentEncoding = request.headers.get("content-encoding");
    if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
      throw new UploadHttpError(
        415,
        "content_encoding_not_supported",
        "Сжатие частей файла не поддерживается.",
      );
    }
    if (!request.body) {
      throw new UploadHttpError(400, "missing_body", "Часть файла не передана.");
    }

    const current = await getBrowserUploadSession(session.id);
    if (
      current?.status !== "uploading" ||
      current.uploadId !== session.uploadId ||
      current.expiresAt <= Date.now()
    ) {
      throw new UploadHttpError(
        409,
        "state_changed",
        "Состояние загрузки изменилось. Обновите страницу.",
      );
    }

    const multipart = runtimeEnv.PRICE_FILES.resumeMultipartUpload(
      session.objectKey,
      session.uploadId,
    );
    const fixedBody = fixedLengthPartStream(request.body, expectedSize);
    const uploadPromise = multipart.uploadPart(partNumber, fixedBody.stream);
    let uploaded: R2UploadedPart;
    try {
      [uploaded] = await Promise.all([uploadPromise, fixedBody.completed]);
    } catch (error) {
      await fixedBody.abort(error);
      await Promise.allSettled([uploadPromise, fixedBody.completed]);
      throw error;
    }
    const expiresAt = await touchUploadingSession(runtimeEnv, session);
    if (!expiresAt) {
      throw new UploadHttpError(
        409,
        "state_changed",
        "Состояние загрузки изменилось. Обновите страницу.",
      );
    }

    return jsonNoStore({ ok: true, partNumber, etag: uploaded.etag, expiresAt });
  } catch (error) {
    return errorResponse(error);
  }
}
