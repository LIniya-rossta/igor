"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

const PART_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_PART_ATTEMPTS = 3;

type UploadedPart = {
  partNumber: number;
  etag: string;
};

type UploadPhase =
  | "ready"
  | "starting"
  | "uploading"
  | "finalizing"
  | "success"
  | "error";

type UploadContext = {
  file: File;
  parts: UploadedPart[];
  nextPart: number;
  started: boolean;
};

class UploadRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${bytes} Б`;
}

function isXlsx(file: File) {
  return file.name.toLowerCase().endsWith(".xlsx");
}

async function responseError(response: Response) {
  let message = "Сервер не принял запрос. Попробуйте ещё раз.";
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    if (typeof body.message === "string" && body.message.length < 240) message = body.message;
    else if (typeof body.error === "string" && body.error.length < 240) message = body.error;
  } catch {
    // A generic, non-sensitive message is enough for non-JSON failures.
  }

  if (response.status === 401 || response.status === 403 || response.status === 410) {
    message = "Ссылка недействительна или её срок истёк. Запросите новую командой /upload в Telegram.";
  } else if (response.status === 413) {
    message = "Файл превышает допустимый размер 1 ГБ.";
  }

  return new UploadRequestError(message, response.status);
}

async function apiRequest(
  path: string,
  token: string,
  init: RequestInit,
) {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw await responseError(response);
  return response;
}

export default function PriceUploadPage() {
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("ready");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Выберите актуальный Excel-прайс");
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const [retryLabel, setRetryLabel] = useState("Повторить загрузку");
  const inputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const contextRef = useRef<UploadContext | null>(null);

  useEffect(() => {
    let fragment = "";
    try {
      fragment = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      fragment = "";
    }

    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    queueMicrotask(() => {
      setToken(fragment || null);
      if (!fragment) {
        setError("В ссылке нет ключа доступа. Запросите новую ссылку командой /upload в Telegram.");
        setPhase("error");
      }
    });
  }, []);

  const selectFile = useCallback((file: File | null) => {
    if (!file) return;
    setError(null);
    setCanRetry(false);
    contextRef.current = null;
    setProgress(0);

    if (!isXlsx(file)) {
      setSelectedFile(null);
      setError("Выберите файл Excel с расширением .xlsx.");
      setStatus("Нужен файл формата XLSX");
      return;
    }
    if (file.size <= 0) {
      setSelectedFile(null);
      setError("Файл пуст. Выберите заполненный Excel-прайс.");
      setStatus("Файл не выбран");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setSelectedFile(null);
      setError("Файл больше 1 ГБ. Уменьшите его размер и попробуйте снова.");
      setStatus("Превышен лимит 1 ГБ");
      return;
    }

    setSelectedFile(file);
    setPhase("ready");
    setStatus("Файл готов к безопасной загрузке");
  }, []);

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    selectFile(event.target.files?.[0] ?? null);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (!busy && !(phase === "error" && !canRetry)) {
      selectFile(event.dataTransfer.files?.[0] ?? null);
    }
  };

  const continueUpload = useCallback(async () => {
    const currentToken = token;
    const context = contextRef.current;
    if (!currentToken || !context) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    setError(null);

    try {
      if (!context.started) {
        setPhase("starting");
        setStatus("Создаём защищённую загрузку…");
        await apiRequest("/api/price-upload/start", currentToken, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: context.file.name, size: context.file.size }),
          signal: controller.signal,
        });
        context.started = true;
      }

      const totalParts = Math.ceil(context.file.size / PART_BYTES);
      for (let partNumber = context.nextPart; partNumber <= totalParts; partNumber += 1) {
        const start = (partNumber - 1) * PART_BYTES;
        const end = Math.min(start + PART_BYTES, context.file.size);
        const chunk = context.file.slice(start, end);
        let uploaded: UploadedPart | null = null;

        for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt += 1) {
          setPhase("uploading");
          setStatus(
            attempt === 1
              ? `Загружаем часть ${partNumber} из ${totalParts}`
              : `Повторяем часть ${partNumber} · попытка ${attempt} из ${MAX_PART_ATTEMPTS}`,
          );
          try {
            const response = await apiRequest(`/api/price-upload/part/${partNumber}`, currentToken, {
              method: "PUT",
              headers: { "Content-Type": "application/octet-stream" },
              body: chunk,
              signal: controller.signal,
            });
            const result = (await response.json()) as UploadedPart;
            if (result.partNumber !== partNumber || !result.etag) {
              throw new UploadRequestError("Сервер вернул неполный ответ для части файла.", 502);
            }
            uploaded = result;
            break;
          } catch (uploadError) {
            if (controller.signal.aborted) throw uploadError;
            if (attempt === MAX_PART_ATTEMPTS) throw uploadError;
            await new Promise((resolve) => setTimeout(resolve, attempt * 600));
          }
        }

        if (!uploaded) throw new UploadRequestError("Не удалось загрузить часть файла.", 502);
        context.parts = [
          ...context.parts.filter((part) => part.partNumber !== uploaded.partNumber),
          uploaded,
        ].sort((left, right) => left.partNumber - right.partNumber);
        context.nextPart = partNumber + 1;
        setProgress(Math.round((end / context.file.size) * 100));
      }

      setPhase("finalizing");
      setStatus("Проверяем XLSX и публикуем прайс…");
      await apiRequest("/api/price-upload/complete", currentToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: context.parts }),
        signal: controller.signal,
      });

      contextRef.current = null;
      controllerRef.current = null;
      setCanRetry(false);
      setProgress(100);
      setPhase("success");
      setStatus("Новый прайс опубликован");
    } catch (uploadError) {
      controllerRef.current = null;
      if (controller.signal.aborted) return;
      const totalParts = Math.ceil(context.file.size / PART_BYTES);
      const requestStatus = uploadError instanceof UploadRequestError ? uploadError.status : 0;
      const retryable =
        requestStatus === 0 ||
        requestStatus === 429 ||
        requestStatus >= 500 ||
        (context.started && requestStatus === 409);
      setCanRetry(retryable);
      setRetryLabel(
        !context.started
          ? "Повторить загрузку"
          : context.nextPart <= totalParts
            ? `Повторить часть ${context.nextPart}`
            : "Повторить публикацию",
      );
      setPhase("error");
      setStatus(
        !context.started
          ? "Загрузка не началась"
          : context.nextPart <= totalParts
          ? `Остановились на части ${context.nextPart}`
          : "Не удалось завершить публикацию",
      );
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Не удалось загрузить файл. Проверьте интернет и повторите попытку.",
      );
    }
  }, [token]);

  const startUpload = () => {
    if (!selectedFile || !token) return;
    contextRef.current = {
      file: selectedFile,
      parts: [],
      nextPart: 1,
      started: false,
    };
    setCanRetry(false);
    void continueUpload();
  };

  const cancelUpload = async () => {
    const currentToken = token;
    controllerRef.current?.abort();
    controllerRef.current = null;
    contextRef.current = null;

    if (currentToken) {
      try {
        await apiRequest("/api/price-upload/cancel", currentToken, { method: "DELETE" });
      } catch {
        // The local UI can reset even if cleanup is already complete or the link expired.
      }
    }

    setSelectedFile(null);
    setProgress(0);
    setToken(null);
    setPhase("error");
    setCanRetry(false);
    setError("Ссылка отменена. Запросите новую командой /upload в Telegram.");
    setStatus("Загрузка отменена");
  };

  const busy = phase === "starting" || phase === "uploading" || phase === "finalizing";
  const locked = busy || (phase === "error" && !canRetry);
  return (
    <>
      <title>Безопасная загрузка прайса — UnB computers</title>
      <meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
      <meta name="referrer" content="no-referrer" />

      <main className={styles.page}>
        <header className={styles.header}>
          {/* Native links avoid the duplicate React context used by next/link in vinext dev. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a className={styles.brand} href="/" aria-label="UnB computers — на главную">
            <span>UnB</span>
            <small>computers</small>
          </a>
          <div className={styles.secureLabel}>
            <i aria-hidden="true" />
            Защищённая загрузка
          </div>
        </header>

        <section className={styles.content}>
          <div className={styles.intro}>
            <span className={styles.kicker}>UNB PRICE MANAGER / XLSX</span>
            <h1>Обновите прайс<br />одним файлом.</h1>
            <p>
              Выберите Excel-файл до 1 ГБ. Он загрузится частями, пройдёт проверку и сразу
              станет актуальным на сайте.
            </p>
            <div className={styles.steps} aria-label="Этапы публикации">
              <span><b>01</b> Выбрать</span>
              <span><b>02</b> Загрузить</span>
              <span><b>03</b> Опубликовать</span>
            </div>
          </div>

          <div className={styles.uploader}>
            <div className={styles.windowBar}>
              <div aria-hidden="true"><i /><i /><i /></div>
              <span>secure-upload.xlsx</span>
              <b>≤ 1 ГБ</b>
            </div>

            {phase === "success" ? (
              <div className={styles.success} role="status">
                <span className={styles.successMark} aria-hidden="true">✓</span>
                <span className={styles.miniLabel}>ПУБЛИКАЦИЯ ЗАВЕРШЕНА</span>
                <h2>Прайс обновлён</h2>
                <p>Дата и версия на сайте изменены. Посетители уже скачивают новый файл.</p>
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a href="/">Открыть сайт <span aria-hidden="true">↗</span></a>
              </div>
            ) : (
              <>
                <div
                  className={`${styles.dropzone} ${isDragging ? styles.dragging : ""} ${locked ? styles.disabled : ""}`}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    if (!locked) setIsDragging(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    if (event.currentTarget === event.target) setIsDragging(false);
                  }}
                  onDrop={handleDrop}
                >
                  <input
                    ref={inputRef}
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={handleFileInput}
                    disabled={locked}
                    className={styles.fileInput}
                    aria-label="Выбрать Excel-прайс"
                  />
                  <button
                    type="button"
                    className={styles.filePick}
                    onClick={() => inputRef.current?.click()}
                    disabled={locked}
                  >
                    <span className={styles.fileIcon} aria-hidden="true">X</span>
                    <span className={styles.fileCopy}>
                      {selectedFile ? (
                        <>
                          <b>{selectedFile.name}</b>
                          <small>{formatBytes(selectedFile.size)} · XLSX</small>
                        </>
                      ) : (
                        <>
                          <b>Перетащите XLSX сюда</b>
                          <small>или нажмите, чтобы выбрать файл</small>
                        </>
                      )}
                    </span>
                    <span className={styles.pickArrow} aria-hidden="true">↗</span>
                  </button>
                </div>

                <div className={styles.progressBlock} aria-live="polite">
                  <div className={styles.progressHeading}>
                    <span>{status}</span>
                    <b>{progress}%</b>
                  </div>
                  <div
                    className={styles.progressTrack}
                    role="progressbar"
                    aria-label="Прогресс загрузки"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                  >
                    <span style={{ width: `${progress}%` }} />
                  </div>
                </div>

                {error ? <p className={styles.error} role="alert">{error}</p> : null}

                <div className={styles.actions}>
                  {phase === "finalizing" ? (
                    <button type="button" className={styles.secondaryButton} disabled>
                      Публикуем и проверяем…
                    </button>
                  ) : busy ? (
                    <button type="button" className={styles.secondaryButton} onClick={() => void cancelUpload()}>
                      Отменить
                    </button>
                  ) : phase === "error" && canRetry ? (
                    <>
                      <button type="button" className={styles.primaryButton} onClick={() => void continueUpload()}>
                        {retryLabel} <span aria-hidden="true">↻</span>
                      </button>
                      <button type="button" className={styles.secondaryButton} onClick={() => void cancelUpload()}>
                        Отменить
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={startUpload}
                      disabled={!selectedFile || !token || phase === "error"}
                    >
                      Загрузить и опубликовать <span aria-hidden="true">→</span>
                    </button>
                  )}
                </div>

                <p className={styles.note}>
                  Начните за 30 минут. Во время передачи срок продлевается автоматически. Ссылка доступна только владельцу — не пересылайте её.
                </p>
              </>
            )}
          </div>
        </section>

        <footer className={styles.footer}>
          <span>UNB COMPUTERS · BISHKEK</span>
          <span>Файл передаётся по защищённому соединению</span>
        </footer>
      </main>
    </>
  );
}
