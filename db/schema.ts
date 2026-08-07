import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const claimAttempts = sqliteTable("claim_attempts", {
  chatId: text("chat_id").primaryKey(),
  attempts: integer("attempts").notNull(),
  windowStartedAt: integer("window_started_at").notNull(),
  blockedUntil: integer("blocked_until").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const pendingUploads = sqliteTable(
  "pending_uploads",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    telegramFileId: text("telegram_file_id").notNull(),
    fileUniqueId: text("file_unique_id").notNull(),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type"),
    fileSize: integer("file_size").notNull(),
    messageId: integer("message_id").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("pending_uploads_expires_at_idx").on(table.expiresAt),
    uniqueIndex("pending_uploads_chat_message_unique").on(table.chatId, table.messageId),
    uniqueIndex("pending_uploads_file_unique_id_unique").on(table.fileUniqueId),
  ],
);

export const priceVersions = sqliteTable(
  "price_versions",
  {
    id: text("id").primaryKey(),
    objectKey: text("object_key").notNull().unique(),
    originalName: text("original_name").notNull(),
    fileSize: integer("file_size").notNull(),
    uploadedAt: integer("uploaded_at").notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    telegramFileUniqueId: text("telegram_file_unique_id").notNull().unique(),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    index("price_versions_is_current_idx").on(table.isCurrent),
    index("price_versions_uploaded_at_idx").on(table.uploadedAt),
  ],
);

export const browserUploadSessions = sqliteTable(
  "browser_upload_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    chatId: text("chat_id").notNull(),
    status: text("status").notNull(),
    objectKey: text("object_key").notNull(),
    uploadId: text("upload_id"),
    originalName: text("original_name"),
    fileSize: integer("file_size"),
    partSize: integer("part_size").notNull(),
    sourcePendingId: text("source_pending_id"),
    sourceFileUniqueId: text("source_file_unique_id"),
    operationNonce: text("operation_nonce"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    publishedAt: integer("published_at"),
  },
  (table) => [
    uniqueIndex("browser_upload_sessions_token_hash_unique").on(table.tokenHash),
    uniqueIndex("browser_upload_sessions_object_key_unique").on(table.objectKey),
    index("browser_upload_sessions_expires_at_idx").on(table.expiresAt),
    index("browser_upload_sessions_chat_status_idx").on(table.chatId, table.status),
    uniqueIndex("browser_upload_sessions_source_pending_idx").on(table.sourcePendingId),
    check(
      "browser_upload_sessions_status_check",
      sql`${table.status} in ('issued', 'uploading', 'validating', 'published', 'failed', 'cancelled')`,
    ),
  ],
);
