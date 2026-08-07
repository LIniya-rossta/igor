import {
  assertSameOrigin,
  authenticateBrowserUpload,
  cancelSession,
  errorResponse,
  getBrowserUploadSession,
  jsonNoStore,
  UploadHttpError,
} from "@/lib/browser-upload";
import { getRuntimeEnv } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const runtimeEnv = getRuntimeEnv();
    const session = await authenticateBrowserUpload(request);

    if (session.status === "published") {
      throw new UploadHttpError(
        409,
        "already_published",
        "Опубликованный файл уже нельзя отменить.",
      );
    }

    const cancelled = await cancelSession(runtimeEnv, session);
    if (cancelled) {
      return jsonNoStore({ ok: true, id: session.id, status: "cancelled" });
    }

    const current = await getBrowserUploadSession(session.id);
    if (!current) {
      return jsonNoStore({ ok: true, id: session.id, status: "cancelled" });
    }
    if (current.status === "cancelled") {
      throw new UploadHttpError(
        503,
        "cleanup_pending",
        "Отмена сохранена, но очистка ещё не завершена. Повторите запрос.",
      );
    }
    throw new UploadHttpError(
      409,
      current?.status === "published" ? "already_published" : "state_changed",
      current?.status === "published"
        ? "Файл уже опубликован."
        : "Состояние загрузки изменилось. Обновите страницу.",
    );
  } catch (error) {
    return errorResponse(error);
  }
}
