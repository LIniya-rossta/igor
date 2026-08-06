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
const CRC32_TABLE = new Uint32Array(256);

for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  CRC32_TABLE[index] = value >>> 0;
}

type ZipEntry = {
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  dataStart: number;
};

type ParsedXmlElement = {
  name: string;
  localName: string;
  parentLocalName: string | null;
  attributes: Map<string, string>;
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

function updateCrc32(current: number, bytes: Uint8Array) {
  let crc = current;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

async function unpackEntry(archive: Uint8Array, entry: ZipEntry) {
  if (
    entry.uncompressedSize <= 0 ||
    entry.uncompressedSize > MAX_REQUIRED_ENTRY_BYTES ||
    entry.compressedSize > MAX_XLSX_BYTES ||
    (entry.compression === 0 && entry.compressedSize !== entry.uncompressedSize)
  ) {
    return null;
  }

  const compressed = archive.slice(entry.dataStart, entry.dataStart + entry.compressedSize);
  let chunks: Uint8Array[];
  let total = 0;
  let crc = 0xffffffff;
  if (entry.compression === 0) {
    chunks = [compressed];
    total = compressed.byteLength;
    crc = updateCrc32(crc, compressed);
  } else {
    const reader = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"))
      .getReader();
    chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > entry.uncompressedSize || total > MAX_REQUIRED_ENTRY_BYTES) {
        await reader.cancel();
        return null;
      }
      crc = updateCrc32(crc, value);
      chunks.push(value);
    }
  }

  if (
    total !== entry.uncompressedSize ||
    ((crc ^ 0xffffffff) >>> 0) !== entry.crc32
  ) {
    return null;
  }
  const unpacked = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    unpacked.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return unpacked;
}

function localName(name: string) {
  return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
}

function isXmlNameStart(character: string) {
  return /[A-Za-z_:]/.test(character);
}

function isXmlNameCharacter(character: string) {
  return /[A-Za-z0-9_.:-]/.test(character);
}

function hasValidEntities(value: string) {
  if (value.includes("]]>") || value.includes("<")) return false;
  let cursor = 0;
  while (true) {
    const ampersand = value.indexOf("&", cursor);
    if (ampersand < 0) return true;
    const semicolon = value.indexOf(";", ampersand + 1);
    if (semicolon < 0 || semicolon - ampersand > 12) return false;
    const entity = value.slice(ampersand + 1, semicolon);
    if (!/^(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+)$/.test(entity)) return false;
    cursor = semicolon + 1;
  }
}

function parseXml(xml: string) {
  const elements: ParsedXmlElement[] = [];
  const stack: string[] = [];
  let rootName: string | null = null;
  let cursor = 0;

  const skipWhitespace = () => {
    const start = cursor;
    while (cursor < xml.length && /\s/.test(xml[cursor])) cursor += 1;
    return cursor > start;
  };
  const readName = () => {
    if (!isXmlNameStart(xml[cursor] ?? "")) return null;
    const start = cursor;
    cursor += 1;
    while (cursor < xml.length && isXmlNameCharacter(xml[cursor])) cursor += 1;
    return xml.slice(start, cursor);
  };

  while (cursor < xml.length) {
    const opening = xml.indexOf("<", cursor);
    const textEnd = opening < 0 ? xml.length : opening;
    const text = xml.slice(cursor, textEnd);
    if ((stack.length === 0 && text.trim()) || (stack.length > 0 && !hasValidEntities(text))) {
      return null;
    }
    if (opening < 0) break;
    cursor = opening;

    if (xml.startsWith("<!--", cursor)) {
      const end = xml.indexOf("-->", cursor + 4);
      if (end < 0 || xml.slice(cursor + 4, end).includes("--")) return null;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", cursor)) {
      const end = xml.indexOf("?>", cursor + 2);
      if (end < 0) return null;
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<![CDATA[", cursor)) {
      if (!stack.length) return null;
      const end = xml.indexOf("]]>", cursor + 9);
      if (end < 0) return null;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<!", cursor)) return null;

    if (xml.startsWith("</", cursor)) {
      cursor += 2;
      const closingName = readName();
      if (!closingName) return null;
      skipWhitespace();
      if (xml[cursor] !== ">" || stack.pop() !== closingName) return null;
      cursor += 1;
      continue;
    }

    cursor += 1;
    const elementName = readName();
    if (!elementName || (!stack.length && rootName)) return null;
    const attributes = new Map<string, string>();
    let selfClosing = false;
    while (cursor < xml.length) {
      const hadWhitespace = skipWhitespace();
      if (xml.startsWith("/>", cursor)) {
        selfClosing = true;
        cursor += 2;
        break;
      }
      if (xml[cursor] === ">") {
        cursor += 1;
        break;
      }
      if (!hadWhitespace) return null;
      const attributeName = readName();
      if (!attributeName || attributes.has(attributeName)) return null;
      skipWhitespace();
      if (xml[cursor] !== "=") return null;
      cursor += 1;
      skipWhitespace();
      const quote = xml[cursor];
      if (quote !== '"' && quote !== "'") return null;
      cursor += 1;
      const valueEnd = xml.indexOf(quote, cursor);
      if (valueEnd < 0) return null;
      const value = xml.slice(cursor, valueEnd);
      if (!hasValidEntities(value)) return null;
      attributes.set(attributeName, value);
      cursor = valueEnd + 1;
    }
    if (cursor > xml.length) return null;

    const parent = stack.length ? localName(stack[stack.length - 1]) : null;
    const element: ParsedXmlElement = {
      name: elementName,
      localName: localName(elementName),
      parentLocalName: parent,
      attributes,
    };
    elements.push(element);
    if (elements.length > 50_000 || stack.length > 128) return null;
    if (!rootName) rootName = elementName;
    if (!selfClosing) stack.push(elementName);
  }

  if (!rootName || stack.length) return null;
  return { root: elements[0], elements };
}

function attributeByLocalName(element: ParsedXmlElement, wantedName: string) {
  for (const [name, value] of element.attributes) {
    if (localName(name) === wantedName) return value;
  }
  return null;
}

function hasExpectedXlsxXml(name: string, xml: string) {
  const document = parseXml(xml);
  if (!document) return false;

  if (name === "[Content_Types].xml") {
    return document.root.localName === "Types" && document.elements.some(
      (element) =>
        (element.localName === "Default" || element.localName === "Override") &&
        attributeByLocalName(element, "ContentType") ===
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" &&
        (attributeByLocalName(element, "PartName") === "/xl/workbook.xml" ||
          attributeByLocalName(element, "Extension") === "xml"),
    );
  }
  if (name === "_rels/.rels") {
    return document.root.localName === "Relationships" && document.elements.some(
      (element) =>
        element.localName === "Relationship" &&
        attributeByLocalName(element, "Type")?.endsWith("/relationships/officeDocument") &&
        attributeByLocalName(element, "Target")?.replace(/^\//, "") === "xl/workbook.xml",
    );
  }
  if (name === "xl/workbook.xml") {
    const namespaceIsSpreadsheet = [...document.root.attributes]
      .filter(([attributeName]) => attributeName === "xmlns" || attributeName.startsWith("xmlns:"))
      .some(([, value]) => /spreadsheetml\/(?:\d+\/)?main$/.test(value));
    return (
      document.root.localName === "workbook" &&
      namespaceIsSpreadsheet &&
      document.elements.some((element) => element.localName === "sheets") &&
      document.elements.some(
        (element) => element.localName === "sheet" && element.parentLocalName === "sheets",
      )
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
