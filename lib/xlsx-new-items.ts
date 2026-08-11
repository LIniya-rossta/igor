import { excelFileFormat } from "./excel-file";
import {
  extractNewProductNamesFromXlsBytes,
  extractNewProductNamesFromXlsObject,
} from "./xls";

/**
 * The new-items marker is intentionally based on the cell fill, not on a
 * product name or an ID. This keeps the workflow compatible with the way the
 * owner already prepares the price list in Excel.
 */
export type NewItemScanSource = {
  read(offset: number, length: number): Promise<Uint8Array>;
  size: number;
};

type ZipEntry = {
  name: string;
  flags: number;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_BYTES = 22 + 0xffff;
const MAX_ZIP_ENTRIES = 4096;
const MAX_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
// Keeps the D1 publication batch below its statement limit while still
// allowing a normal supplier sheet to publish every marked product.
const MAX_NEW_ITEMS = 80;

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function safeZipPath(name: string) {
  return (
    name.length > 0 &&
    name.length <= 1024 &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.split("/").includes("..")
  );
}

function readBodyExactly(body: ReadableStream<Uint8Array>, expectedLength: number) {
  return (async () => {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || total + value.byteLength > expectedLength) {
          await reader.cancel().catch(() => undefined);
          throw new Error("Invalid ranged object body");
        }
        total += value.byteLength;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (total !== expectedLength) throw new Error("Incomplete ranged object body");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  })();
}

class ByteSource implements NewItemScanSource {
  readonly size: number;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.size = bytes.byteLength;
  }

  async read(offset: number, length: number) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) {
      throw new Error("Invalid byte range");
    }
    return this.bytes.subarray(offset, offset + length);
  }
}

class R2Source implements NewItemScanSource {
  readonly size: number;
  private readonly bucket: R2Bucket;
  private readonly key: string;
  private readonly etag: string;

  private constructor(bucket: R2Bucket, key: string, size: number, etag: string) {
    this.bucket = bucket;
    this.key = key;
    this.size = size;
    this.etag = etag;
  }

  static async open(bucket: R2Bucket, key: string) {
    const head = await bucket.head(key);
    if (!head) throw new Error("Price object is missing");
    return new R2Source(bucket, key, head.size, head.etag);
  }

  async read(offset: number, length: number) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) {
      throw new Error("Invalid R2 byte range");
    }
    if (length === 0) return new Uint8Array();
    const object = await this.bucket.get(this.key, {
      range: { offset, length },
      onlyIf: { etagMatches: this.etag },
    });
    if (!object || !("body" in object) || object.size !== this.size || object.etag !== this.etag) {
      throw new Error("Price object changed during new-item scan");
    }
    return readBodyExactly(object.body, length);
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array) {
  if (bytes.length < 22) return -1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  return -1;
}

async function readZipDirectory(source: NewItemScanSource) {
  const suffixLength = Math.min(source.size, MAX_EOCD_BYTES);
  const suffixOffset = source.size - suffixLength;
  const suffix = await source.read(suffixOffset, suffixLength);
  const relativeEocdOffset = findEndOfCentralDirectory(suffix);
  if (relativeEocdOffset < 0) throw new Error("ZIP end record is missing");

  const view = new DataView(suffix.buffer, suffix.byteOffset, suffix.byteLength);
  const entryCount = view.getUint16(relativeEocdOffset + 10, true);
  const centralSize = view.getUint32(relativeEocdOffset + 12, true);
  const centralOffset = view.getUint32(relativeEocdOffset + 16, true);
  const absoluteEocdOffset = suffixOffset + relativeEocdOffset;
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    entryCount > MAX_ZIP_ENTRIES ||
    centralSize > MAX_CENTRAL_DIRECTORY_BYTES ||
    centralOffset + centralSize !== absoluteEocdOffset
  ) {
    throw new Error("Unsupported ZIP directory");
  }

  const central = await source.read(centralOffset, centralSize);
  const centralView = new DataView(central.buffer, central.byteOffset, central.byteLength);
  const entries = new Map<string, ZipEntry>();
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > central.length || centralView.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error("Invalid ZIP directory entry");
    }
    const flags = centralView.getUint16(cursor + 8, true);
    const compression = centralView.getUint16(cursor + 10, true);
    const compressedSize = centralView.getUint32(cursor + 20, true);
    const uncompressedSize = centralView.getUint32(cursor + 24, true);
    const nameLength = centralView.getUint16(cursor + 28, true);
    const extraLength = centralView.getUint16(cursor + 30, true);
    const commentLength = centralView.getUint16(cursor + 32, true);
    const localOffset = centralView.getUint32(cursor + 42, true);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > central.length || compression > 8 || (flags & 0x0001) !== 0) {
      throw new Error("Unsupported ZIP entry");
    }
    let name: string;
    try {
      name = textDecoder.decode(central.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      throw new Error("Invalid ZIP filename");
    }
    if (!safeZipPath(name) || entries.has(name)) throw new Error("Unsafe ZIP filename");
    entries.set(name, { name, flags, compression, compressedSize, uncompressedSize, localOffset });
    cursor = end;
  }
  if (cursor !== central.length) throw new Error("Trailing ZIP directory data");
  return entries;
}

async function readZipEntry(source: NewItemScanSource, entry: ZipEntry) {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES) {
    throw new Error("ZIP entry is too large to scan");
  }
  const local = await source.read(entry.localOffset, 30);
  const localView = new DataView(local.buffer, local.byteOffset, local.byteLength);
  if (localView.getUint32(0, true) !== LOCAL_SIGNATURE) throw new Error("Invalid ZIP local header");
  const nameLength = localView.getUint16(26, true);
  const extraLength = localView.getUint16(28, true);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > source.size) throw new Error("Invalid ZIP entry range");
  const compressed = await source.read(dataOffset, entry.compressedSize);
  if (entry.compression === 0) {
    if (compressed.length !== entry.uncompressedSize) throw new Error("ZIP size mismatch");
    return compressed;
  }
  if (entry.compression !== 8) throw new Error("Unsupported ZIP compression");
  const compressedBuffer = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(compressedBuffer).set(compressed);
  const reader = new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > entry.uncompressedSize || total > MAX_ENTRY_BYTES) {
        await reader.cancel();
        throw new Error("Inflated ZIP entry is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== entry.uncompressedSize) throw new Error("Inflated ZIP size mismatch");
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&amp;/g, "&");
}

function xmlAttribute(attributes: string, name: string) {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes);
  return match?.[1] ?? null;
}

function xmlSection(xml: string, name: string) {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return match?.[1] ?? "";
}

function xmlText(xml: string) {
  return decodeXml(
    [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => match[1]).join(""),
  ).replace(/\s+/g, " ").trim();
}

function markerFillColor(attrs: string) {
  const rgb = xmlAttribute(attrs, "rgb");
  if (rgb) {
    const value = rgb.slice(-6).toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(value)) return false;
    const red = Number.parseInt(value.slice(0, 2), 16);
    const green = Number.parseInt(value.slice(2, 4), 16);
    const blue = Number.parseInt(value.slice(4, 6), 16);
    // The owner marks new rows with a green fill. Some Excel exports (and
    // the current supplier workbook) serialize that marker as bright yellow,
    // so accept both marker colors while ignoring ordinary pale table fills.
    const greenMarker = green - red >= 8 && green - blue >= -10;
    const yellowMarker = red >= 200 && green >= 180 && blue <= 170;
    return greenMarker || yellowMarker;
  }
  const indexed = Number(xmlAttribute(attrs, "indexed"));
  if (indexed === 3 || indexed === 5 || indexed === 11) return true;
  // In the default Office theme accent3 (theme 6) is green. Custom themes
  // commonly keep the same slot for their green accent.
  return xmlAttribute(attrs, "theme") === "6";
}

function greenFillIds(stylesXml: string) {
  const fills = xmlSection(stylesXml, "fills");
  const result = new Set<number>();
  let fillIndex = 0;
  for (const match of fills.matchAll(/<fill\b[^>]*>([\s\S]*?)<\/fill>/g)) {
    if (markerFillColor(match[1])) result.add(fillIndex);
    fillIndex += 1;
  }
  return result;
}

function styleFillIds(stylesXml: string) {
  const cellXfs = xmlSection(stylesXml, "cellXfs");
  const result: number[] = [];
  for (const match of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>(?:[\s\S]*?)<\/xf>)/g)) {
    result.push(Number(xmlAttribute(match[1], "fillId") ?? 0));
  }
  return result;
}

function sharedStrings(sharedXml: string) {
  const result: string[] = [];
  for (const match of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    result.push(xmlText(match[1]));
  }
  return result;
}

type ParsedCell = { ref: string; style: number; value: string };

function parseCell(attributes: string, body: string | null, strings: string[]) {
  const ref = xmlAttribute(attributes, "r");
  if (!ref) return null;
  const style = Number(xmlAttribute(attributes, "s") ?? 0);
  const type = xmlAttribute(attributes, "t");
  const value = body === null ? "" : decodeXml((/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "").trim());
  if (type === "s") {
    const index = Number(value);
    return { ref, style, value: Number.isInteger(index) ? (strings[index] ?? "") : "" } satisfies ParsedCell;
  }
  if (type === "inlineStr") return { ref, style, value: xmlText(body ?? "") } satisfies ParsedCell;
  return { ref, style, value } satisfies ParsedCell;
}

function columnLetters(ref: string) {
  const match = /^([A-Z]+)/i.exec(ref);
  return match?.[1].toUpperCase() ?? "";
}

function productNameFromRow(
  rowAttributes: string,
  rowXml: string,
  strings: string[],
  fillIds: number[],
  greenFills: Set<number>,
) {
  const cells: ParsedCell[] = [];
  for (const match of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const cell = parseCell(match[1], match[2] ?? null, strings);
    if (cell) cells.push(cell);
  }
  const nameCell = cells.find((cell) => columnLetters(cell.ref) === "B");
  if (!nameCell || !nameCell.value) return null;
  const hasNumericProductField = cells.some((cell) => {
    const column = columnLetters(cell.ref);
    return (column === "A" || column === "C" || column === "D") && /^[-+]?\d+(?:[.,]\d+)?$/.test(cell.value);
  });
  if (!hasNumericProductField) return null;
  const rowStyle = Number(xmlAttribute(rowAttributes, "s") ?? -1);
  const green =
    greenFills.has(fillIds[rowStyle] ?? 0) ||
    cells.some((cell) => greenFills.has(fillIds[cell.style] ?? 0));
  return green ? nameCell.value : null;
}

async function scanXlsxSource(source: NewItemScanSource) {
  const entries = await readZipDirectory(source);
  const stylesEntry = entries.get("xl/styles.xml");
  if (!stylesEntry) return [];
  const sheetEntry = entries.get("xl/worksheets/sheet1.xml");
  if (!sheetEntry) return [];
  const stylesXml = textDecoder.decode(await readZipEntry(source, stylesEntry));
  const stringsEntry = entries.get("xl/sharedStrings.xml");
  const strings = stringsEntry
    ? sharedStrings(textDecoder.decode(await readZipEntry(source, stringsEntry)))
    : [];
  const fillIds = styleFillIds(stylesXml);
  const greenFills = greenFillIds(stylesXml);
  if (!greenFills.size) return [];
  const sheetXml = textDecoder.decode(await readZipEntry(source, sheetEntry));
  const names: string[] = [];
  for (const match of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const name = productNameFromRow(match[1], match[2], strings, fillIds, greenFills);
    if (name && !names.includes(name)) {
      names.push(name);
      if (names.length >= MAX_NEW_ITEMS) break;
    }
  }
  return names;
}

export async function extractNewProductNamesFromXlsxBytes(bytes: Uint8Array) {
  try {
    return await scanXlsxSource(new ByteSource(bytes));
  } catch {
    return [];
  }
}

export async function extractNewProductNamesFromXlsxObject(
  bucket: R2Bucket,
  key: string,
) {
  try {
    return await scanXlsxSource(await R2Source.open(bucket, key));
  } catch {
    return [];
  }
}

export async function extractNewProductNamesFromExcelBytes(bytes: Uint8Array, filename: string) {
  if (excelFileFormat(filename) === "xls") return extractNewProductNamesFromXlsBytes(bytes);
  if (excelFileFormat(filename) !== "xlsx") return [];
  return extractNewProductNamesFromXlsxBytes(bytes);
}

export async function extractNewProductNamesFromExcelObject(
  bucket: R2Bucket,
  key: string,
  filename: string,
) {
  if (excelFileFormat(filename) === "xls") {
    return extractNewProductNamesFromXlsObject(bucket, key);
  }
  if (excelFileFormat(filename) !== "xlsx") return [];
  return extractNewProductNamesFromXlsxObject(bucket, key);
}
