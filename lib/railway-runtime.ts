/*
 * Small Railway runtime adapter.
 *
 * The application was originally written against Cloudflare D1/R2. Railway
 * does not expose those bindings, so on Node we provide the same small subset
 * of the D1/R2 APIs used by the routes. Both stores live under the Railway
 * volume mount (RAILWAY_DATA_DIR or /data) and therefore survive restarts when
 * a volume is attached to the service.
 */

type NodeProcessLike = {
  versions?: { node?: string };
  env?: Record<string, string | undefined>;
  cwd?: () => string;
  getBuiltinModule?: (name: string) => any;
};

type NodeModules = {
  fs: any;
  path: any;
  crypto: any;
  DatabaseSync: new (filename: string) => any;
};

function nodeProcess() {
  const candidate = (globalThis as { process?: NodeProcessLike }).process;
  return candidate?.versions?.node && candidate.getBuiltinModule ? candidate : null;
}

function loadNodeModules(processLike: NodeProcessLike): NodeModules {
  const fs = processLike.getBuiltinModule!("node:fs");
  const path = processLike.getBuiltinModule!("node:path");
  const crypto = processLike.getBuiltinModule!("node:crypto");
  const sqlite = processLike.getBuiltinModule!("node:sqlite");
  return { fs, path, crypto, DatabaseSync: sqlite.DatabaseSync };
}

type D1Result<T = Record<string, unknown>> = {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id?: number };
};

class LocalD1Statement {
  private readonly statement: any;
  private parameters: unknown[] = [];

  constructor(private readonly database: LocalD1Database, query: string) {
    this.statement = database.raw.prepare(query);
  }

  bind(...parameters: unknown[]) {
    this.parameters = parameters;
    return this;
  }

  async first<T = Record<string, unknown>>() {
    const row = this.statement.get(...this.parameters);
    return (row ?? null) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.statement.all(...this.parameters) as T[];
    return {
      results: rows,
      success: true,
      meta: { changes: 0 },
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.statement.all(...this.parameters) as Record<string, unknown>[];
    return rows.map((row) => Object.values(row)) as T[];
  }

  async run(): Promise<D1Result> {
    const result = this.statement.run(...this.parameters);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(result.changes ?? 0),
        last_row_id: Number(result.lastInsertRowid ?? 0),
      },
    };
  }
}

export class LocalD1Database {
  readonly raw: any;

  constructor(private readonly modules: NodeModules, filename: string) {
    this.raw = new modules.DatabaseSync(filename);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA busy_timeout = 5000;");
    this.ensureSchema();
  }

  prepare(query: string) {
    return new LocalD1Statement(this, query);
  }

  async batch(statements: LocalD1Statement[]) {
    this.raw.exec("BEGIN;");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT;");
      return results;
    } catch (error) {
      try {
        this.raw.exec("ROLLBACK;");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    }
  }

  private ensureSchema() {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claim_attempts (
        chat_id TEXT PRIMARY KEY NOT NULL,
        attempts INTEGER NOT NULL,
        window_started_at INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_uploads (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        telegram_file_id TEXT NOT NULL,
        file_unique_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime_type TEXT,
        file_size INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pending_uploads_chat_message_unique
        ON pending_uploads (chat_id, message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS pending_uploads_file_unique_id_unique
        ON pending_uploads (file_unique_id);
      CREATE INDEX IF NOT EXISTS pending_uploads_expires_at_idx
        ON pending_uploads (expires_at);
      CREATE TABLE IF NOT EXISTS price_versions (
        id TEXT PRIMARY KEY NOT NULL,
        object_key TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        uploaded_at INTEGER NOT NULL,
        uploaded_by TEXT NOT NULL,
        telegram_file_unique_id TEXT NOT NULL UNIQUE,
        is_current INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS price_versions_is_current_idx
        ON price_versions (is_current);
      CREATE INDEX IF NOT EXISTS price_versions_uploaded_at_idx
        ON price_versions (uploaded_at);
      CREATE TABLE IF NOT EXISTS price_new_items (
        price_version_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        product_name TEXT NOT NULL,
        PRIMARY KEY (price_version_id, position)
      );
      CREATE INDEX IF NOT EXISTS price_new_items_version_idx
        ON price_new_items (price_version_id);
      CREATE TABLE IF NOT EXISTS browser_upload_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL,
        object_key TEXT NOT NULL UNIQUE,
        upload_id TEXT,
        original_name TEXT,
        file_size INTEGER,
        part_size INTEGER NOT NULL,
        source_pending_id TEXT,
        source_file_unique_id TEXT,
        operation_nonce TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        published_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS browser_upload_sessions_source_pending_idx
        ON browser_upload_sessions (source_pending_id);
      CREATE INDEX IF NOT EXISTS browser_upload_sessions_expires_at_idx
        ON browser_upload_sessions (expires_at);
      CREATE INDEX IF NOT EXISTS browser_upload_sessions_chat_status_idx
        ON browser_upload_sessions (chat_id, status);
    `);

    // These columns were added after the initial schema. Existing Railway
    // volumes may already contain the database, so make the upgrades idempotent.
    for (const statement of [
      "ALTER TABLE browser_upload_sessions ADD COLUMN source_pending_id TEXT",
      "ALTER TABLE browser_upload_sessions ADD COLUMN source_file_unique_id TEXT",
    ]) {
      try {
        this.raw.exec(statement);
      } catch {
        // SQLite reports a duplicate-column error on already upgraded stores.
      }
    }
  }
}

type LocalObject = {
  body: ReadableStream<Uint8Array>;
  bodyUsed: false;
  size: number;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: Record<string, unknown>;
  customMetadata?: Record<string, string>;
};

function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return typeof value === "object" && value !== null && "byteLength" in value;
}

function streamFromFile(
  modules: NodeModules,
  filename: string,
  offset = 0,
  length?: number,
) {
  const fd = modules.fs.openSync(filename, "r");
  let position = offset;
  let remaining = length ?? Number.POSITIVE_INFINITY;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      modules.fs.closeSync(fd);
    } catch {
      // The file may already have been closed after an end-of-stream read.
    }
  };

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        close();
        controller.close();
        return;
      }
      const chunkSize = Math.min(8 * 1024 * 1024, remaining);
      const buffer = Buffer.allocUnsafe(chunkSize);
      const read = modules.fs.readSync(fd, buffer, 0, chunkSize, position);
      if (read <= 0) {
        close();
        controller.close();
        return;
      }
      position += read;
      remaining -= read;
      controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, read));
      if (remaining <= 0) {
        close();
        controller.close();
      }
    },
    cancel() {
      close();
    },
  });
}

async function writeBody(modules: NodeModules, filename: string, body: unknown) {
  const fd = modules.fs.openSync(filename, "w");
  try {
    if (body instanceof ReadableStream) {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) {
            modules.fs.writeSync(fd, Buffer.from(value.buffer, value.byteOffset, value.byteLength));
          }
        }
      } finally {
        reader.releaseLock();
      }
      return;
    }

    if (body instanceof ArrayBuffer) {
      modules.fs.writeSync(fd, Buffer.from(body));
      return;
    }
    if (isArrayBufferView(body)) {
      modules.fs.writeSync(fd, Buffer.from(body.buffer, body.byteOffset, body.byteLength));
      return;
    }
    if (typeof body === "string") {
      modules.fs.writeSync(fd, body);
      return;
    }
    throw new TypeError("Unsupported object body");
  } finally {
    modules.fs.closeSync(fd);
  }
}

export class LocalR2Bucket {
  constructor(
    private readonly modules: NodeModules,
    private readonly root: string,
  ) {
    modules.fs.mkdirSync(root, { recursive: true });
  }

  private fileFor(key: string) {
    if (!key || key.startsWith("/") || key.split("/").includes("..")) {
      throw new Error("Invalid object key");
    }
    return this.modules.path.join(this.root, key);
  }

  private etag(filename: string, stat: any) {
    return `"${this.modules.crypto
      .createHash("sha1")
      .update(`${filename}:${stat.size}:${stat.mtimeMs}`)
      .digest("hex")}"`;
  }

  private metadata(filename: string): LocalObject | null {
    try {
      const stat = this.modules.fs.statSync(filename);
      if (!stat.isFile()) return null;
      return {
        body: streamFromFile(this.modules, filename, 0, stat.size),
        bodyUsed: false,
        size: stat.size,
        httpEtag: this.etag(filename, stat),
        uploaded: stat.mtime,
      };
    } catch {
      return null;
    }
  }

  async head(key: string) {
    return this.metadata(this.fileFor(key));
  }

  async get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }) {
    const filename = this.fileFor(key);
    let stat: any;
    try {
      stat = this.modules.fs.statSync(filename);
    } catch {
      return null;
    }
    let offset = 0;
    let length = stat.size;
    const range = options?.range;
    if (range?.suffix !== undefined) {
      length = Math.min(stat.size, range.suffix);
      offset = stat.size - length;
    } else if (range?.offset !== undefined) {
      offset = Math.max(0, range.offset);
      length = range.length === undefined ? stat.size - offset : Math.min(range.length, stat.size - offset);
    }
    const object = this.metadata(filename);
    if (!object) return null;
    return {
      ...object,
      body: streamFromFile(this.modules, filename, offset, length),
      size: length,
    };
  }

  async put(key: string, body: unknown) {
    const filename = this.fileFor(key);
    this.modules.fs.mkdirSync(this.modules.path.dirname(filename), { recursive: true });
    await writeBody(this.modules, filename, body);
    return this.metadata(filename);
  }

  async delete(key: string) {
    try {
      this.modules.fs.rmSync(this.fileFor(key), { force: true });
    } catch {
      // R2 delete is idempotent.
    }
  }

  async createMultipartUpload(key: string, options?: Record<string, unknown>) {
    const uploadId = this.modules.crypto.randomUUID();
    const directory = this.modules.path.join(this.root, ".multipart", uploadId);
    this.modules.fs.mkdirSync(directory, { recursive: true });
    this.modules.fs.writeFileSync(
      this.modules.path.join(directory, "meta.json"),
      JSON.stringify({ key, options }),
    );
    return this.multipart(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    return this.multipart(key, uploadId);
  }

  private multipart(key: string, uploadId: string) {
    const directory = this.modules.path.join(this.root, ".multipart", uploadId);
    const partFile = (partNumber: number) =>
      this.modules.path.join(directory, `${partNumber}.part`);
    return {
      uploadId,
      uploadPart: async (partNumber: number, body: unknown) => {
        this.modules.fs.mkdirSync(directory, { recursive: true });
        const filename = partFile(partNumber);
        await writeBody(this.modules, filename, body);
        const stat = this.modules.fs.statSync(filename);
        return {
          partNumber,
          etag: this.etag(filename, stat),
        };
      },
      complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
        const filename = this.fileFor(key);
        this.modules.fs.mkdirSync(this.modules.path.dirname(filename), { recursive: true });
        const output = this.modules.fs.openSync(filename, "w");
        try {
          for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
            const source = this.modules.fs.openSync(partFile(part.partNumber), "r");
            try {
              const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
              while (true) {
                const read = this.modules.fs.readSync(source, buffer, 0, buffer.length, null);
                if (read <= 0) break;
                this.modules.fs.writeSync(output, buffer, 0, read);
              }
            } finally {
              this.modules.fs.closeSync(source);
            }
          }
        } finally {
          this.modules.fs.closeSync(output);
          this.modules.fs.rmSync(directory, { recursive: true, force: true });
        }
        return this.metadata(filename);
      },
      abort: async () => {
        this.modules.fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  }
}

type RailwayRuntime = {
  DB: LocalD1Database;
  PRICE_FILES: LocalR2Bucket;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_CLAIM_CODE?: string;
  TELEGRAM_API_BASE_URL?: string;
  TELEGRAM_LOCAL_BRIDGE_SECRET?: string;
  PUBLIC_SITE_URL?: string;
};

let cachedRuntime: RailwayRuntime | null = null;

export function isRailwayNodeRuntime() {
  const processLike = nodeProcess();
  // Railway sets RAILWAY_ENVIRONMENT_ID, but local `vinext start` also runs
  // the Node adapter. Detect the runtime by Node's built-in module loader so
  // local production smoke tests do not attempt to import `cloudflare:` URLs.
  return Boolean(processLike?.versions?.node && processLike.getBuiltinModule);
}

export function getRailwayRuntime(): RailwayRuntime {
  if (cachedRuntime) return cachedRuntime;
  const processLike = nodeProcess();
  if (!processLike) throw new Error("Railway runtime requires Node.js");
  const modules = loadNodeModules(processLike);
  const env = processLike.env ?? {};
  const cwd = processLike.cwd?.() ?? ".";
  const preferredRoot = env.RAILWAY_DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || "/data";
  let dataRoot = preferredRoot;
  try {
    modules.fs.mkdirSync(dataRoot, { recursive: true });
    modules.fs.accessSync(dataRoot, modules.fs.constants.W_OK);
  } catch {
    dataRoot = modules.path.join(cwd, ".railway-data");
    modules.fs.mkdirSync(dataRoot, { recursive: true });
  }

  cachedRuntime = {
    DB: new LocalD1Database(modules, modules.path.join(dataRoot, "igor.sqlite")),
    PRICE_FILES: new LocalR2Bucket(modules, modules.path.join(dataRoot, "price-files")),
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET,
    TELEGRAM_CLAIM_CODE: env.TELEGRAM_CLAIM_CODE,
    TELEGRAM_API_BASE_URL: env.TELEGRAM_API_BASE_URL,
    TELEGRAM_LOCAL_BRIDGE_SECRET: env.TELEGRAM_LOCAL_BRIDGE_SECRET,
    PUBLIC_SITE_URL: env.PUBLIC_SITE_URL,
  };
  return cachedRuntime;
}
