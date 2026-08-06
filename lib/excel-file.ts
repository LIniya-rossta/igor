export const XLS_MIME = "application/vnd.ms-excel";
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type ExcelFileFormat = "xls" | "xlsx";

export function excelFileFormat(filename: string): ExcelFileFormat | null {
  const normalized = filename.trim().toLowerCase();
  if (normalized.endsWith(".xlsx")) return "xlsx";
  if (normalized.endsWith(".xls")) return "xls";
  return null;
}

export function isExcelFilename(filename: string) {
  return excelFileFormat(filename) !== null;
}

export function safeExcelUploadFilename(value: unknown) {
  if (typeof value !== "string") return null;
  const filename = value.trim().normalize("NFC");
  const hasControlCharacter = [...filename].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    filename.length < 1 ||
    filename.length > 180 ||
    hasControlCharacter ||
    filename.includes("/") ||
    filename.includes("\\") ||
    !isExcelFilename(filename)
  ) {
    return null;
  }
  return filename;
}

export function excelMimeType(filename: string) {
  return excelFileFormat(filename) === "xls" ? XLS_MIME : XLSX_MIME;
}

export function excelFallbackFilename(filename: string) {
  return excelFileFormat(filename) === "xls" ? "UnB-price.xls" : "UnB-price.xlsx";
}

export function excelContentDisposition(filename: string) {
  const fallback = excelFallbackFilename(filename);
  const safeOriginal = safeExcelUploadFilename(filename) ?? fallback;
  const encoded = encodeURIComponent(safeOriginal).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
