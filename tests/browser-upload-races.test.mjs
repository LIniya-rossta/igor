import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(
  new URL("./support/browser-upload-alias-loader.mjs", import.meta.url),
  import.meta.url,
);

const { cancelSession, publishValidatedSession } = await import(
  "../lib/browser-upload.ts"
);

class TestStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new TestStatement(this.database, this.sql, bindings);
  }

  execute({ first = false } = {}) {
    const statement = this.database.sqlite.prepare(this.sql);
    let rows;
    if (first) {
      const row = statement.get(...this.bindings);
      rows = row ? [row] : [];
    } else if (/\bRETURNING\b/i.test(this.sql)) {
      rows = statement.all(...this.bindings);
    } else {
      statement.run(...this.bindings);
      rows = [];
    }
    const { changes } = this.database.sqlite
      .prepare("SELECT changes() AS changes")
      .get();
    return { rows, changes: Number(changes) };
  }

  async first() {
    return this.execute({ first: true }).rows[0] ?? null;
  }

  async run() {
    const result = this.execute();
    return { meta: { changes: result.changes }, results: result.rows };
  }
}

class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(`
      CREATE TABLE pending_uploads (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        telegram_file_id TEXT NOT NULL,
        file_unique_id TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mime_type TEXT,
        file_size INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE price_versions (
        id TEXT PRIMARY KEY,
        object_key TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        uploaded_at INTEGER NOT NULL,
        uploaded_by TEXT NOT NULL,
        telegram_file_unique_id TEXT NOT NULL UNIQUE,
        is_current INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE browser_upload_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL,
        object_key TEXT NOT NULL UNIQUE,
        upload_id TEXT,
        original_name TEXT,
        file_size INTEGER,
        part_size INTEGER NOT NULL,
        source_pending_id TEXT UNIQUE,
        source_file_unique_id TEXT,
        operation_nonce TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        published_at INTEGER
      );
    `);
  }

  prepare(sql) {
    return new TestStatement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        const result = statement.execute();
        return { meta: { changes: result.changes }, results: result.rows };
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function uploadSession(overrides = {}) {
  const now = Date.now();
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tokenHash: "token-hash",
    chatId: "10001",
    status: "validating",
    objectKey: "price/versions/upload.excel",
    uploadId: "multipart-1",
    originalName: "price.xls",
    fileSize: 4096,
    partSize: 8 * 1024 * 1024,
    sourcePendingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sourceFileUniqueId: "telegram-file-1",
    operationNonce: "lease-1",
    createdAt: now - 1000,
    expiresAt: now + 60_000,
    updatedAt: now,
    publishedAt: null,
    ...overrides,
  };
}

function insertSession(database, session) {
  database.sqlite
    .prepare(
      `INSERT INTO browser_upload_sessions
       (id, token_hash, chat_id, status, object_key, upload_id, original_name,
        file_size, part_size, source_pending_id, source_file_unique_id,
        operation_nonce, created_at, expires_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      session.id,
      session.tokenHash,
      session.chatId,
      session.status,
      session.objectKey,
      session.uploadId,
      session.originalName,
      session.fileSize,
      session.partSize,
      session.sourcePendingId,
      session.sourceFileUniqueId,
      session.operationNonce,
      session.createdAt,
      session.expiresAt,
      session.updatedAt,
      session.publishedAt,
    );
}

function testRuntime({ abort = async () => {}, remove = async () => {} } = {}) {
  const DB = new TestD1();
  const calls = { abort: 0, remove: 0 };
  return {
    DB,
    calls,
    runtimeEnv: {
      DB,
      PRICE_FILES: {
        resumeMultipartUpload(objectKey, uploadId) {
          assert.equal(objectKey, "price/versions/upload.excel");
          assert.equal(uploadId, "multipart-1");
          return {
            async abort() {
              calls.abort += 1;
              return abort(calls.abort);
            },
          };
        },
        async delete(objectKey) {
          assert.equal(objectKey, "price/versions/upload.excel");
          calls.remove += 1;
          return remove(calls.remove);
        },
      },
    },
  };
}

test("publishes only while the exact Telegram pending row still exists", async () => {
  const { DB, runtimeEnv, calls } = testRuntime();
  const session = uploadSession();
  insertSession(DB, session);
  DB.sqlite
    .prepare(
      `INSERT INTO pending_uploads
       (id, chat_id, telegram_file_id, file_unique_id, original_name, mime_type,
        file_size, message_id, created_at, expires_at)
       VALUES (?, ?, 'file-id', ?, ?, NULL, ?, 1, 1, 9999999999999)`,
    )
    .run(
      session.sourcePendingId,
      session.chatId,
      session.sourceFileUniqueId,
      session.originalName,
      session.fileSize,
    );
  DB.sqlite.exec(`
    INSERT INTO price_versions
      (id, object_key, original_name, file_size, uploaded_at, uploaded_by,
       telegram_file_unique_id, is_current)
    VALUES
      ('old', 'price/versions/old.xls', 'old.xls', 10, 1, '10001', 'old-file', 1)
  `);

  const published = await publishValidatedSession(
    runtimeEnv,
    session,
    session.operationNonce,
    12345,
  );

  assert.equal(published, true);
  assert.equal(calls.abort, 0);
  assert.deepEqual(
    DB.sqlite
      .prepare("SELECT id, is_current FROM price_versions ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { id: session.id, is_current: 1 },
      { id: "old", is_current: 0 },
    ],
  );
  assert.equal(
    DB.sqlite.prepare("SELECT count(*) AS count FROM pending_uploads").get()
      .count,
    0,
  );
  assert.equal(
    DB.sqlite
      .prepare("SELECT status FROM browser_upload_sessions WHERE id = ?")
      .get(session.id).status,
    "published",
  );
});

test("ordinary browser uploads publish without a Telegram pending source", async () => {
  const { DB, runtimeEnv, calls } = testRuntime();
  const session = uploadSession({
    sourcePendingId: null,
    sourceFileUniqueId: null,
  });
  insertSession(DB, session);
  DB.sqlite.exec(`
    INSERT INTO price_versions
      (id, object_key, original_name, file_size, uploaded_at, uploaded_by,
       telegram_file_unique_id, is_current)
    VALUES
      ('old', 'price/versions/old.xls', 'old.xls', 10, 1, '10001', 'old-file', 1)
  `);

  const published = await publishValidatedSession(
    runtimeEnv,
    session,
    session.operationNonce,
    12345,
  );

  assert.equal(published, true);
  assert.equal(calls.abort, 0);
  assert.equal(calls.remove, 0);
  assert.deepEqual(
    DB.sqlite
      .prepare("SELECT id, telegram_file_unique_id, is_current FROM price_versions ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      {
        id: session.id,
        telegram_file_unique_id: `web:${session.id}`,
        is_current: 1,
      },
      { id: "old", telegram_file_unique_id: "old-file", is_current: 0 },
    ],
  );
});

test("cancel-before-issue cannot publish and cleans the late completed upload", async () => {
  const { DB, runtimeEnv, calls } = testRuntime();
  const session = uploadSession();
  insertSession(DB, session);

  const published = await publishValidatedSession(
    runtimeEnv,
    session,
    session.operationNonce,
    12345,
  );

  assert.equal(published, false);
  assert.equal(calls.abort, 1);
  assert.equal(calls.remove, 1);
  assert.equal(
    DB.sqlite.prepare("SELECT count(*) AS count FROM price_versions").get()
      .count,
    0,
  );
  assert.equal(
    DB.sqlite
      .prepare("SELECT count(*) AS count FROM browser_upload_sessions")
      .get().count,
    0,
  );
});

test("cancel cleanup retains its tombstone and retries transient R2 failures", async () => {
  const { DB, runtimeEnv, calls } = testRuntime({
    abort(call) {
      if (call === 1) throw new Error("temporary R2 failure");
      return undefined;
    },
    remove(call) {
      if (call === 1) throw new Error("temporary R2 failure");
      return undefined;
    },
  });
  const session = uploadSession({ status: "uploading", operationNonce: null });
  insertSession(DB, session);

  assert.equal(await cancelSession(runtimeEnv, session), false);
  assert.equal(calls.abort, 1);
  assert.equal(calls.remove, 0);
  assert.equal(
    DB.sqlite
      .prepare("SELECT status FROM browser_upload_sessions WHERE id = ?")
      .get(session.id).status,
    "cancelled",
  );

  assert.equal(await cancelSession(runtimeEnv, session), false);
  assert.equal(calls.abort, 2);
  assert.equal(calls.remove, 1);
  assert.equal(
    DB.sqlite
      .prepare("SELECT status FROM browser_upload_sessions WHERE id = ?")
      .get(session.id).status,
    "cancelled",
  );

  assert.equal(await cancelSession(runtimeEnv, session), true);
  assert.equal(calls.abort, 3);
  assert.equal(calls.remove, 2);
  assert.equal(
    DB.sqlite
      .prepare("SELECT count(*) AS count FROM browser_upload_sessions")
      .get().count,
    0,
  );
});
