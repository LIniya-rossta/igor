import {
  assertSameOrigin,
  authenticateBrowserUpload,
  BROWSER_UPLOAD_MAX_BYTES,
  cancelExpiredSession,
  claimIssuedSession,
  errorResponse,
  getBrowserUploadSession,
  jsonNoStore,
  readSmallJson,
  uploadShape,
  UploadHttpError,
  XLSX_MIME,
} from "@/lib/browser-upload";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { isXlsxFilename } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

type StartBody = {
  filename?: unknown;
  size?: unknown;
};

function validFilename(value: unknown) {
  if (typeof value !== "string") return null;
  const filename = value.trim().normalize("NFC");
  const hasControlCharacter = [...filename].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    filename.length < 1 ||
    filename.length > 180 ||
    hasControlCharacter ||
    filename.includes("/") ||
    filename.includes("\\") ||
    !isXlsxFilename(filename)
  ) {
    return null;
  }
  return filename;
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const runtimeEnv = getRuntimeEnv();
    const session = await authenticateBrowserUpload(request);

    if (
      session.expiresAt <= Date.now() &&
      session.status !== "published" &&
      session.status !== "cancelled"
    ) {
      await cancelExpiredSession(runtimeEnv, session);
      throw new UploadHttpError(410, "expired", "Срок действия ссылки истёк.");
    }

    const body = await readSmallJson<StartBody>(request);
    const filename = validFilename(body.filename);
    if (!filename) {
      throw new UploadHttpError(400, "invalid_filename", "Выберите файл с расширением .xlsx.");
    }
    if (
      typeof body.size !== "number" ||
      !Number.isSafeInteger(body.size) ||
      body.size <= 0
    ) {
      throw new UploadHttpError(400, "invalid_size", "Размер файла указан неверно.");
    }
    if (body.size > BROWSER_UPLOAD_MAX_BYTES) {
      throw new UploadHttpError(413, "file_too_large", "Максимальный размер файла — 1 ГБ.");
    }

    if (session.status === "uploading") {
      if (session.originalName !== filename || session.fileSize !== body.size) {
        throw new UploadHttpError(
          409,
          "session_already_started",
          "Эта ссылка уже используется для другого файла.",
        );
      }
      return jsonNoStore({ ok: true, ...uploadShape(session) });
    }
    if (session.status !== "issued") {
      throw new UploadHttpError(
        409,
        "invalid_state",
        session.status === "published"
          ? "Файл по этой ссылке уже опубликован."
          : "Эта ссылка больше не принимает файл.",
      );
    }

    const multipart = await runtimeEnv.PRICE_FILES.createMultipartUpload(
      session.objectKey,
      {
        httpMetadata: { contentType: XLSX_MIME },
        customMetadata: { uploadSessionId: session.id },
      },
    );
    let claimed: Awaited<ReturnType<typeof claimIssuedSession>>;
    try {
      claimed = await claimIssuedSession(
        session,
        multipart.uploadId,
        filename,
        body.size,
      );
    } catch (error) {
      await multipart.abort().catch(() => undefined);
      throw error;
    }
    if (claimed) {
      return jsonNoStore({ ok: true, ...uploadShape(claimed) }, { status: 201 });
    }

    await multipart.abort().catch(() => undefined);
    const current = await getBrowserUploadSession(session.id);
    if (
      current?.status === "uploading" &&
      current.originalName === filename &&
      current.fileSize === body.size
    ) {
      return jsonNoStore({ ok: true, ...uploadShape(current) });
    }
    throw new UploadHttpError(
      current && current.expiresAt <= Date.now() ? 410 : 409,
      current && current.expiresAt <= Date.now() ? "expired" : "invalid_state",
      current && current.expiresAt <= Date.now()
        ? "Срок действия ссылки истёк."
        : "Загрузка уже начата или отменена.",
    );
  } catch (error) {
    return errorResponse(error);
  }
}
