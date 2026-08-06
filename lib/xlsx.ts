export const MAX_XLSX_BYTES = 20 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ZIP_ENTRIES = 4096;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_REQUIRED_ENTRY_BYTES = 4 * 1024 * 1024;
const REQUIRED_XLSX_ENTRIES = new Set([
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
]);
const filenameDecoder = new TextDecoder("utf-8", { fatal: true });
const xmlDecoder = new TextDecoder("utf-8", { fatal: true });

type ZipEntry = {
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  dataStart: number;
};

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView) {
  const minimumOffset = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  return -1;
}

function safeZipPath(name: string) {
  return (
    name.length > 0 &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.split("/").includes("..")
  );
}

function calculateCrc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function unpackEntry(archive: Uint8Array, entry: ZipEntry) {
  if (
    entry.uncompressedSize <= 0 ||
    entry.uncompressedSize > MAX_REQUIRED_ENTRY_BYTES ||
    entry.compressedSize > MAX_XLSX_BYTES
  ) {
    return null;
  }

  const compressed = archive.slice(entry.dataStart, entry.dataStart + entry.compressedSize);
  let unpacked: Uint8Array;
  if (entry.compression === 0) {
    unpacked = compressed;
  } else {
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    unpacked = new Uint8Array(await new Response(stream).arrayBuffer());
  }

  if (
    unpacked.byteLength !== entry.uncompressedSize ||
    calculateCrc32(unpacked) !== entry.crc32
  ) {
    return null;
  }
  return unpacked;
}

function hasExpectedXlsxXml(name: string, xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return false;

  if (name === "[Content_Types].xml") {
    return (
      /<(?:\w+:)?Types(?:\s|>)/.test(xml) &&
      xml.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")
    );
  }
  if (name === "_rels/.rels") {
    return (
      /<(?:\w+:)?Relationships(?:\s|>)/.test(xml) &&
      /relationships\/officeDocument/.test(xml) &&
      /Target=["']\/?xl\/workbook\.xml["']/.test(xml)
    );
  }
  if (name === "xl/workbook.xml") {
    return (
      /<(?:\w+:)?workbook(?:\s|>)/.test(xml) &&
      /spreadsheetml\/(?:\d+\/)?main/.test(xml) &&
      /<(?:\w+:)?sheets(?:\s|>)/.test(xml) &&
      /<(?:\w+:)?sheet(?:\s|\/|>)/.test(xml)
    );
  }
  return false;
}

export function isXlsxFilename(filename: string) {
  return filename.trim().toLowerCase().endsWith(".xlsx");
}

export async function isValidXlsxBytes(bytes: Uint8Array) {
  if (bytes.length < 22 || bytes.length > MAX_XLSX_BYTES) return false;

  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocdOffset = findEndOfCentralDirectory(bytes, view);
    if (eocdOffset < 0) return false;

    const diskNumber = view.getUint16(eocdOffset + 4, true);
    const centralDisk = view.getUint16(eocdOffset + 6, true);
    const diskEntries = view.getUint16(eocdOffset + 8, true);
    const entryCount = view.getUint16(eocdOffset + 10, true);
    const centralSize = view.getUint32(eocdOffset + 12, true);
    const centralOffset = view.getUint32(eocdOffset + 16, true);
    if (
      diskNumber !== 0 ||
      centralDisk !== 0 ||
      diskEntries !== entryCount ||
      entryCount < REQUIRED_XLSX_ENTRIES.size ||
      entryCount > MAX_ZIP_ENTRIES ||
      centralOffset + centralSize !== eocdOffset
    ) {
      return false;
    }

    const names = new Set<string>();
    const requiredEntries = new Map<string, ZipEntry>();
    let totalUncompressed = 0;
    let cursor = centralOffset;
    for (let entry = 0; entry < entryCount; entry += 1) {
      if (cursor + 46 > eocdOffset || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
        return false;
      }

      const flags = view.getUint16(cursor + 8, true);
      const compression = view.getUint16(cursor + 10, true);
      const entryCrc32 = view.getUint32(cursor + 16, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const entryDisk = view.getUint16(cursor + 34, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const nextEntry = cursor + 46 + nameLength + extraLength + commentLength;
      if (
        (flags & 0x0001) !== 0 ||
        (compression !== 0 && compression !== 8) ||
        entryDisk !== 0 ||
        nameLength === 0 ||
        nextEntry > eocdOffset ||
        localOffset + 30 > centralOffset ||
        view.getUint32(localOffset, true) !== LOCAL_SIGNATURE
      ) {
        return false;
      }

      const nameStart = cursor + 46;
      const name = filenameDecoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
      const localFlags = view.getUint16(localOffset + 6, true);
      const localCompression = view.getUint16(localOffset + 8, true);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const localNameStart = localOffset + 30;
      const localDataStart = localNameStart + localNameLength + localExtraLength;
      if (
        !safeZipPath(name) ||
        names.has(name) ||
        localDataStart + compressedSize > centralOffset ||
        localFlags !== flags ||
        localCompression !== compression ||
        localNameLength !== nameLength ||
        filenameDecoder.decode(bytes.subarray(localNameStart, localNameStart + localNameLength)) !== name
      ) {
        return false;
      }

      names.add(name);
      if (REQUIRED_XLSX_ENTRIES.has(name)) {
        requiredEntries.set(name, {
          compression,
          compressedSize,
          uncompressedSize,
          crc32: entryCrc32,
          dataStart: localDataStart,
        });
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) return false;
      cursor = nextEntry;
    }

    if (cursor !== eocdOffset || requiredEntries.size !== REQUIRED_XLSX_ENTRIES.size) {
      return false;
    }

    for (const requiredName of REQUIRED_XLSX_ENTRIES) {
      const entry = requiredEntries.get(requiredName);
      if (!entry) return false;
      const unpacked = await unpackEntry(bytes, entry);
      if (!unpacked || !hasExpectedXlsxXml(requiredName, xmlDecoder.decode(unpacked))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function formatFileSize(size: number) {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}
