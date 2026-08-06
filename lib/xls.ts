export const MAX_XLS_BYTES = 20 * 1024 * 1024;
export const MAX_XLS_OBJECT_BYTES = 1024 * 1024 * 1024;

export const CFBF_SIGNATURE = new Uint8Array([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

const HEADER_BYTES = 512;
const MINI_STREAM_CUTOFF = 4096;
const MINI_SECTOR_BYTES = 64;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;
const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_MINIFAT_BYTES = 8 * 1024 * 1024;
const MAX_ROOT_MINI_STREAM_BYTES = 64 * 1024 * 1024;
const R2_PAGE_BYTES = 2 * 1024 * 1024;
const R2_CACHE_PAGES = 4;
const R2_MAX_REQUESTS = 768;
const R2_EXTRA_READ_BUDGET = 64 * 1024 * 1024;
const MAX_BIFF_RECORD_BYTES = 8224;
const MAX_BIFF_RECORDS = 4_000_000;
const MAX_BOUND_SHEETS = 16_384;
const BIFF_BOF = 0x0809;
const BIFF_EOF = 0x000a;
const BIFF_BOUNDSHEET = 0x0085;
const BIFF_FILEPASS = 0x002f;
const BIFF_OBPROJ = 0x00d3;
const BIFF8_VERSION = 0x0600;
const BIFF_WORKBOOK_GLOBALS = 0x0005;
const BIFF_WORKSHEET = 0x0010;
const forbiddenStorageNames = new Set([
  "vba",
  "_vba_project_cur",
  "objectpool",
]);
const utf16Decoder = new TextDecoder("utf-16le", { fatal: true });

export class XlsObjectReadError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "XlsObjectReadError";
    this.cause = cause;
  }
}

class XlsValidationLimitError extends Error {}

interface RandomReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

type Header = {
  majorVersion: 3 | 4;
  sectorSize: number;
  entriesPerSector: number;
  totalSectors: number;
  directorySectorCount: number;
  fatSectorCount: number;
  firstDirectorySector: number;
  firstMiniFatSector: number;
  miniFatSectorCount: number;
  firstDifatSector: number;
  difatSectorCount: number;
  headerDifat: Uint32Array;
};

type DirectoryEntry = {
  index: number;
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  startSector: number;
  size: number;
};

function isSafeIntegerRange(offset: number, length: number, size: number) {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset <= size &&
    length <= size - offset
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function allZero(bytes: Uint8Array) {
  for (const byte of bytes) {
    if (byte !== 0) return false;
  }
  return true;
}

function getUint64(view: DataView, offset: number) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

class ByteReader implements RandomReader {
  readonly size: number;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.size = bytes.byteLength;
  }

  async read(offset: number, length: number) {
    if (!isSafeIntegerRange(offset, length, this.size)) {
      throw new XlsValidationLimitError("Invalid byte range");
    }
    return this.bytes.subarray(offset, offset + length);
  }
}

async function readR2BodyExactly(
  object: R2ObjectBody,
  expectedLength: number,
) {
  if (object.bodyUsed) {
    throw new XlsObjectReadError("R2 range body was already consumed");
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = object.body.getReader();
  } catch (error) {
    throw new XlsObjectReadError("Could not open the R2 range body", error);
  }

  const output = new Uint8Array(expectedLength);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined);
        throw new XlsObjectReadError("R2 returned a non-byte range body");
      }
      if (value.byteLength > expectedLength - total) {
        await reader.cancel().catch(() => undefined);
        throw new XlsObjectReadError(
          "R2 returned more range bytes than requested",
        );
      }
      output.set(value, total);
      total += value.byteLength;
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // A failed R2 body is already unusable.
    }
    if (error instanceof XlsObjectReadError) throw error;
    throw new XlsObjectReadError("Could not read the R2 range body", error);
  }

  if (total !== expectedLength) {
    throw new XlsObjectReadError("R2 returned fewer range bytes than requested");
  }
  return output;
}

class R2PagedReader implements RandomReader {
  readonly size: number;
  private readonly bucket: R2Bucket;
  private readonly key: string;
  private readonly pages = new Map<number, Uint8Array>();
  private readonly readBudget: number;
  private totalRead = 0;
  private requestCount = 0;
  private etag: string | null = null;

  constructor(
    bucket: R2Bucket,
    key: string,
    size: number,
  ) {
    this.bucket = bucket;
    this.key = key;
    this.size = size;
    this.readBudget = Math.min(
      MAX_XLS_OBJECT_BYTES + R2_EXTRA_READ_BUDGET,
      size + R2_EXTRA_READ_BUDGET,
    );
  }

  private async loadPage(pageIndex: number) {
    const cached = this.pages.get(pageIndex);
    if (cached) {
      this.pages.delete(pageIndex);
      this.pages.set(pageIndex, cached);
      return cached;
    }

    const offset = pageIndex * R2_PAGE_BYTES;
    const length = Math.min(R2_PAGE_BYTES, this.size - offset);
    if (!isSafeIntegerRange(offset, length, this.size) || length <= 0) {
      throw new XlsValidationLimitError("Invalid R2 page");
    }
    if (this.totalRead + length > this.readBudget) {
      throw new XlsValidationLimitError("XLS validation read budget exceeded");
    }
    if (this.requestCount >= R2_MAX_REQUESTS) {
      throw new XlsValidationLimitError("XLS validation request budget exceeded");
    }

    const options: R2GetOptions = {
      range: { offset, length },
    };
    if (this.etag !== null) options.onlyIf = { etagMatches: this.etag };

    let object: R2ObjectBody | R2Object | null;
    this.requestCount += 1;
    try {
      object = await this.bucket.get(this.key, options);
    } catch (error) {
      throw new XlsObjectReadError("Could not read an XLS range from R2", error);
    }
    if (
      !object ||
      !("body" in object) ||
      object.size !== this.size ||
      (this.etag !== null && object.etag !== this.etag)
    ) {
      throw new XlsObjectReadError(
        "R2 returned an unavailable or changed XLS range",
      );
    }
    if (this.etag === null) this.etag = object.etag;

    const page = await readR2BodyExactly(object, length);
    this.totalRead += length;
    this.pages.set(pageIndex, page);
    while (this.pages.size > R2_CACHE_PAGES) {
      const oldest = this.pages.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.pages.delete(oldest);
    }
    return page;
  }

  async read(offset: number, length: number) {
    if (!isSafeIntegerRange(offset, length, this.size)) {
      throw new XlsValidationLimitError("Invalid XLS object range");
    }
    if (length === 0) return new Uint8Array();

    const firstPage = Math.floor(offset / R2_PAGE_BYTES);
    const lastPage = Math.floor((offset + length - 1) / R2_PAGE_BYTES);
    if (firstPage === lastPage) {
      const page = await this.loadPage(firstPage);
      const within = offset - firstPage * R2_PAGE_BYTES;
      return page.subarray(within, within + length);
    }

    const output = new Uint8Array(length);
    let written = 0;
    for (let pageIndex = firstPage; pageIndex <= lastPage; pageIndex += 1) {
      const page = await this.loadPage(pageIndex);
      const pageStart = pageIndex * R2_PAGE_BYTES;
      const sourceStart = Math.max(offset, pageStart) - pageStart;
      const sourceEnd = Math.min(offset + length, pageStart + page.length) - pageStart;
      output.set(page.subarray(sourceStart, sourceEnd), written);
      written += sourceEnd - sourceStart;
    }
    if (written !== length) {
      throw new XlsObjectReadError("R2 returned an incomplete XLS range");
    }
    return output;
  }
}

function parseHeader(bytes: Uint8Array, fileSize: number): Header | null {
  if (bytes.byteLength !== HEADER_BYTES) return null;
  if (!equalBytes(bytes.subarray(0, 8), CFBF_SIGNATURE)) return null;
  if (!allZero(bytes.subarray(8, 24))) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minorVersion = view.getUint16(24, true);
  const majorVersion = view.getUint16(26, true);
  const byteOrder = view.getUint16(28, true);
  const sectorShift = view.getUint16(30, true);
  const miniSectorShift = view.getUint16(32, true);
  const directorySectorCount = view.getUint32(40, true);
  const fatSectorCount = view.getUint32(44, true);
  const firstDirectorySector = view.getUint32(48, true);
  const miniStreamCutoff = view.getUint32(56, true);
  const firstMiniFatSector = view.getUint32(60, true);
  const miniFatSectorCount = view.getUint32(64, true);
  const firstDifatSector = view.getUint32(68, true);
  const difatSectorCount = view.getUint32(72, true);

  if (
    (minorVersion !== 0x003b && minorVersion !== 0x003e) ||
    (majorVersion !== 3 && majorVersion !== 4) ||
    byteOrder !== 0xfffe ||
    sectorShift !== (majorVersion === 3 ? 9 : 12) ||
    miniSectorShift !== 6 ||
    !allZero(bytes.subarray(34, 40)) ||
    (majorVersion === 3 && directorySectorCount !== 0) ||
    (majorVersion === 4 && directorySectorCount === 0) ||
    fatSectorCount === 0 ||
    miniStreamCutoff !== MINI_STREAM_CUTOFF
  ) {
    return null;
  }

  const sectorSize = 1 << sectorShift;
  if (fileSize < sectorSize * 3 || fileSize % sectorSize !== 0) return null;
  const totalSectors = fileSize / sectorSize - 1;
  const entriesPerSector = sectorSize / 4;
  if (
    !Number.isSafeInteger(totalSectors) ||
    totalSectors <= 0 ||
    fatSectorCount !== Math.ceil(totalSectors / entriesPerSector) ||
    firstDirectorySector >= totalSectors ||
    miniFatSectorCount > Math.floor(MAX_MINIFAT_BYTES / sectorSize) ||
    (miniFatSectorCount === 0 && firstMiniFatSector !== ENDOFCHAIN) ||
    (miniFatSectorCount > 0 && firstMiniFatSector >= totalSectors)
  ) {
    return null;
  }

  const extendedDifatCapacity = entriesPerSector - 1;
  const requiredDifatSectors =
    fatSectorCount <= 109
      ? 0
      : Math.ceil((fatSectorCount - 109) / extendedDifatCapacity);
  if (
    difatSectorCount !== requiredDifatSectors ||
    (difatSectorCount === 0 && firstDifatSector !== ENDOFCHAIN) ||
    (difatSectorCount > 0 && firstDifatSector >= totalSectors)
  ) {
    return null;
  }

  const headerDifat = new Uint32Array(109);
  for (let index = 0; index < headerDifat.length; index += 1) {
    headerDifat[index] = view.getUint32(76 + index * 4, true);
  }
  const headerFatCount = Math.min(fatSectorCount, 109);
  for (let index = 0; index < headerDifat.length; index += 1) {
    if (
      (index < headerFatCount && headerDifat[index] >= totalSectors) ||
      (index >= headerFatCount && headerDifat[index] !== FREESECT)
    ) {
      return null;
    }
  }

  return {
    majorVersion,
    sectorSize,
    entriesPerSector,
    totalSectors,
    directorySectorCount,
    fatSectorCount,
    firstDirectorySector,
    firstMiniFatSector,
    miniFatSectorCount,
    firstDifatSector,
    difatSectorCount,
    headerDifat,
  };
}

class CompoundFile {
  readonly header: Header;
  private readonly reader: RandomReader;
  private fatSectors = new Uint32Array();
  private difatSectors = new Uint32Array();
  private readonly claimedSectors: Uint8Array;

  constructor(
    reader: RandomReader,
    header: Header,
  ) {
    this.reader = reader;
    this.header = header;
    this.claimedSectors = new Uint8Array(header.totalSectors);
  }

  private sectorOffset(sector: number) {
    return (sector + 1) * this.header.sectorSize;
  }

  private async readSector(sector: number) {
    if (!Number.isInteger(sector) || sector < 0 || sector >= this.header.totalSectors) {
      throw new XlsValidationLimitError("Invalid CFBF sector");
    }
    return this.reader.read(this.sectorOffset(sector), this.header.sectorSize);
  }

  async initializeFat() {
    const fatSectors: number[] = [];
    const fatSeen = new Uint8Array(this.header.totalSectors);
    for (
      let index = 0;
      index < Math.min(this.header.fatSectorCount, 109);
      index += 1
    ) {
      const sector = this.header.headerDifat[index];
      if (fatSeen[sector]) return false;
      fatSeen[sector] = 1;
      fatSectors.push(sector);
    }

    const difatSectors: number[] = [];
    const difatSeen = new Uint8Array(this.header.totalSectors);
    let nextDifat = this.header.firstDifatSector;
    let remaining = this.header.fatSectorCount - fatSectors.length;
    for (let chainIndex = 0; chainIndex < this.header.difatSectorCount; chainIndex += 1) {
      if (
        nextDifat >= this.header.totalSectors ||
        difatSeen[nextDifat] ||
        fatSeen[nextDifat]
      ) {
        return false;
      }
      difatSeen[nextDifat] = 1;
      difatSectors.push(nextDifat);
      const bytes = await this.readSector(nextDifat);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const capacity = this.header.entriesPerSector - 1;
      const take = Math.min(remaining, capacity);
      for (let index = 0; index < capacity; index += 1) {
        const sector = view.getUint32(index * 4, true);
        if (index < take) {
          if (
            sector >= this.header.totalSectors ||
            fatSeen[sector] ||
            difatSeen[sector]
          ) {
            return false;
          }
          fatSeen[sector] = 1;
          fatSectors.push(sector);
        } else if (sector !== FREESECT) {
          return false;
        }
      }
      remaining -= take;
      const linked = view.getUint32(capacity * 4, true);
      const isLast = chainIndex + 1 === this.header.difatSectorCount;
      if ((isLast && linked !== ENDOFCHAIN) || (!isLast && linked >= this.header.totalSectors)) {
        return false;
      }
      nextDifat = linked;
    }
    if (remaining !== 0 || fatSectors.length !== this.header.fatSectorCount) {
      return false;
    }

    this.fatSectors = Uint32Array.from(fatSectors);
    this.difatSectors = Uint32Array.from(difatSectors);
    for (const sector of this.fatSectors) {
      if ((await this.fatEntry(sector)) !== FATSECT) return false;
    }
    for (const sector of this.difatSectors) {
      if ((await this.fatEntry(sector)) !== DIFSECT) return false;
    }
    return true;
  }

  private async fatEntry(sector: number) {
    if (sector < 0 || sector >= this.header.totalSectors) return FREESECT;
    const fatPageIndex = Math.floor(sector / this.header.entriesPerSector);
    if (fatPageIndex >= this.fatSectors.length) return FREESECT;
    const entryIndex = sector % this.header.entriesPerSector;
    const fatSector = this.fatSectors[fatPageIndex];
    const bytes = await this.reader.read(
      this.sectorOffset(fatSector) + entryIndex * 4,
      4,
    );
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }

  async walkFatChain(
    startSector: number,
    exactLength: number | null,
    maximumLength: number,
  ) {
    if (
      maximumLength < 1 ||
      maximumLength > this.header.totalSectors ||
      (exactLength !== null && (exactLength < 1 || exactLength > maximumLength))
    ) {
      return null;
    }
    const capacity = exactLength ?? maximumLength;
    const chain = new Uint32Array(capacity);
    const seen = new Uint8Array(Math.ceil(this.header.totalSectors / 8));
    let count = 0;
    let current = startSector;
    while (current !== ENDOFCHAIN) {
      if (current >= this.header.totalSectors || count >= capacity) return null;
      const byteIndex = current >>> 3;
      const bit = 1 << (current & 7);
      if ((seen[byteIndex] & bit) !== 0) return null;
      seen[byteIndex] |= bit;
      chain[count] = current;
      count += 1;
      current = await this.fatEntry(current);
      if (current >= this.header.totalSectors && current !== ENDOFCHAIN) return null;
    }
    if (count === 0 || (exactLength !== null && count !== exactLength)) return null;
    return chain.slice(0, count);
  }

  claim(chain: Uint32Array, owner: number) {
    for (const sector of chain) {
      if (this.claimedSectors[sector] !== 0) return false;
    }
    for (const sector of chain) this.claimedSectors[sector] = owner;
    return true;
  }

  async readDirectory(chain: Uint32Array) {
    const entries: DirectoryEntry[] = [];
    const types = new Uint8Array((chain.byteLength / 4) * (this.header.sectorSize / 128));
    let root: DirectoryEntry | null = null;
    let workbook: DirectoryEntry | null = null;

    for (let chainIndex = 0; chainIndex < chain.length; chainIndex += 1) {
      const bytes = await this.readSector(chain[chainIndex]);
      for (let offset = 0; offset < bytes.length; offset += 128) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 128);
        const index = chainIndex * (this.header.sectorSize / 128) + offset / 128;
        const type = view.getUint8(66);
        types[index] = type;
        if (type === 0) continue;
        if (type !== 1 && type !== 2 && type !== 5) return null;

        const nameLength = view.getUint16(64, true);
        if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0) return null;
        const nameBytes = bytes.subarray(offset, offset + nameLength);
        if (nameBytes[nameBytes.length - 2] !== 0 || nameBytes[nameBytes.length - 1] !== 0) {
          return null;
        }
        const name = utf16Decoder.decode(nameBytes.subarray(0, -2));
        if (!name || name.includes("\0")) return null;

        const size = getUint64(view, 120);
        if (size === null || size > this.reader.size) return null;
        if (this.header.majorVersion === 3 && view.getUint32(124, true) !== 0) {
          return null;
        }
        const entry: DirectoryEntry = {
          index,
          name,
          type,
          left: view.getUint32(68, true),
          right: view.getUint32(72, true),
          child: view.getUint32(76, true),
          startSector: view.getUint32(116, true),
          size,
        };
        entries.push(entry);

        const lowerName = name.toLowerCase();
        if (lowerName === "ctls") return null;
        if (type === 1 && forbiddenStorageNames.has(lowerName)) return null;
        if (
          (lowerName === "workbook" || lowerName === "book") &&
          type !== 2
        ) {
          return null;
        }
        if (type === 5) {
          if (root || index !== 0 || name !== "Root Entry") return null;
          root = entry;
        }
        if (type === 2 && (lowerName === "workbook" || lowerName === "book")) {
          if (workbook) return null;
          workbook = entry;
        }
      }
    }

    if (!root || !workbook || workbook.size === 0) return null;
    const entriesByIndex = new Map(
      entries.map((entry) => [entry.index, entry] as const),
    );
    for (const entry of entries) {
      for (const pointer of [entry.left, entry.right, entry.child]) {
        if (
          pointer !== NOSTREAM &&
          (pointer >= types.length || pointer === entry.index || types[pointer] === 0)
        ) {
          return null;
        }
      }
      if (entry.type === 2 && entry.child !== NOSTREAM) return null;
    }
    if (root.left !== NOSTREAM || root.right !== NOSTREAM) return null;

    const reached = new Set<number>([root.index]);
    const pendingStorages = [root];
    let workbookIsRootChild = false;
    while (pendingStorages.length > 0) {
      const storage = pendingStorages.pop();
      if (!storage) return null;
      const pendingSiblings =
        storage.child === NOSTREAM ? [] : [storage.child];
      const directChildren: DirectoryEntry[] = [];
      while (pendingSiblings.length > 0) {
        const index = pendingSiblings.pop();
        if (index === undefined || reached.has(index)) return null;
        const entry = entriesByIndex.get(index);
        if (!entry || entry.type === 5) return null;
        reached.add(index);
        directChildren.push(entry);
        if (entry.left !== NOSTREAM) pendingSiblings.push(entry.left);
        if (entry.right !== NOSTREAM) pendingSiblings.push(entry.right);
      }
      for (const child of directChildren) {
        if (storage.index === root.index && child.index === workbook.index) {
          workbookIsRootChild = true;
        }
        if (child.type === 1) pendingStorages.push(child);
      }
    }
    if (!workbookIsRootChild || reached.size !== entries.length) return null;
    return { root, workbook };
  }

  async readSectorBytes(sector: number, within: number, length: number) {
    return this.reader.read(this.sectorOffset(sector) + within, length);
  }

  async miniFatEntry(miniFatChain: Uint32Array, miniSector: number) {
    const pageIndex = Math.floor(miniSector / this.header.entriesPerSector);
    if (pageIndex >= miniFatChain.length) return FREESECT;
    const entryIndex = miniSector % this.header.entriesPerSector;
    const bytes = await this.readSectorBytes(
      miniFatChain[pageIndex],
      entryIndex * 4,
      4,
    );
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }

  async walkMiniChain(
    startSector: number,
    exactLength: number,
    miniFatChain: Uint32Array,
    rootMiniSectorCount: number,
  ) {
    if (exactLength < 1 || exactLength > rootMiniSectorCount) return null;
    const chain = new Uint32Array(exactLength);
    const seen = new Uint8Array(Math.ceil(rootMiniSectorCount / 8));
    let current = startSector;
    for (let index = 0; index < exactLength; index += 1) {
      if (current >= rootMiniSectorCount) return null;
      const byteIndex = current >>> 3;
      const bit = 1 << (current & 7);
      if ((seen[byteIndex] & bit) !== 0) return null;
      seen[byteIndex] |= bit;
      chain[index] = current;
      current = await this.miniFatEntry(miniFatChain, current);
      if (index + 1 < exactLength && current >= rootMiniSectorCount) return null;
    }
    if (current !== ENDOFCHAIN) return null;
    return chain;
  }
}

class CompoundStream {
  readonly size: number;
  private readonly compound: CompoundFile;
  private readonly sectors: Uint32Array;
  private readonly rootSectors: Uint32Array | null;

  constructor(
    size: number,
    compound: CompoundFile,
    sectors: Uint32Array,
    rootSectors: Uint32Array | null = null,
  ) {
    this.size = size;
    this.compound = compound;
    this.sectors = sectors;
    this.rootSectors = rootSectors;
  }

  async read(offset: number, length: number) {
    if (!isSafeIntegerRange(offset, length, this.size)) {
      throw new XlsValidationLimitError("Invalid workbook stream range");
    }
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const logical = offset + written;
      let sector: number;
      let within: number;
      let available: number;
      if (this.rootSectors) {
        const miniSector = this.sectors[Math.floor(logical / MINI_SECTOR_BYTES)];
        const rootOffset = miniSector * MINI_SECTOR_BYTES + (logical % MINI_SECTOR_BYTES);
        const rootIndex = Math.floor(rootOffset / this.compound.header.sectorSize);
        if (rootIndex >= this.rootSectors.length) {
          throw new XlsValidationLimitError("Invalid mini stream mapping");
        }
        sector = this.rootSectors[rootIndex];
        within = rootOffset % this.compound.header.sectorSize;
        available = Math.min(
          MINI_SECTOR_BYTES - (logical % MINI_SECTOR_BYTES),
          this.compound.header.sectorSize - within,
        );
      } else {
        const sectorIndex = Math.floor(logical / this.compound.header.sectorSize);
        if (sectorIndex >= this.sectors.length) {
          throw new XlsValidationLimitError("Invalid regular stream mapping");
        }
        sector = this.sectors[sectorIndex];
        within = logical % this.compound.header.sectorSize;
        available = this.compound.header.sectorSize - within;
      }
      const take = Math.min(length - written, available);
      const bytes = await this.compound.readSectorBytes(sector, within, take);
      output.set(bytes, written);
      written += take;
    }
    return output;
  }
}

function parseBof(payload: Uint8Array, expectedType: number) {
  if (payload.byteLength !== 16) return false;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return view.getUint16(0, true) === BIFF8_VERSION && view.getUint16(2, true) === expectedType;
}

function validSheetName(name: string) {
  return (
    name.length >= 1 &&
    name.length <= 31 &&
    ![...name].some((character) => "\0[]:*?/\\".includes(character)) &&
    !name.startsWith("'") &&
    !name.endsWith("'")
  );
}

function parseBoundSheet(payload: Uint8Array) {
  if (payload.byteLength < 10) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const offset = view.getUint32(0, true);
  const visibility = payload[4];
  const sheetType = payload[5];
  const characterCount = payload[6];
  const flags = payload[7];
  if (
    visibility > 2 ||
    sheetType !== 0 ||
    characterCount < 1 ||
    characterCount > 31 ||
    (flags & 0xfe) !== 0
  ) {
    return null;
  }
  const wide = (flags & 1) !== 0;
  const nameBytes = characterCount * (wide ? 2 : 1);
  if (payload.byteLength !== 8 + nameBytes) return null;
  let name: string;
  if (wide) {
    name = utf16Decoder.decode(payload.subarray(8));
  } else {
    name = String.fromCharCode(...payload.subarray(8));
  }
  if (!validSheetName(name)) return null;
  return { offset, name };
}

async function validateBiff8(stream: CompoundStream) {
  if (stream.size < 48) return false;
  const boundSheets = new Map<number, string>();
  const sheetNames = new Set<string>();
  let offset = 0;
  let records = 0;
  let firstSheetOffset = Number.POSITIVE_INFINITY;
  let firstRecord = true;
  let globalsEnded = false;

  while (offset < stream.size && !globalsEnded) {
    records += 1;
    if (records > MAX_BIFF_RECORDS || stream.size - offset < 4) return false;
    const header = await stream.read(offset, 4);
    const view = new DataView(header.buffer, header.byteOffset, 4);
    const recordType = view.getUint16(0, true);
    const recordLength = view.getUint16(2, true);
    const nextOffset = offset + 4 + recordLength;
    if (recordLength > MAX_BIFF_RECORD_BYTES || nextOffset > stream.size) return false;
    if (recordType === BIFF_FILEPASS || recordType === BIFF_OBPROJ) return false;

    if (firstRecord) {
      if (recordType !== BIFF_BOF || !parseBof(await stream.read(offset + 4, recordLength), BIFF_WORKBOOK_GLOBALS)) {
        return false;
      }
      firstRecord = false;
    } else {
      if (recordType === BIFF_BOF) return false;
      if (recordType === BIFF_BOUNDSHEET) {
        const boundSheet = parseBoundSheet(await stream.read(offset + 4, recordLength));
        if (
          !boundSheet ||
          boundSheet.offset <= nextOffset ||
          boundSheet.offset >= stream.size ||
          boundSheets.size >= MAX_BOUND_SHEETS ||
          boundSheets.has(boundSheet.offset) ||
          sheetNames.has(boundSheet.name.toLowerCase())
        ) {
          return false;
        }
        boundSheets.set(boundSheet.offset, boundSheet.name);
        sheetNames.add(boundSheet.name.toLowerCase());
        firstSheetOffset = Math.min(firstSheetOffset, boundSheet.offset);
      } else if (recordType === BIFF_EOF) {
        if (recordLength !== 0 || boundSheets.size === 0) return false;
        if (firstSheetOffset !== nextOffset) return false;
        globalsEnded = true;
      }
    }

    offset = nextOffset;
  }

  const sheetOffsets = [...boundSheets.keys()].sort((left, right) => left - right);
  for (let index = 0; index < sheetOffsets.length; index += 1) {
    const sheetOffset = sheetOffsets[index];
    const boundary = sheetOffsets[index + 1] ?? stream.size;
    if (boundary - sheetOffset < 24) return false;
    const header = await stream.read(sheetOffset, 4);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const recordType = view.getUint16(0, true);
    const recordLength = view.getUint16(2, true);
    if (
      recordType !== BIFF_BOF ||
      recordLength !== 16 ||
      !parseBof(
        await stream.read(sheetOffset + 4, recordLength),
        BIFF_WORKSHEET,
      )
    ) {
      return false;
    }
    const eof = await stream.read(boundary - 4, 4);
    const eofView = new DataView(eof.buffer, eof.byteOffset, eof.byteLength);
    if (
      eofView.getUint16(0, true) !== BIFF_EOF ||
      eofView.getUint16(2, true) !== 0
    ) {
      return false;
    }
  }
  return globalsEnded && boundSheets.size > 0;
}

async function validateReader(reader: RandomReader) {
  const headerBytes = await reader.read(0, HEADER_BYTES);
  const header = parseHeader(headerBytes, reader.size);
  if (!header) return false;
  if (header.majorVersion === 4) {
    const padding = await reader.read(HEADER_BYTES, header.sectorSize - HEADER_BYTES);
    if (!allZero(padding)) return false;
  }

  const compound = new CompoundFile(reader, header);
  if (!(await compound.initializeFat())) return false;

  const maximumDirectorySectors = Math.min(
    header.totalSectors,
    Math.floor(MAX_DIRECTORY_BYTES / header.sectorSize),
  );
  const exactDirectorySectors =
    header.majorVersion === 4 ? header.directorySectorCount : null;
  const directoryChain = await compound.walkFatChain(
    header.firstDirectorySector,
    exactDirectorySectors,
    maximumDirectorySectors,
  );
  if (!directoryChain || !compound.claim(directoryChain, 1)) return false;
  const directory = await compound.readDirectory(directoryChain);
  if (!directory) return false;

  let miniFatChain = new Uint32Array();
  if (header.miniFatSectorCount > 0) {
    const chain = await compound.walkFatChain(
      header.firstMiniFatSector,
      header.miniFatSectorCount,
      header.miniFatSectorCount,
    );
    if (!chain || !compound.claim(chain, 2)) return false;
    miniFatChain = chain;
  }

  let rootSectors = new Uint32Array();
  if (directory.root.size > 0) {
    if (
      directory.root.size > MAX_ROOT_MINI_STREAM_BYTES ||
      miniFatChain.length === 0
    ) {
      return false;
    }
    const rootSectorCount = Math.ceil(directory.root.size / header.sectorSize);
    const chain = await compound.walkFatChain(
      directory.root.startSector,
      rootSectorCount,
      rootSectorCount,
    );
    if (!chain || !compound.claim(chain, 3)) return false;
    rootSectors = chain;
  } else if (directory.root.startSector !== ENDOFCHAIN) {
    return false;
  }

  let workbookStream: CompoundStream;
  if (directory.workbook.size < MINI_STREAM_CUTOFF) {
    if (miniFatChain.length === 0 || rootSectors.length === 0) return false;
    const rootMiniSectorCount = Math.ceil(directory.root.size / MINI_SECTOR_BYTES);
    const workbookMiniSectorCount = Math.ceil(
      directory.workbook.size / MINI_SECTOR_BYTES,
    );
    const miniChain = await compound.walkMiniChain(
      directory.workbook.startSector,
      workbookMiniSectorCount,
      miniFatChain,
      rootMiniSectorCount,
    );
    if (!miniChain) return false;
    workbookStream = new CompoundStream(
      directory.workbook.size,
      compound,
      miniChain,
      rootSectors,
    );
  } else {
    const workbookSectorCount = Math.ceil(
      directory.workbook.size / header.sectorSize,
    );
    const workbookChain = await compound.walkFatChain(
      directory.workbook.startSector,
      workbookSectorCount,
      workbookSectorCount,
    );
    if (!workbookChain || !compound.claim(workbookChain, 4)) return false;
    workbookStream = new CompoundStream(
      directory.workbook.size,
      compound,
      workbookChain,
    );
  }

  return validateBiff8(workbookStream);
}

export async function isValidXlsBytes(bytes: Uint8Array) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1536 ||
    bytes.byteLength > MAX_XLS_BYTES
  ) {
    return false;
  }
  try {
    return await validateReader(new ByteReader(bytes));
  } catch {
    return false;
  }
}

export async function isValidXlsObject(
  bucket: R2Bucket,
  key: string,
  size: number,
) {
  if (
    !Number.isSafeInteger(size) ||
    size < 1536 ||
    size > MAX_XLS_OBJECT_BYTES
  ) {
    return false;
  }
  try {
    return await validateReader(new R2PagedReader(bucket, key, size));
  } catch (error) {
    if (error instanceof XlsObjectReadError) throw error;
    return false;
  }
}
