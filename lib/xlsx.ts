export const MAX_XLSX_BYTES = 20 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ENCRYPTION_FLAGS = 0x2041;
const MAX_EOCD_BYTES = 22 + 0xffff;
const MAX_ZIP_ENTRIES = 4096;
const MAX_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_XLSX_OBJECT_BYTES = 1024 * 1024 * 1024;
const MAX_REQUIRED_ENTRY_BYTES = 4 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;
const MAX_XML_TOKEN_CHARS = 64 * 1024;
const SPREADSHEETML_NAMESPACE = /\/spreadsheetml\/(?:\d+\/)?main$/;
const OFFICE_RELATIONSHIPS_NAMESPACE =
  /\/officeDocument\/(?:\d+\/)?relationships$/;
const PACKAGE_RELATIONSHIPS_NAMESPACE =
  /\/package\/(?:\d+\/)?relationships$/;
const REQUIRED_XLSX_ENTRIES = new Set([
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels",
]);
const filenameDecoder = new TextDecoder("utf-8", { fatal: true });
const xmlDecoder = new TextDecoder("utf-8", { fatal: true });
const CRC32_TABLE = new Uint32Array(256);

export class XlsxObjectReadError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "XlsxObjectReadError";
    this.cause = cause;
  }
}

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

type R2ZipEntry = Omit<ZipEntry, "dataStart"> & {
  flags: number;
  localOffset: number;
  nameBytes: Uint8Array;
};

type R2RangeStreamState = {
  complete: boolean;
  error: XlsxObjectReadError | null;
};

type ParsedXmlElement = {
  name: string;
  localName: string;
  parentLocalName: string | null;
  parentNamespace: string | null;
  namespace: string | null;
  namespaces: Map<string, string>;
  depth: number;
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

function isSafeNonZip64Extra(extra: Uint8Array) {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let cursor = 0;
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) return false;
    const fieldId = view.getUint16(cursor, true);
    const fieldSize = view.getUint16(cursor + 2, true);
    cursor += 4;
    if (fieldId === ZIP64_EXTRA_FIELD_ID || cursor + fieldSize > extra.length) {
      return false;
    }
    cursor += fieldSize;
  }
  return true;
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function updateCrc32(current: number, bytes: Uint8Array) {
  let crc = current;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

async function unpackCompressedEntry(
  compressed: Uint8Array,
  entry: Omit<ZipEntry, "dataStart">,
  maxCompressedBytes: number,
) {
  if (
    entry.uncompressedSize <= 0 ||
    entry.uncompressedSize > MAX_REQUIRED_ENTRY_BYTES ||
    entry.compressedSize > maxCompressedBytes ||
    compressed.byteLength !== entry.compressedSize ||
    (entry.compression === 0 && entry.compressedSize !== entry.uncompressedSize)
  ) {
    return null;
  }

  let chunks: Uint8Array[];
  let total = 0;
  let crc = 0xffffffff;
  if (entry.compression === 0) {
    chunks = [compressed];
    total = compressed.byteLength;
    crc = updateCrc32(crc, compressed);
  } else {
    const compressedBuffer = new ArrayBuffer(compressed.byteLength);
    new Uint8Array(compressedBuffer).set(compressed);
    const reader = new Blob([compressedBuffer])
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

async function unpackEntry(
  archive: Uint8Array,
  entry: ZipEntry,
  maxCompressedBytes = MAX_XLSX_BYTES,
) {
  if (
    entry.dataStart < 0 ||
    entry.dataStart + entry.compressedSize > archive.byteLength
  ) {
    return null;
  }
  return unpackCompressedEntry(
    archive.subarray(entry.dataStart, entry.dataStart + entry.compressedSize),
    entry,
    maxCompressedBytes,
  );
}

async function readBodyExactly(object: R2ObjectBody, expectedLength: number) {
  if (object.bodyUsed) {
    throw new XlsxObjectReadError("R2 range body was already consumed");
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = object.body.getReader();
  } catch (error) {
    throw new XlsxObjectReadError("Could not open the R2 range body", error);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined);
        throw new XlsxObjectReadError("R2 returned a non-byte range body");
      }
      total += value.byteLength;
      if (total > expectedLength) {
        await reader.cancel().catch(() => undefined);
        throw new XlsxObjectReadError("R2 returned more range bytes than requested");
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The failed stream is already unusable.
    }
    if (error instanceof XlsxObjectReadError) throw error;
    throw new XlsxObjectReadError("Could not read the R2 range body", error);
  }

  if (total !== expectedLength) {
    throw new XlsxObjectReadError("R2 returned fewer range bytes than requested");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function getR2RangeObject(
  bucket: R2Bucket,
  key: string,
  range: R2Range,
  expectedObjectSize: number,
  expectedEtag?: string,
): Promise<R2ObjectBody> {
  const options: R2GetOptions = { range };
  if (expectedEtag) options.onlyIf = { etagMatches: expectedEtag };
  let object: R2ObjectBody | R2Object | null;
  try {
    object = await bucket.get(key, options);
  } catch (error) {
    throw new XlsxObjectReadError("Could not read an XLSX range from R2", error);
  }
  if (
    !object ||
    !("body" in object) ||
    object.size !== expectedObjectSize ||
    (expectedEtag !== undefined && object.etag !== expectedEtag)
  ) {
    throw new XlsxObjectReadError("R2 returned an unavailable or changed XLSX range");
  }

  return object;
}

async function readR2Range(
  bucket: R2Bucket,
  key: string,
  range: R2Range,
  expectedLength: number,
  expectedObjectSize: number,
  expectedEtag?: string,
) {
  const object = await getR2RangeObject(
    bucket,
    key,
    range,
    expectedObjectSize,
    expectedEtag,
  );

  const bytes = await readBodyExactly(object, expectedLength);
  return { bytes, etag: object.etag };
}

async function openR2RangeStream(
  bucket: R2Bucket,
  key: string,
  range: R2Range,
  expectedLength: number,
  expectedObjectSize: number,
  expectedEtag: string,
) {
  const object = await getR2RangeObject(
    bucket,
    key,
    range,
    expectedObjectSize,
    expectedEtag,
  );
  if (object.bodyUsed) {
    throw new XlsxObjectReadError("R2 range body was already consumed");
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = object.body.getReader();
  } catch (error) {
    throw new XlsxObjectReadError("Could not open the R2 range body", error);
  }

  let total = 0;
  let finished = false;
  const state: R2RangeStreamState = { complete: false, error: null };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          if (total !== expectedLength) {
            state.error = new XlsxObjectReadError(
              "R2 returned fewer range bytes than requested",
            );
            controller.error(state.error);
          } else {
            state.complete = true;
            controller.close();
          }
          return;
        }
        if (!(value instanceof Uint8Array)) {
          finished = true;
          await reader.cancel().catch(() => undefined);
          state.error = new XlsxObjectReadError(
            "R2 returned a non-byte range body",
          );
          controller.error(state.error);
          return;
        }
        total += value.byteLength;
        if (total > expectedLength) {
          finished = true;
          await reader.cancel().catch(() => undefined);
          state.error = new XlsxObjectReadError(
            "R2 returned more range bytes than requested",
          );
          controller.error(state.error);
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (finished) return;
        finished = true;
        state.error =
          error instanceof XlsxObjectReadError
            ? error
            : new XlsxObjectReadError(
                "Could not read the R2 range body",
                error,
              );
        controller.error(state.error);
      }
    },
    async cancel(reason) {
      finished = true;
      try {
        await reader.cancel(reason);
      } catch {
        // Cancellation follows a validation failure; no retry signal is needed.
      }
    },
  });
  return { stream, state };
}

async function readR2LocalEntryDataStart(
  bucket: R2Bucket,
  key: string,
  objectSize: number,
  centralOffset: number,
  expectedEtag: string,
  entry: R2ZipEntry,
  maxCompressedBytes: number,
  maxUncompressedBytes: number,
) {
  if (
    entry.compressedSize <= 0 ||
    entry.compressedSize > maxCompressedBytes ||
    entry.uncompressedSize <= 0 ||
    entry.uncompressedSize > maxUncompressedBytes
  ) {
    return null;
  }

  const fixedHeaderResult = await readR2Range(
    bucket,
    key,
    { offset: entry.localOffset, length: 30 },
    30,
    objectSize,
    expectedEtag,
  );
  const fixedHeader = fixedHeaderResult.bytes;
  const localView = new DataView(
    fixedHeader.buffer,
    fixedHeader.byteOffset,
    fixedHeader.byteLength,
  );
  if (localView.getUint32(0, true) !== LOCAL_SIGNATURE) return null;

  const localFlags = localView.getUint16(6, true);
  const localCompression = localView.getUint16(8, true);
  const localCrc32 = localView.getUint32(14, true);
  const localCompressedSize = localView.getUint32(18, true);
  const localUncompressedSize = localView.getUint32(22, true);
  const localNameLength = localView.getUint16(26, true);
  const localExtraLength = localView.getUint16(28, true);
  const hasDataDescriptor = (localFlags & 0x0008) !== 0;
  if (
    (localFlags & ENCRYPTION_FLAGS) !== 0 ||
    localFlags !== entry.flags ||
    localCompression !== entry.compression ||
    localNameLength !== entry.nameBytes.length ||
    localCompressedSize === 0xffffffff ||
    localUncompressedSize === 0xffffffff ||
    (!hasDataDescriptor &&
      (localCrc32 !== entry.crc32 ||
        localCompressedSize !== entry.compressedSize ||
        localUncompressedSize !== entry.uncompressedSize)) ||
    (hasDataDescriptor &&
      ((localCrc32 !== 0 && localCrc32 !== entry.crc32) ||
        (localCompressedSize !== 0 &&
          localCompressedSize !== entry.compressedSize) ||
        (localUncompressedSize !== 0 &&
          localUncompressedSize !== entry.uncompressedSize)))
  ) {
    return null;
  }

  const localTailLength = localNameLength + localExtraLength;
  const localTailStart = entry.localOffset + 30;
  const dataStart = localTailStart + localTailLength;
  if (dataStart + entry.compressedSize > centralOffset) return null;
  const localTailResult = await readR2Range(
    bucket,
    key,
    { offset: localTailStart, length: localTailLength },
    localTailLength,
    objectSize,
    expectedEtag,
  );

  const localTail = localTailResult.bytes;
  const localNameBytes = localTail.subarray(0, localNameLength);
  const localExtra = localTail.subarray(
    localNameLength,
    localNameLength + localExtraLength,
  );
  if (
    !equalBytes(localNameBytes, entry.nameBytes) ||
    !isSafeNonZip64Extra(localExtra)
  ) {
    return null;
  }

  return dataStart;
}

async function readR2ZipEntry(
  bucket: R2Bucket,
  key: string,
  objectSize: number,
  centralOffset: number,
  expectedEtag: string,
  entry: R2ZipEntry,
) {
  const dataStart = await readR2LocalEntryDataStart(
    bucket,
    key,
    objectSize,
    centralOffset,
    expectedEtag,
    entry,
    MAX_REQUIRED_ENTRY_BYTES,
    MAX_REQUIRED_ENTRY_BYTES,
  );
  if (dataStart === null) return null;

  const compressedResult = await readR2Range(
    bucket,
    key,
    { offset: dataStart, length: entry.compressedSize },
    entry.compressedSize,
    objectSize,
    expectedEtag,
  );

  return unpackCompressedEntry(
    compressedResult.bytes,
    entry,
    MAX_REQUIRED_ENTRY_BYTES,
  );
}

function localName(name: string) {
  return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
}

function namespaceForName(name: string, namespaces: Map<string, string>) {
  const separator = name.indexOf(":");
  const prefix = separator < 0 ? "" : name.slice(0, separator);
  return namespaces.get(prefix) ?? null;
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
  const namespaceStack: Map<string, string>[] = [];
  const elementNamespaceStack: (string | null)[] = [];
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
      namespaceStack.pop();
      elementNamespaceStack.pop();
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

    const inheritedNamespaces = namespaceStack.length
      ? namespaceStack[namespaceStack.length - 1]
      : new Map<string, string>();
    let namespaces = inheritedNamespaces;
    for (const [attributeName, value] of attributes) {
      if (attributeName !== "xmlns" && !attributeName.startsWith("xmlns:")) {
        continue;
      }
      if (namespaces === inheritedNamespaces) {
        namespaces = new Map(inheritedNamespaces);
      }
      const prefix = attributeName === "xmlns" ? "" : attributeName.slice(6);
      namespaces.set(prefix, value);
    }

    const parent = stack.length ? localName(stack[stack.length - 1]) : null;
    const element: ParsedXmlElement = {
      name: elementName,
      localName: localName(elementName),
      parentLocalName: parent,
      parentNamespace: elementNamespaceStack.length
        ? elementNamespaceStack[elementNamespaceStack.length - 1]
        : null,
      namespace: namespaceForName(elementName, namespaces),
      namespaces,
      depth: stack.length,
      attributes,
    };
    elements.push(element);
    if (elements.length > 50_000 || stack.length > 128) return null;
    if (!rootName) rootName = elementName;
    if (!selfClosing) {
      stack.push(elementName);
      namespaceStack.push(namespaces);
      elementNamespaceStack.push(element.namespace);
    }
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

type ParsedXmlDocument = NonNullable<ReturnType<typeof parseXml>>;

function elementHasNamespace(
  element: ParsedXmlElement,
  wantedLocalName: string,
  namespacePattern: RegExp,
) {
  return (
    element.localName === wantedLocalName &&
    element.namespace !== null &&
    namespacePattern.test(element.namespace)
  );
}

function qualifiedAttributeByNamespace(
  element: ParsedXmlElement,
  wantedLocalName: string,
  namespacePattern: RegExp,
) {
  for (const [name, value] of element.attributes) {
    const separator = name.indexOf(":");
    if (
      separator <= 0 ||
      name.indexOf(":", separator + 1) >= 0 ||
      name.slice(separator + 1) !== wantedLocalName
    ) {
      continue;
    }
    const namespace = element.namespaces.get(name.slice(0, separator));
    if (namespace && namespacePattern.test(namespace)) return value;
  }
  return null;
}

function workbookSheetRelationshipIds(xml: string) {
  const document = parseXml(xml);
  if (
    !document ||
    !elementHasNamespace(
      document.root,
      "workbook",
      SPREADSHEETML_NAMESPACE,
    ) ||
    !document.elements.some(
      (element) =>
        element.depth === 1 &&
        element.parentNamespace === document.root.namespace &&
        elementHasNamespace(element, "sheets", SPREADSHEETML_NAMESPACE),
    )
  ) {
    return null;
  }

  const relationshipIds: string[] = [];
  const seen = new Set<string>();
  for (const element of document.elements) {
    if (
      element.depth !== 2 ||
      element.parentLocalName !== "sheets" ||
      !SPREADSHEETML_NAMESPACE.test(element.parentNamespace ?? "") ||
      !elementHasNamespace(element, "sheet", SPREADSHEETML_NAMESPACE)
    ) {
      continue;
    }
    const relationshipId = qualifiedAttributeByNamespace(
      element,
      "id",
      OFFICE_RELATIONSHIPS_NAMESPACE,
    );
    if (!relationshipId) continue;
    if (seen.has(relationshipId)) return null;
    seen.add(relationshipId);
    relationshipIds.push(relationshipId);
  }
  return relationshipIds.length ? relationshipIds : null;
}

function workbookRelationshipsDocument(
  xml: string,
): ParsedXmlDocument | null {
  const document = parseXml(xml);
  if (
    !document ||
    !elementHasNamespace(
      document.root,
      "Relationships",
      PACKAGE_RELATIONSHIPS_NAMESPACE,
    )
  ) {
    return null;
  }
  return document;
}

function resolveWorksheetTarget(target: string) {
  if (
    target.length === 0 ||
    target.length > 1024 ||
    target.trim() !== target ||
    target.includes("\\") ||
    target.includes("%") ||
    target.includes("?") ||
    target.includes("#") ||
    [...target].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    }) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) ||
    target.startsWith("//")
  ) {
    return null;
  }

  const packagePath = target.startsWith("/")
    ? target.slice(1)
    : `xl/${target}`;
  const parts = packagePath.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    parts.length !== 3 ||
    parts[0] !== "xl" ||
    parts[1] !== "worksheets" ||
    !parts[2].endsWith(".xml") ||
    !safeZipPath(packagePath)
  ) {
    return null;
  }
  return packagePath;
}

function linkedWorksheetEntryName(workbookXml: string, relationshipsXml: string) {
  const relationshipIds = workbookSheetRelationshipIds(workbookXml);
  const relationships = workbookRelationshipsDocument(relationshipsXml);
  if (!relationshipIds || !relationships) return null;

  const byId = new Map<string, ParsedXmlElement>();
  for (const element of relationships.elements) {
    if (
      element.depth !== 1 ||
      element.parentNamespace !== relationships.root.namespace ||
      !elementHasNamespace(
        element,
        "Relationship",
        PACKAGE_RELATIONSHIPS_NAMESPACE,
      )
    ) {
      continue;
    }
    const id = element.attributes.get("Id");
    if (!id || byId.has(id)) return null;
    byId.set(id, element);
  }

  for (const relationshipId of relationshipIds) {
    const relationship = byId.get(relationshipId);
    if (!relationship) continue;
    const type = relationship.attributes.get("Type");
    const target = relationship.attributes.get("Target");
    const targetMode = relationship.attributes.get("TargetMode");
    if (
      !type?.endsWith("/worksheet") ||
      !target ||
      (targetMode !== undefined && targetMode !== "Internal")
    ) {
      continue;
    }
    const resolved = resolveWorksheetTarget(target);
    if (resolved) return resolved;
  }
  return null;
}

type XmlStartTag = {
  name: string;
  attributes: Map<string, string>;
  selfClosing: boolean;
};

function parseXmlStartTagToken(token: string): XmlStartTag | null {
  if (!token.startsWith("<") || !token.endsWith(">")) return null;
  const end = token.length - 1;
  let cursor = 1;
  const skipWhitespace = () => {
    const start = cursor;
    while (cursor < end && /\s/.test(token[cursor])) cursor += 1;
    return cursor > start;
  };
  const readName = () => {
    if (!isXmlNameStart(token[cursor] ?? "")) return null;
    const start = cursor;
    cursor += 1;
    while (cursor < end && isXmlNameCharacter(token[cursor])) cursor += 1;
    return token.slice(start, cursor);
  };

  const name = readName();
  if (!name) return null;
  const attributes = new Map<string, string>();
  while (cursor < end) {
    const hadWhitespace = skipWhitespace();
    if (cursor === end) return { name, attributes, selfClosing: false };
    if (token[cursor] === "/" && cursor + 1 === end) {
      return { name, attributes, selfClosing: true };
    }
    if (!hadWhitespace) return null;
    const attributeName = readName();
    if (!attributeName || attributes.has(attributeName)) return null;
    skipWhitespace();
    if (token[cursor] !== "=") return null;
    cursor += 1;
    skipWhitespace();
    const quote = token[cursor];
    if (quote !== '"' && quote !== "'") return null;
    cursor += 1;
    const valueEnd = token.indexOf(quote, cursor);
    if (valueEnd < 0 || valueEnd >= end) return null;
    const value = token.slice(cursor, valueEnd);
    if (!hasValidEntities(value)) return null;
    attributes.set(attributeName, value);
    cursor = valueEnd + 1;
  }
  return cursor === end ? { name, attributes, selfClosing: false } : null;
}

function findXmlTagEnd(value: string) {
  let quote: string | null = null;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

type WorksheetXmlStackEntry = {
  name: string;
  namespace: string | null;
  namespaces: Map<string, string>;
};

class WorksheetXmlProbe {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly stack: WorksheetXmlStackEntry[] = [];
  private pending = "";
  private rootSeen = false;
  private sheetDataSeen = false;
  private invalid = false;

  write(bytes: Uint8Array) {
    if (this.invalid) return false;
    try {
      const decoded = this.decoder.decode(bytes, { stream: true });
      if (this.sheetDataSeen) return true;
      this.pending += decoded;
      return this.process(false);
    } catch {
      this.invalid = true;
      return false;
    }
  }

  finish() {
    if (this.invalid) return false;
    try {
      const decoded = this.decoder.decode();
      if (!this.sheetDataSeen) {
        this.pending += decoded;
        if (!this.process(true)) return false;
      }
      return this.sheetDataSeen;
    } catch {
      this.invalid = true;
      return false;
    }
  }

  private fail() {
    this.invalid = true;
    return false;
  }

  private consumeText(text: string) {
    if (!this.rootSeen) return text.trim().length === 0;
    return this.stack.length > 0 && !text.includes("]]>");
  }

  private processStartTag(token: string) {
    const tag = parseXmlStartTagToken(token);
    if (!tag) return this.fail();

    const inherited = this.stack.length
      ? this.stack[this.stack.length - 1].namespaces
      : new Map<string, string>();
    let namespaces = inherited;
    for (const [attributeName, value] of tag.attributes) {
      if (attributeName !== "xmlns" && !attributeName.startsWith("xmlns:")) {
        continue;
      }
      if (namespaces === inherited) namespaces = new Map(inherited);
      const prefix = attributeName === "xmlns" ? "" : attributeName.slice(6);
      namespaces.set(prefix, value);
    }
    const namespace = namespaceForName(tag.name, namespaces);

    if (!this.stack.length) {
      if (
        this.rootSeen ||
        tag.selfClosing ||
        localName(tag.name) !== "worksheet" ||
        !SPREADSHEETML_NAMESPACE.test(namespace ?? "")
      ) {
        return this.fail();
      }
      this.rootSeen = true;
    } else if (
      this.stack.length === 1 &&
      localName(tag.name) === "sheetData" &&
      SPREADSHEETML_NAMESPACE.test(namespace ?? "")
    ) {
      this.sheetDataSeen = true;
      this.pending = "";
      return true;
    }

    if (!tag.selfClosing) {
      if (this.stack.length >= 128) return this.fail();
      this.stack.push({ name: tag.name, namespace, namespaces });
    }
    return true;
  }

  private processEndTag(token: string) {
    const match = /^<\/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*>$/.exec(token);
    if (!match || this.stack.pop()?.name !== match[1]) return this.fail();
    if (!this.stack.length && !this.sheetDataSeen) return this.fail();
    return true;
  }

  private process(final: boolean) {
    while (this.pending.length) {
      const opening = this.pending.indexOf("<");
      if (opening < 0) {
        if (!this.consumeText(this.pending)) return this.fail();
        this.pending = "";
        return true;
      }
      if (opening > 0) {
        if (!this.consumeText(this.pending.slice(0, opening))) {
          return this.fail();
        }
        this.pending = this.pending.slice(opening);
        continue;
      }

      if (this.pending.startsWith("<!--")) {
        const end = this.pending.indexOf("-->", 4);
        if (end < 0) return this.waitForToken(final);
        if (this.pending.slice(4, end).includes("--")) return this.fail();
        this.pending = this.pending.slice(end + 3);
        continue;
      }
      if (this.pending.startsWith("<![CDATA[")) {
        if (!this.stack.length) return this.fail();
        const end = this.pending.indexOf("]]>", 9);
        if (end < 0) return this.waitForToken(final);
        this.pending = this.pending.slice(end + 3);
        continue;
      }
      if (this.pending.startsWith("<?")) {
        const end = this.pending.indexOf("?>", 2);
        if (end < 0) return this.waitForToken(final);
        this.pending = this.pending.slice(end + 2);
        continue;
      }

      if (
        "<!--".startsWith(this.pending) ||
        "<![CDATA[".startsWith(this.pending) ||
        "<?".startsWith(this.pending) ||
        "</".startsWith(this.pending)
      ) {
        return this.waitForToken(final);
      }
      if (this.pending.startsWith("<!")) return this.fail();

      const end = findXmlTagEnd(this.pending);
      if (end < 0) return this.waitForToken(final);
      const token = this.pending.slice(0, end + 1);
      if (token.length > MAX_XML_TOKEN_CHARS) return this.fail();
      this.pending = this.pending.slice(end + 1);
      if (
        (token.startsWith("</")
          ? this.processEndTag(token)
          : this.processStartTag(token)) === false
      ) {
        return false;
      }
      if (this.sheetDataSeen) return true;
    }
    return !final || this.sheetDataSeen;
  }

  private waitForToken(final: boolean) {
    if (final || this.pending.length > MAX_XML_TOKEN_CHARS) return this.fail();
    return true;
  }
}

function byteRangeStream(bytes: Uint8Array, start: number, length: number) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === length) {
        controller.close();
        return;
      }
      const chunkLength = Math.min(STREAM_CHUNK_BYTES, length - offset);
      controller.enqueue(bytes.subarray(start + offset, start + offset + chunkLength));
      offset += chunkLength;
    },
  });
}

async function validateWorksheetStream(
  compressedStream: ReadableStream<Uint8Array>,
  entry: Omit<ZipEntry, "dataStart">,
  maxCompressedBytes: number,
  maxUncompressedBytes: number,
  r2State?: R2RangeStreamState,
) {
  if (
    entry.compressedSize <= 0 ||
    entry.compressedSize > maxCompressedBytes ||
    entry.uncompressedSize <= 0 ||
    entry.uncompressedSize > maxUncompressedBytes ||
    (entry.compression !== 0 && entry.compression !== 8) ||
    (entry.compression === 0 &&
      entry.compressedSize !== entry.uncompressedSize)
  ) {
    await compressedStream.cancel().catch(() => undefined);
    return false;
  }

  let compressedCount = 0;
  const countedCompressed = compressedStream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        compressedCount += chunk.byteLength;
        if (
          compressedCount > entry.compressedSize ||
          compressedCount > maxCompressedBytes
        ) {
          throw new Error("Compressed worksheet exceeds its declared size");
        }
        controller.enqueue(chunk);
      },
    }),
  );
  const decompressor = new DecompressionStream(
    "deflate-raw",
  ) as unknown as TransformStream<Uint8Array, Uint8Array>;
  const uncompressedStream =
    entry.compression === 0
      ? countedCompressed
      : countedCompressed.pipeThrough(decompressor);
  const reader = uncompressedStream.getReader();
  const xmlProbe = new WorksheetXmlProbe();
  let uncompressedCount = 0;
  let crc = 0xffffffff;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      uncompressedCount += value.byteLength;
      if (
        uncompressedCount > entry.uncompressedSize ||
        uncompressedCount > maxUncompressedBytes
      ) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      crc = updateCrc32(crc, value);
      if (!xmlProbe.write(value)) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (r2State?.error) throw r2State.error;
    if (error instanceof XlsxObjectReadError) throw error;
    return false;
  }

  if (r2State?.error) throw r2State.error;
  if (r2State && !r2State.complete) {
    throw new XlsxObjectReadError("R2 range stream did not complete");
  }

  return (
    xmlProbe.finish() &&
    compressedCount === entry.compressedSize &&
    uncompressedCount === entry.uncompressedSize &&
    ((crc ^ 0xffffffff) >>> 0) === entry.crc32
  );
}

async function validateR2WorksheetEntry(
  bucket: R2Bucket,
  key: string,
  objectSize: number,
  centralOffset: number,
  expectedEtag: string,
  entry: R2ZipEntry,
) {
  const dataStart = await readR2LocalEntryDataStart(
    bucket,
    key,
    objectSize,
    centralOffset,
    expectedEtag,
    entry,
    MAX_XLSX_OBJECT_BYTES,
    MAX_XLSX_OBJECT_BYTES,
  );
  if (dataStart === null) return false;
  const { stream, state } = await openR2RangeStream(
    bucket,
    key,
    { offset: dataStart, length: entry.compressedSize },
    entry.compressedSize,
    objectSize,
    expectedEtag,
  );
  return validateWorksheetStream(
    stream,
    entry,
    MAX_XLSX_OBJECT_BYTES,
    MAX_XLSX_OBJECT_BYTES,
    state,
  );
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
    return (
      elementHasNamespace(
        document.root,
        "Relationships",
        PACKAGE_RELATIONSHIPS_NAMESPACE,
      ) &&
      document.elements.some(
        (element) =>
          element.depth === 1 &&
          elementHasNamespace(
            element,
            "Relationship",
            PACKAGE_RELATIONSHIPS_NAMESPACE,
          ) &&
          element.attributes
            .get("Type")
            ?.endsWith("/relationships/officeDocument") &&
          element.attributes.get("Target")?.replace(/^\//, "") ===
            "xl/workbook.xml" &&
          element.attributes.get("TargetMode") !== "External",
      )
    );
  }
  if (name === "xl/workbook.xml") {
    return workbookSheetRelationshipIds(xml) !== null;
  }
  if (name === "xl/_rels/workbook.xml.rels") {
    return workbookRelationshipsDocument(xml) !== null;
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
    const entriesByName = new Map<string, ZipEntry>();
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
      const zipEntry = {
        compression,
        compressedSize,
        uncompressedSize,
        crc32: entryCrc32,
        dataStart: localDataStart,
      };
      entriesByName.set(name, zipEntry);
      if (REQUIRED_XLSX_ENTRIES.has(name)) {
        if (
          compressedSize > MAX_REQUIRED_ENTRY_BYTES ||
          uncompressedSize <= 0 ||
          uncompressedSize > MAX_REQUIRED_ENTRY_BYTES
        ) {
          return false;
        }
        requiredEntries.set(name, zipEntry);
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) return false;
      cursor = nextEntry;
    }

    if (cursor !== eocdOffset || requiredEntries.size !== REQUIRED_XLSX_ENTRIES.size) {
      return false;
    }

    const requiredXml = new Map<string, string>();
    for (const requiredName of REQUIRED_XLSX_ENTRIES) {
      const entry = requiredEntries.get(requiredName);
      if (!entry) return false;
      const unpacked = await unpackEntry(
        bytes,
        entry,
        MAX_REQUIRED_ENTRY_BYTES,
      );
      if (!unpacked) return false;
      const xml = xmlDecoder.decode(unpacked);
      if (!hasExpectedXlsxXml(requiredName, xml)) {
        return false;
      }
      requiredXml.set(requiredName, xml);
    }

    const workbookXml = requiredXml.get("xl/workbook.xml");
    const workbookRelationshipsXml = requiredXml.get(
      "xl/_rels/workbook.xml.rels",
    );
    if (!workbookXml || !workbookRelationshipsXml) return false;
    const worksheetName = linkedWorksheetEntryName(
      workbookXml,
      workbookRelationshipsXml,
    );
    if (!worksheetName) return false;
    const worksheetEntry = entriesByName.get(worksheetName);
    if (!worksheetEntry) return false;
    const worksheetIsValid = await validateWorksheetStream(
      byteRangeStream(
        bytes,
        worksheetEntry.dataStart,
        worksheetEntry.compressedSize,
      ),
      worksheetEntry,
      MAX_XLSX_BYTES,
      MAX_UNCOMPRESSED_BYTES,
    );
    return worksheetIsValid;
  } catch {
    return false;
  }
}

export async function isValidXlsxObject(
  bucket: R2Bucket,
  key: string,
  size: number,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(size) ||
    size < 22 ||
    size > MAX_XLSX_OBJECT_BYTES
  ) {
    return false;
  }

  try {
    const suffixLength = Math.min(size, MAX_EOCD_BYTES);
    const suffixResult = await readR2Range(
      bucket,
      key,
      { suffix: suffixLength },
      suffixLength,
      size,
    );

    const suffix = suffixResult.bytes;
    const suffixView = new DataView(
      suffix.buffer,
      suffix.byteOffset,
      suffix.byteLength,
    );
    const eocdOffset = findEndOfCentralDirectory(suffix, suffixView);
    if (eocdOffset < 0) return false;
    if (
      eocdOffset >= 20 &&
      suffixView.getUint32(eocdOffset - 20, true) ===
        ZIP64_EOCD_LOCATOR_SIGNATURE
    ) {
      return false;
    }

    const diskNumber = suffixView.getUint16(eocdOffset + 4, true);
    const centralDisk = suffixView.getUint16(eocdOffset + 6, true);
    const diskEntries = suffixView.getUint16(eocdOffset + 8, true);
    const entryCount = suffixView.getUint16(eocdOffset + 10, true);
    const centralSize = suffixView.getUint32(eocdOffset + 12, true);
    const centralOffset = suffixView.getUint32(eocdOffset + 16, true);
    const absoluteEocdOffset = size - suffixLength + eocdOffset;
    if (
      diskNumber !== 0 ||
      centralDisk !== 0 ||
      diskEntries !== entryCount ||
      entryCount === 0xffff ||
      entryCount < REQUIRED_XLSX_ENTRIES.size ||
      entryCount > MAX_ZIP_ENTRIES ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff ||
      centralSize < entryCount * 46 ||
      centralSize > MAX_CENTRAL_DIRECTORY_BYTES ||
      centralOffset + centralSize !== absoluteEocdOffset
    ) {
      return false;
    }

    const centralResult = await readR2Range(
      bucket,
      key,
      { offset: centralOffset, length: centralSize },
      centralSize,
      size,
      suffixResult.etag,
    );
    const central = centralResult.bytes;
    const centralView = new DataView(
      central.buffer,
      central.byteOffset,
      central.byteLength,
    );
    const names = new Set<string>();
    const entriesByName = new Map<string, R2ZipEntry>();
    const requiredEntries = new Map<string, R2ZipEntry>();
    let totalUncompressed = 0;
    let cursor = 0;
    for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
      if (
        cursor + 46 > central.length ||
        centralView.getUint32(cursor, true) !== CENTRAL_SIGNATURE
      ) {
        return false;
      }

      const flags = centralView.getUint16(cursor + 8, true);
      const compression = centralView.getUint16(cursor + 10, true);
      const entryCrc32 = centralView.getUint32(cursor + 16, true);
      const compressedSize = centralView.getUint32(cursor + 20, true);
      const uncompressedSize = centralView.getUint32(cursor + 24, true);
      const nameLength = centralView.getUint16(cursor + 28, true);
      const extraLength = centralView.getUint16(cursor + 30, true);
      const commentLength = centralView.getUint16(cursor + 32, true);
      const entryDisk = centralView.getUint16(cursor + 34, true);
      const localOffset = centralView.getUint32(cursor + 42, true);
      const nextEntry = cursor + 46 + nameLength + extraLength + commentLength;
      if (
        (flags & ENCRYPTION_FLAGS) !== 0 ||
        (compression !== 0 && compression !== 8) ||
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        entryDisk !== 0 ||
        nameLength === 0 ||
        localOffset === 0xffffffff ||
        nextEntry > central.length ||
        localOffset + 30 + compressedSize > centralOffset
      ) {
        return false;
      }

      const nameStart = cursor + 46;
      const nameBytes = central.subarray(nameStart, nameStart + nameLength);
      const extraStart = nameStart + nameLength;
      const extra = central.subarray(extraStart, extraStart + extraLength);
      if (!isSafeNonZip64Extra(extra)) return false;

      const name = filenameDecoder.decode(nameBytes);
      if (!safeZipPath(name) || names.has(name)) return false;
      names.add(name);

      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_XLSX_OBJECT_BYTES) return false;

      const zipEntry = {
        flags,
        compression,
        compressedSize,
        uncompressedSize,
        crc32: entryCrc32,
        localOffset,
        nameBytes,
      };
      entriesByName.set(name, zipEntry);
      if (REQUIRED_XLSX_ENTRIES.has(name)) {
        if (
          compressedSize > MAX_REQUIRED_ENTRY_BYTES ||
          uncompressedSize <= 0 ||
          uncompressedSize > MAX_REQUIRED_ENTRY_BYTES
        ) {
          return false;
        }
        requiredEntries.set(name, zipEntry);
      }
      cursor = nextEntry;
    }

    if (
      cursor !== central.length ||
      requiredEntries.size !== REQUIRED_XLSX_ENTRIES.size
    ) {
      return false;
    }

    const requiredXml = new Map<string, string>();
    for (const requiredName of REQUIRED_XLSX_ENTRIES) {
      const entry = requiredEntries.get(requiredName);
      if (!entry) return false;
      const unpacked = await readR2ZipEntry(
        bucket,
        key,
        size,
        centralOffset,
        suffixResult.etag,
        entry,
      );
      if (!unpacked) return false;
      const xml = xmlDecoder.decode(unpacked);
      if (!hasExpectedXlsxXml(requiredName, xml)) return false;
      requiredXml.set(requiredName, xml);
    }

    const workbookXml = requiredXml.get("xl/workbook.xml");
    const workbookRelationshipsXml = requiredXml.get(
      "xl/_rels/workbook.xml.rels",
    );
    if (!workbookXml || !workbookRelationshipsXml) return false;
    const worksheetName = linkedWorksheetEntryName(
      workbookXml,
      workbookRelationshipsXml,
    );
    if (!worksheetName) return false;
    const worksheetEntry = entriesByName.get(worksheetName);
    if (!worksheetEntry) return false;
    const worksheetIsValid = await validateR2WorksheetEntry(
      bucket,
      key,
      size,
      centralOffset,
      suffixResult.etag,
      worksheetEntry,
    );
    return worksheetIsValid;
  } catch (error) {
    if (error instanceof XlsxObjectReadError) throw error;
    return false;
  }
}

export function formatFileSize(size: number) {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}
