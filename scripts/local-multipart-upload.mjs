import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";

export const LOCAL_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const LOCAL_UPLOAD_DEFAULT_ATTEMPTS = 3;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ETAG_PATTERN = /^[\x21-\x7e]{1,256}$/;
const MAX_SERVER_PARTS = 10_000;
const MAX_PART_BYTES = 64 * 1024 * 1024;

export class LocalMultipartUploadError extends Error {
  constructor(
    message,
    {
      status = 0,
      code = "local_upload_failed",
      retryable = false,
      cause,
    } = {},
  ) {
    super(message);
    this.name = "LocalMultipartUploadError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
  }
}

function safeExcelFilename(value) {
  if (typeof value !== "string") return null;
  const filename = value.trim().normalize("NFC");
  const lower = filename.toLowerCase();
  const hasControl = [...filename].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    filename.length < 1 ||
    filename.length > 180 ||
    hasControl ||
    filename.includes("/") ||
    filename.includes("\\") ||
    (!lower.endsWith(".xls") && !lower.endsWith(".xlsx"))
  ) {
    return null;
  }
  return filename;
}

function uploadOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LocalMultipartUploadError("Local upload origin is invalid", {
      code: "invalid_origin",
    });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new LocalMultipartUploadError("Local upload origin is invalid", {
      code: "invalid_origin",
    });
  }
  return url.origin;
}

function containedBy(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

async function canonicalRoots(allowedRoots) {
  if (allowedRoots === undefined) return null;
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new LocalMultipartUploadError("Allowed local file roots are invalid", {
      code: "invalid_allowed_roots",
    });
  }
  const roots = [];
  for (const root of allowedRoots) {
    if (typeof root !== "string" || !isAbsolute(root)) {
      throw new LocalMultipartUploadError("Allowed local file roots are invalid", {
        code: "invalid_allowed_roots",
      });
    }
    try {
      const canonical = await realpath(root);
      const rootStat = await stat(canonical);
      if (!rootStat.isDirectory()) throw new Error("Allowed root is not a directory");
      roots.push(canonical);
    } catch (error) {
      throw new LocalMultipartUploadError("Allowed local file root is unavailable", {
        code: "invalid_allowed_roots",
        cause: error,
      });
    }
  }
  return roots;
}

function retryableStatus(status) {
  return (
    status === 0 ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function abortedError(cause) {
  return new LocalMultipartUploadError("Local file upload was cancelled", {
    code: "aborted",
    cause,
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortedError(signal.reason);
}

async function defaultSleep(milliseconds, signal) {
  if (milliseconds <= 0) return;
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(abortedError(signal?.reason));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function responsePayload(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function requestJson(fetchImpl, url, init, signal) {
  throwIfAborted(signal);
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (signal?.aborted) throw abortedError(error);
    throw new LocalMultipartUploadError("Local upload API is unavailable", {
      code: "network_error",
      retryable: true,
      cause: error,
    });
  }

  let payload;
  try {
    payload = await responsePayload(response);
  } catch (error) {
    throw new LocalMultipartUploadError("Could not read the local upload response", {
      status: response.status,
      code: "response_read_failed",
      retryable: retryableStatus(response.status),
      cause: error,
    });
  }
  if (!response.ok) {
    const serverCode =
      payload && typeof payload.error === "string"
        ? payload.error.slice(0, 80)
        : "upload_rejected";
    const serverMessage =
      payload && typeof payload.message === "string"
        ? payload.message.slice(0, 240)
        : `Local upload API returned ${response.status}`;
    throw new LocalMultipartUploadError(serverMessage, {
      status: response.status,
      code: serverCode,
      retryable: retryableStatus(response.status),
    });
  }
  if (!payload || typeof payload !== "object") {
    throw new LocalMultipartUploadError("Local upload API returned invalid JSON", {
      status: response.status,
      code: "invalid_response",
      retryable: true,
    });
  }
  return payload;
}

async function withRetries(operation, attempts, retryDelayMs, sleep, signal) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await operation(attempt);
    } catch (error) {
      const normalized =
        error instanceof LocalMultipartUploadError
          ? error
          : new LocalMultipartUploadError("Local upload failed", {
              code: "unexpected_error",
              cause: error,
            });
      lastError = normalized;
      if (!normalized.retryable || attempt === attempts) throw normalized;
      await sleep(retryDelayMs * attempt, signal);
    }
  }
  throw lastError;
}

function sameFile(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function assertUnchanged(handle, initialStat) {
  const current = await handle.stat({ bigint: true });
  if (!sameFile(initialStat, current)) {
    throw new LocalMultipartUploadError(
      "The local Telegram file changed during upload",
      { code: "file_changed" },
    );
  }
}

function commonHeaders(origin, token) {
  return {
    Authorization: `Bearer ${token}`,
    Origin: origin,
  };
}

function validateStartPayload(payload, filename, size) {
  const partSize = payload.partSize;
  const totalParts = payload.totalParts;
  if (
    payload.ok !== true ||
    payload.status !== "uploading" ||
    payload.filename !== filename ||
    payload.size !== size ||
    !Number.isSafeInteger(partSize) ||
    partSize <= 0 ||
    partSize > MAX_PART_BYTES ||
    !Number.isSafeInteger(totalParts) ||
    totalParts < 1 ||
    totalParts > MAX_SERVER_PARTS ||
    totalParts !== Math.ceil(size / partSize)
  ) {
    throw new LocalMultipartUploadError(
      "Local upload API returned an invalid session shape",
      { code: "invalid_start_response", retryable: true },
    );
  }
  return { partSize, totalParts };
}

function validatePartPayload(payload, expectedPartNumber) {
  if (
    payload.ok !== true ||
    payload.partNumber !== expectedPartNumber ||
    typeof payload.etag !== "string" ||
    !ETAG_PATTERN.test(payload.etag)
  ) {
    throw new LocalMultipartUploadError(
      "Local upload API returned an invalid part response",
      { code: "invalid_part_response", retryable: true },
    );
  }
  return { partNumber: expectedPartNumber, etag: payload.etag };
}

function fileRangeStream(handle, start, endExclusive) {
  let position = start;
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      if (cancelled) return;
      if (position >= endExclusive) {
        controller.close();
        return;
      }
      const length = Math.min(64 * 1024, endExclusive - position);
      const chunk = new Uint8Array(length);
      try {
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (bytesRead !== length) {
          throw new LocalMultipartUploadError(
            "The local Telegram file ended during upload",
            { code: "file_changed" },
          );
        }
        position += bytesRead;
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}

/**
 * Streams an absolute file_path returned by a self-hosted Telegram Local Bot API
 * through the existing browser multipart endpoints. The bearer token must belong
 * to an already-issued browser upload session for the document owner.
 */
export async function uploadLocalExcelFile({
  filePath,
  filename = typeof filePath === "string" ? basename(filePath) : "",
  token,
  baseUrl = "http://localhost:3000",
  fetchImpl = globalThis.fetch,
  attempts = LOCAL_UPLOAD_DEFAULT_ATTEMPTS,
  retryDelayMs = 600,
  sleep = defaultSleep,
  signal,
  onProgress,
  allowedRoots,
  expectedSize,
}) {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) {
    throw new LocalMultipartUploadError(
      "Telegram Local Bot API did not return an absolute file path",
      { code: "invalid_file_path" },
    );
  }
  const safeFilename = safeExcelFilename(filename);
  if (!safeFilename) {
    throw new LocalMultipartUploadError("Local file must be XLS or XLSX", {
      code: "invalid_filename",
    });
  }
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new LocalMultipartUploadError("Browser upload token is invalid", {
      code: "invalid_token",
    });
  }
  if (
    expectedSize !== undefined &&
    (!Number.isSafeInteger(expectedSize) ||
      expectedSize <= 0 ||
      expectedSize > LOCAL_UPLOAD_MAX_BYTES)
  ) {
    throw new LocalMultipartUploadError("Expected Telegram file size is invalid", {
      code: "invalid_expected_size",
    });
  }
  if (typeof fetchImpl !== "function") {
    throw new LocalMultipartUploadError("Fetch implementation is unavailable", {
      code: "missing_fetch",
    });
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new LocalMultipartUploadError("Retry count is invalid", {
      code: "invalid_attempts",
    });
  }
  if (
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < 0 ||
    retryDelayMs > 60_000
  ) {
    throw new LocalMultipartUploadError("Retry delay is invalid", {
      code: "invalid_retry_delay",
    });
  }

  const origin = uploadOrigin(baseUrl);
  const roots = await canonicalRoots(allowedRoots);
  let canonicalPath;
  try {
    const pathStat = await lstat(filePath);
    if (pathStat.isSymbolicLink()) {
      throw new LocalMultipartUploadError(
        "Telegram Local Bot API path must not be a symbolic link",
        { code: "file_unavailable" },
      );
    }
    canonicalPath = await realpath(filePath);
  } catch (error) {
    if (error instanceof LocalMultipartUploadError) throw error;
    throw new LocalMultipartUploadError("Could not resolve the local Telegram file", {
      code: "file_unavailable",
      cause: error,
    });
  }
  if (roots && !roots.some((root) => containedBy(root, canonicalPath))) {
    throw new LocalMultipartUploadError(
      "Telegram Local Bot API file is outside the allowed roots",
      { code: "file_outside_allowed_roots" },
    );
  }
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(filePath, openFlags);
  } catch (error) {
    throw new LocalMultipartUploadError("Could not open the local Telegram file", {
      code: "file_unavailable",
      cause: error,
    });
  }

  try {
    const initialStat = await handle.stat({ bigint: true });
    const resolvedStat = await stat(canonicalPath, { bigint: true });
    if (
      initialStat.dev !== resolvedStat.dev ||
      initialStat.ino !== resolvedStat.ino
    ) {
      throw new LocalMultipartUploadError(
        "Telegram Local Bot API path changed while it was opened",
        { code: "file_changed" },
      );
    }
    if (!initialStat.isFile()) {
      throw new LocalMultipartUploadError(
        "Telegram Local Bot API path is not a regular file",
        { code: "invalid_file_type" },
      );
    }
    if (initialStat.size <= 0n) {
      throw new LocalMultipartUploadError("Local Excel file is empty", {
        code: "empty_file",
      });
    }
    if (initialStat.size > BigInt(LOCAL_UPLOAD_MAX_BYTES)) {
      throw new LocalMultipartUploadError("Local Excel file exceeds 1 GiB", {
        code: "file_too_large",
      });
    }
    const size = Number(initialStat.size);
    if (expectedSize !== undefined && size !== expectedSize) {
      throw new LocalMultipartUploadError(
        "Local file size does not match the Telegram document metadata",
        { code: "file_size_mismatch" },
      );
    }
    const headers = commonHeaders(origin, token);

    const { partSize, totalParts } = await withRetries(
      async () => {
        const payload = await requestJson(
          fetchImpl,
          `${origin}/api/price-upload/start`,
          {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ filename: safeFilename, size }),
          },
          signal,
        );
        return validateStartPayload(payload, safeFilename, size);
      },
      attempts,
      retryDelayMs,
      sleep,
      signal,
    );
    const uploadedParts = [];
    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      const start = (partNumber - 1) * partSize;
      const endExclusive = Math.min(start + partSize, size);
      const contentLength = endExclusive - start;
      const uploaded = await withRetries(
        async () => {
          await assertUnchanged(handle, initialStat);
          const body = fileRangeStream(handle, start, endExclusive);
          let payload;
          try {
            payload = await requestJson(
              fetchImpl,
              `${origin}/api/price-upload/part/${partNumber}`,
              {
                method: "PUT",
                headers: {
                  ...headers,
                  "Content-Type": "application/octet-stream",
                  "Content-Length": String(contentLength),
                  "Content-Encoding": "identity",
                },
                body,
                duplex: "half",
              },
              signal,
            );
          } finally {
            await body.cancel().catch(() => undefined);
          }
          await assertUnchanged(handle, initialStat);
          return validatePartPayload(payload, partNumber);
        },
        attempts,
        retryDelayMs,
        sleep,
        signal,
      );
      uploadedParts.push(uploaded);
      if (onProgress) {
        await onProgress({
          partNumber,
          totalParts,
          uploadedBytes: endExclusive,
          totalBytes: size,
        });
      }
    }

    await assertUnchanged(handle, initialStat);
    const completed = await withRetries(
      async () => {
        const payload = await requestJson(
          fetchImpl,
          `${origin}/api/price-upload/complete`,
          {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ parts: uploadedParts }),
          },
          signal,
        );
        if (payload.ok !== true || payload.status !== "published") {
          throw new LocalMultipartUploadError(
            "Local upload API did not publish the file",
            { code: "invalid_complete_response", retryable: true },
          );
        }
        return payload;
      },
      attempts,
      retryDelayMs,
      sleep,
      signal,
    );
    return {
      filename: safeFilename,
      size,
      partSize,
      totalParts,
      parts: uploadedParts,
      result: completed,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
