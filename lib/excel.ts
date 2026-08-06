import {
  isValidXlsBytes,
  isValidXlsObject,
  MAX_XLS_OBJECT_BYTES,
} from "@/lib/xls";
import {
  isValidXlsxBytes,
  isValidXlsxObject,
  MAX_XLSX_BYTES,
} from "@/lib/xlsx";
import { excelFileFormat } from "@/lib/excel-file";

export * from "@/lib/excel-file";

export const MAX_TELEGRAM_EXCEL_BYTES = MAX_XLSX_BYTES;
export const MAX_EXCEL_OBJECT_BYTES = MAX_XLS_OBJECT_BYTES;

export async function isValidExcelBytes(bytes: Uint8Array, filename: string) {
  const format = excelFileFormat(filename);
  if (format === "xls") return isValidXlsBytes(bytes);
  if (format === "xlsx") return isValidXlsxBytes(bytes);
  return false;
}

export async function isValidExcelObject(
  bucket: R2Bucket,
  key: string,
  size: number,
  filename: string,
) {
  const format = excelFileFormat(filename);
  if (format === "xls") return isValidXlsObject(bucket, key, size);
  if (format === "xlsx") return isValidXlsxObject(bucket, key, size);
  return false;
}
