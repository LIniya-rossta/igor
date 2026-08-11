import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { priceNewItems, priceVersions } from "@/db/schema";
import { priceInfo } from "@/app/price-config";
import { excelContentDisposition } from "@/lib/excel-file";

export type PriceVersion = typeof priceVersions.$inferSelect;

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
  return getDb()
    .select({ productName: priceNewItems.productName })
    .from(priceNewItems)
    .where(eq(priceNewItems.priceVersionId, current.id))
    .orderBy(priceNewItems.position);
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
