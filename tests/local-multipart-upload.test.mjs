import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LocalMultipartUploadError,
  uploadLocalExcelFile,
} from "../scripts/local-multipart-upload.mjs";

const TOKEN = "a".repeat(43);
const ORIGIN = "http://localhost:3000";

async function temporaryFile(t, name, bytes) {
  const directory = await mkdtemp(join(tmpdir(), "unb-local-upload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  await writeFile(path, bytes);
  return { directory, path };
}

async function readRequestBody(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(body, status = 200) {
  return Response.json(body, { status });
}

test("streams an absolute Telegram file through start, parts, and complete", async (t) => {
  const bytes = Buffer.from("0123456789");
  const { directory, path } = await temporaryFile(t, "Прайс.xlsx", bytes);
  const uploadedBodies = [];
  const requests = [];
  const progress = [];

  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers.Origin, ORIGIN);

    if (url.endsWith("/start")) {
      assert.deepEqual(JSON.parse(init.body), {
        filename: "Прайс.xlsx",
        size: bytes.length,
      });
      return json({
        ok: true,
        status: "uploading",
        filename: "Прайс.xlsx",
        size: bytes.length,
        partSize: 4,
        totalParts: 3,
      }, 201);
    }
    const partMatch = /\/part\/(\d+)$/.exec(url);
    if (partMatch) {
      const partNumber = Number(partMatch[1]);
      const body = await readRequestBody(init.body);
      uploadedBodies.push(body);
      assert.equal(init.duplex, "half");
      assert.equal(Number(init.headers["Content-Length"]), body.length);
      return json({ ok: true, partNumber, etag: `etag-${partNumber}` });
    }
    if (url.endsWith("/complete")) {
      assert.deepEqual(JSON.parse(init.body), {
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 2, etag: "etag-2" },
          { partNumber: 3, etag: "etag-3" },
        ],
      });
      return json({ ok: true, status: "published", id: "version-id" });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await uploadLocalExcelFile({
    filePath: path,
    filename: "Прайс.xlsx",
    token: TOKEN,
    baseUrl: `${ORIGIN}/api/telegram/webhook`,
    allowedRoots: [directory],
    fetchImpl,
    onProgress(value) {
      progress.push(value);
    },
  });

  assert.deepEqual(uploadedBodies, [
    Buffer.from("0123"),
    Buffer.from("4567"),
    Buffer.from("89"),
  ]);
  assert.equal(requests.length, 5);
  assert.equal(result.size, bytes.length);
  assert.equal(result.totalParts, 3);
  assert.deepEqual(
    progress.map(({ uploadedBytes }) => uploadedBytes),
    [4, 8, 10],
  );
});

test("reopens a part stream and retries only transient API failures", async (t) => {
  const bytes = Buffer.from("abcdefghijkl");
  const { path } = await temporaryFile(t, "price.xls", bytes);
  const attemptsByPart = new Map();
  const sleeps = [];

  const fetchImpl = async (url, init) => {
    if (url.endsWith("/start")) {
      return json({
        ok: true,
        status: "uploading",
        filename: "price.xls",
        size: bytes.length,
        partSize: 5,
        totalParts: 3,
      });
    }
    const partMatch = /\/part\/(\d+)$/.exec(url);
    if (partMatch) {
      const partNumber = Number(partMatch[1]);
      await readRequestBody(init.body);
      const attempt = (attemptsByPart.get(partNumber) ?? 0) + 1;
      attemptsByPart.set(partNumber, attempt);
      if (partNumber === 2 && attempt === 1) {
        return json({ ok: false, error: "temporary", message: "retry" }, 503);
      }
      return json({ ok: true, partNumber, etag: `etag-${partNumber}` });
    }
    return json({ ok: true, status: "published" });
  };

  await uploadLocalExcelFile({
    filePath: path,
    token: TOKEN,
    baseUrl: ORIGIN,
    fetchImpl,
    attempts: 2,
    retryDelayMs: 25,
    sleep(milliseconds) {
      sleeps.push(milliseconds);
    },
  });

  assert.equal(attemptsByPart.get(1), 1);
  assert.equal(attemptsByPart.get(2), 2);
  assert.equal(attemptsByPart.get(3), 1);
  assert.deepEqual(sleeps, [25]);
});

test("rejects relative paths, symlinks, and invalid session tokens before upload", async (t) => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return json({ ok: true });
  };

  await assert.rejects(
    () =>
      uploadLocalExcelFile({
        filePath: "relative/price.xlsx",
        token: TOKEN,
        fetchImpl,
      }),
    (error) =>
      error instanceof LocalMultipartUploadError &&
      error.code === "invalid_file_path",
  );

  const { directory, path } = await temporaryFile(t, "price.xlsx", "data");
  await assert.rejects(
    () =>
      uploadLocalExcelFile({
        filePath: path,
        token: "not-a-token",
        fetchImpl,
      }),
    (error) =>
      error instanceof LocalMultipartUploadError && error.code === "invalid_token",
  );

  const linked = join(directory, "linked.xlsx");
  await symlink(path, linked);
  await assert.rejects(
    () =>
      uploadLocalExcelFile({
        filePath: linked,
        token: TOKEN,
        fetchImpl,
      }),
    (error) =>
      error instanceof LocalMultipartUploadError &&
      error.code === "file_unavailable",
  );
  assert.equal(calls, 0);
});

test("keeps canonical local files inside explicitly allowed roots", async (t) => {
  const outside = await temporaryFile(t, "outside.xlsx", "data");
  const allowed = await temporaryFile(t, "inside.xlsx", "data");
  let calls = 0;
  await assert.rejects(
    () =>
      uploadLocalExcelFile({
        filePath: outside.path,
        token: TOKEN,
        allowedRoots: [allowed.directory],
        async fetchImpl() {
          calls += 1;
          return json({ ok: true });
        },
      }),
    (error) =>
      error instanceof LocalMultipartUploadError &&
      error.code === "file_outside_allowed_roots",
  );
  assert.equal(calls, 0);
});

test("matches the opened file size to Telegram document metadata", async (t) => {
  const { path } = await temporaryFile(t, "price.xlsx", "data");
  let calls = 0;
  await assert.rejects(
    () =>
      uploadLocalExcelFile({
        filePath: path,
        expectedSize: 5,
        token: TOKEN,
        async fetchImpl() {
          calls += 1;
          return json({ ok: true });
        },
      }),
    (error) =>
      error instanceof LocalMultipartUploadError &&
      error.code === "file_size_mismatch",
  );
  assert.equal(calls, 0);
});

test("stops when the local Telegram file changes during transfer", async (t) => {
  const bytes = Buffer.from("abcdefghij");
  const { path } = await temporaryFile(t, "price.xlsx", bytes);
  let mutated = false;

  const fetchImpl = async (url, init) => {
    if (url.endsWith("/start")) {
      return json({
        ok: true,
        status: "uploading",
        filename: "price.xlsx",
        size: bytes.length,
        partSize: 5,
        totalParts: 2,
      });
    }
    if (url.endsWith("/part/1")) {
      await readRequestBody(init.body);
      await appendFile(path, "changed");
      mutated = true;
      return json({ ok: true, partNumber: 1, etag: "etag-1" });
    }
    throw new Error(`Unexpected request after mutation: ${url}`);
  };

  await assert.rejects(
    () =>
      uploadLocalExcelFile({
        filePath: path,
        token: TOKEN,
        baseUrl: ORIGIN,
        fetchImpl,
      }),
    (error) =>
      error instanceof LocalMultipartUploadError && error.code === "file_changed",
  );
  assert.equal(mutated, true);
});

test("does not retry deterministic upload API rejections", async (t) => {
  const { path } = await temporaryFile(t, "price.xlsx", "data");
  let calls = 0;
  await assert.rejects(
    () =>
      uploadLocalExcelFile({
        filePath: path,
        token: TOKEN,
        baseUrl: ORIGIN,
        attempts: 3,
        retryDelayMs: 0,
        async fetchImpl() {
          calls += 1;
          return json(
            { ok: false, error: "invalid_excel", message: "rejected" },
            422,
          );
        },
      }),
    (error) =>
      error instanceof LocalMultipartUploadError &&
      error.status === 422 &&
      error.code === "invalid_excel" &&
      error.retryable === false,
  );
  assert.equal(calls, 1);
});

test("retries malformed start and incomplete publication responses", async (t) => {
  const { path } = await temporaryFile(t, "price.xlsx", "data");
  let startCalls = 0;
  let completeCalls = 0;
  const sleeps = [];

  await uploadLocalExcelFile({
    filePath: path,
    token: TOKEN,
    baseUrl: ORIGIN,
    attempts: 2,
    retryDelayMs: 5,
    sleep(milliseconds) {
      sleeps.push(milliseconds);
    },
    async fetchImpl(url, init) {
      if (url.endsWith("/start")) {
        startCalls += 1;
        return json({
          ok: true,
          status: startCalls === 1 ? "issued" : "uploading",
          filename: "price.xlsx",
          size: 4,
          partSize: 4,
          totalParts: 1,
        });
      }
      if (url.endsWith("/part/1")) {
        await readRequestBody(init.body);
        return json({ ok: true, partNumber: 1, etag: "etag-1" });
      }
      if (url.endsWith("/complete")) {
        completeCalls += 1;
        return json({
          ok: true,
          status: completeCalls === 1 ? "validating" : "published",
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(startCalls, 2);
  assert.equal(completeCalls, 2);
  assert.deepEqual(sleeps, [5, 5]);
});
