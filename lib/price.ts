import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { priceNewItems, priceVersions } from "@/db/schema";
import { priceInfo } from "@/app/price-config";
import { excelContentDisposition } from "@/lib/excel-file";
import { extractNewProductNamesFromExcelObject } from "@/lib/xlsx-new-items";
import { getRuntimeEnv } from "@/lib/runtime-env";

export type PriceVersion = typeof priceVersions.$inferSelect;

const NEW_ITEMS_CACHE_TTL_MS = 30_000;
let currentNewItemsCache: {
  expiresAt: number;
  request: Promise<string[]>;
} | null = null;

const bishkekDate = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Asia/Bishkek",
});

const bishkekVersion = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  timeZone: "Asia/Bishkek",
});

export async function getCurrentPriceVersion() {
  const [current] = await getDb()
    .select()
    .from(priceVersions)
    .where(eq(priceVersions.isCurrent, true))
    .orderBy(desc(priceVersions.uploadedAt))
    .limit(1);

  return current ?? null;
}

export async function getRecentPriceVersions(limit = 5) {
  return getDb()
    .select()
    .from(priceVersions)
    .orderBy(desc(priceVersions.uploadedAt))
    .limit(Math.min(Math.max(limit, 1), 10));
}

export async function getCurrentNewItems() {
  const current = await getCurrentPriceVersion();
  if (!current) return [];
  const database = getDb();
  const rows = await database
    .select({ productName: priceNewItems.productName })
    .from(priceNewItems)
    .where(eq(priceNewItems.priceVersionId, current.id))
    .orderBy(priceNewItems.position);

  if (rows.length > 0) return rows.map((row) => row.productName);

  // Older publications were created before the namespace-aware Excel scanner
  // was fixed. Recover their marked rows lazily from the already stored R2
  // object, then persist them so the next request is a normal D1 read.
  try {
    const recovered = await extractNewProductNamesFromExcelObject(
      getRuntimeEnv().PRICE_FILES,
      current.objectKey,
      current.originalName,
    );
    if (recovered.length === 0) return [];
    await database
      .insert(priceNewItems)
      .values(
        recovered.map((productName, position) => ({
          priceVersionId: current.id,
          position,
          productName,
        })),
      )
      .onConflictDoNothing();
    return recovered;
  } catch {
    return [];
  }
}

/**
 * Shared short-lived read cache for the public page and API route. Keeping the
 * in-flight promise prevents a burst of SSR/API requests from hitting D1
 * repeatedly after a cache miss.
 */
export function getCachedCurrentNewItems() {
  const now = Date.now();
  if (currentNewItemsCache && currentNewItemsCache.expiresAt > now) {
    return currentNewItemsCache.request;
  }

  const request = getCurrentNewItems();
  currentNewItemsCache = {
    request,
    expiresAt: now + NEW_ITEMS_CACHE_TTL_MS,
  };
  return request;
}

export function invalidatePriceReadCache() {
  currentNewItemsCache = null;
}

export function formatPriceDate(timestamp: number) {
  return bishkekDate.format(new Date(timestamp));
}

export function formatPriceVersion(timestamp: number) {
  return bishkekVersion.format(new Date(timestamp));
}

export function toPublicPriceMeta(version: PriceVersion | null) {
  if (!version) {
    return {
      updated: priceInfo.updated,
      version: priceInfo.version,
      filename: "UnB-price.xlsx",
      fileSize: null,
      uploadedAt: null,
      source: "fallback" as const,
    };
  }

  return {
    updated: formatPriceDate(version.uploadedAt),
    version: formatPriceVersion(version.uploadedAt),
    filename: version.originalName,
    fileSize: version.fileSize,
    uploadedAt: new Date(version.uploadedAt).toISOString(),
    source: "telegram" as const,
  };
}

export function contentDisposition(filename: string) {
  return excelContentDisposition(filename);
}
