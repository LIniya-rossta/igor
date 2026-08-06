import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CFBF_SIGNATURE,
  isValidXlsBytes,
  isValidXlsObject,
  MAX_XLS_BYTES,
  MAX_XLS_OBJECT_BYTES,
  XlsObjectReadError,
} from "../lib/xls.ts";

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const TEST_ETAG = "xls-test-etag";

function concat(parts) {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function record(type, payload = new Uint8Array()) {
  const output = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(output.buffer);
  view.setUint16(0, type, true);
  view.setUint16(2, payload.byteLength, true);
  output.set(payload, 4);
  return output;
}

function bof(substreamType) {
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  view.setUint16(0, 0x0600, true);
  view.setUint16(2, substreamType, true);
  view.setUint16(4, 0x0dbb, true);
  view.setUint16(6, 0x07cc, true);
  view.setUint32(12, 0x00000006, true);
  return record(0x0809, payload);
}

function boundSheet(sheetOffset, sheetType = 0) {
  const name = "Price";
  const payload = new Uint8Array(8 + name.length * 2);
  const view = new DataView(payload.buffer);
  view.setUint32(0, sheetOffset, true);
  payload[4] = 0;
  payload[5] = sheetType;
  payload[6] = name.length;
  payload[7] = 1;
  for (let index = 0; index < name.length; index += 1) {
    view.setUint16(8 + index * 2, name.charCodeAt(index), true);
  }
  return record(0x0085, payload);
}

function makeBiff({
  filePass = false,
  objectProject = false,
  sheetType = 0,
  worksheetType = 0x0010,
  globalPaddingBytes = 0,
  paddingBytes = 0,
} = {}) {
  const globalBof = bof(0x0005);
  const securityRecords = [];
  if (filePass) securityRecords.push(record(0x002f, new Uint8Array([0, 0])));
  if (objectProject) securityRecords.push(record(0x00d3));
  const globalPadding = [];
  let globalRemaining = globalPaddingBytes;
  while (globalRemaining > 0) {
    const length = Math.min(8224, globalRemaining);
    globalPadding.push(record(0x01b8, new Uint8Array(length)));
    globalRemaining -= length;
  }
  const temporaryBound = boundSheet(0, sheetType);
  const globalsLength =
    globalBof.length +
    temporaryBound.length +
    securityRecords.reduce((total, part) => total + part.length, 0) +
    globalPadding.reduce((total, part) => total + part.length, 0) +
    4;
  const globals = concat([
    globalBof,
    boundSheet(globalsLength, sheetType),
    ...securityRecords,
    ...globalPadding,
    record(0x000a),
  ]);

  const padding = [];
  let remaining = paddingBytes;
  while (remaining > 0) {
    const length = Math.min(8224, remaining);
    padding.push(record(0x0203, new Uint8Array(length)));
    remaining -= length;
  }
  const worksheet = concat([
    bof(worksheetType),
    ...padding,
    record(0x000a),
  ]);
  return concat([globals, worksheet]);
}

function utf16Name(name) {
  const output = new Uint8Array((name.length + 1) * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < name.length; index += 1) {
    view.setUint16(index * 2, name.charCodeAt(index), true);
  }
  return output;
}

function writeDirectoryEntry(
  sector,
  index,
  {
    name,
    type,
    color = 1,
    left = FREESECT,
    right = FREESECT,
    child = FREESECT,
    start = ENDOFCHAIN,
    size = 0,
  },
) {
  const offset = index * 128;
  const view = new DataView(sector.buffer, sector.byteOffset + offset, 128);
  const nameBytes = utf16Name(name);
  sector.set(nameBytes, offset);
  view.setUint16(64, nameBytes.byteLength, true);
  view.setUint8(66, type);
  view.setUint8(67, color);
  view.setUint32(68, left, true);
  view.setUint32(72, right, true);
  view.setUint32(76, child, true);
  view.setUint32(116, start, true);
  view.setBigUint64(120, BigInt(size), true);
}

function linkChain(fat, sectors) {
  for (let index = 0; index < sectors.length; index += 1) {
    fat[sectors[index]] =
      index + 1 === sectors.length ? ENDOFCHAIN : sectors[index + 1];
  }
}

function makeCfb({
  biff = makeBiff(),
  version = 3,
  useMini = biff.byteLength < 4096,
  storageName = null,
  streamName = null,
  workbookName = "Workbook",
} = {}) {
  const sectorSize = version === 3 ? 512 : 4096;
  const entriesPerFatSector = sectorSize / 4;
  const workbookSectorCount = useMini
    ? 0
    : Math.ceil(biff.byteLength / sectorSize);
  const workbookMiniSectorCount = useMini
    ? Math.ceil(biff.byteLength / 64)
    : 0;
  const rootSize = workbookMiniSectorCount * 64;
  const rootSectorCount = useMini ? Math.ceil(rootSize / sectorSize) : 0;
  const nonFatSectorCount =
    1 + (useMini ? 1 + rootSectorCount : workbookSectorCount);
  let fatSectorCount = 1;
  let difatSectorCount = 0;
  while (true) {
    const nextDifatSectorCount =
      fatSectorCount <= 109
        ? 0
        : Math.ceil(
            (fatSectorCount - 109) / (entriesPerFatSector - 1),
          );
    const nextFatSectorCount = Math.ceil(
      (nonFatSectorCount + fatSectorCount + nextDifatSectorCount) /
        entriesPerFatSector,
    );
    if (
      nextFatSectorCount === fatSectorCount &&
      nextDifatSectorCount === difatSectorCount
    ) {
      break;
    }
    fatSectorCount = nextFatSectorCount;
    difatSectorCount = nextDifatSectorCount;
  }

  const fatSectors = Array.from({ length: fatSectorCount }, (_, index) => index);
  const difatSectors = Array.from(
    { length: difatSectorCount },
    (_, index) => fatSectorCount + index,
  );
  const directorySector = fatSectorCount + difatSectorCount;
  const miniFatSector = useMini ? directorySector + 1 : ENDOFCHAIN;
  const rootStart = useMini ? directorySector + 2 : ENDOFCHAIN;
  const rootSectors = useMini
    ? Array.from({ length: rootSectorCount }, (_, index) => rootStart + index)
    : [];
  const workbookStart = useMini
    ? 0
    : directorySector + 1;
  const workbookSectors = useMini
    ? []
    : Array.from(
        { length: workbookSectorCount },
        (_, index) => workbookStart + index,
      );
  const totalSectors =
    nonFatSectorCount + fatSectorCount + difatSectorCount;

  const fat = new Uint32Array(fatSectorCount * entriesPerFatSector);
  fat.fill(FREESECT);
  for (const sector of fatSectors) fat[sector] = FATSECT;
  for (const sector of difatSectors) fat[sector] = DIFSECT;
  fat[directorySector] = ENDOFCHAIN;
  if (useMini) {
    fat[miniFatSector] = ENDOFCHAIN;
    linkChain(fat, rootSectors);
  } else {
    linkChain(fat, workbookSectors);
  }

  const header = new Uint8Array(sectorSize);
  header.set(CFBF_SIGNATURE, 0);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(24, 0x003e, true);
  headerView.setUint16(26, version, true);
  headerView.setUint16(28, 0xfffe, true);
  headerView.setUint16(30, version === 3 ? 9 : 12, true);
  headerView.setUint16(32, 6, true);
  headerView.setUint32(40, version === 4 ? 1 : 0, true);
  headerView.setUint32(44, fatSectorCount, true);
  headerView.setUint32(48, directorySector, true);
  headerView.setUint32(56, 4096, true);
  headerView.setUint32(60, miniFatSector, true);
  headerView.setUint32(64, useMini ? 1 : 0, true);
  headerView.setUint32(68, difatSectors[0] ?? ENDOFCHAIN, true);
  headerView.setUint32(72, difatSectorCount, true);
  for (let index = 0; index < 109; index += 1) {
    headerView.setUint32(
      76 + index * 4,
      index < fatSectorCount ? fatSectors[index] : FREESECT,
      true,
    );
  }

  const sectors = Array.from(
    { length: totalSectors },
    () => new Uint8Array(sectorSize),
  );
  for (let page = 0; page < fatSectorCount; page += 1) {
    const view = new DataView(sectors[fatSectors[page]].buffer);
    for (let index = 0; index < entriesPerFatSector; index += 1) {
      view.setUint32(index * 4, fat[page * entriesPerFatSector + index], true);
    }
  }
  let extendedFatIndex = 109;
  for (let index = 0; index < difatSectors.length; index += 1) {
    const view = new DataView(sectors[difatSectors[index]].buffer);
    for (let entry = 0; entry < entriesPerFatSector - 1; entry += 1) {
      view.setUint32(
        entry * 4,
        extendedFatIndex < fatSectors.length
          ? fatSectors[extendedFatIndex]
          : FREESECT,
        true,
      );
      extendedFatIndex += 1;
    }
    view.setUint32(
      (entriesPerFatSector - 1) * 4,
      difatSectors[index + 1] ?? ENDOFCHAIN,
      true,
    );
  }

  const directory = sectors[directorySector];
  writeDirectoryEntry(directory, 0, {
    name: "Root Entry",
    type: 5,
    child: 1,
    start: rootStart,
    size: rootSize,
  });
  writeDirectoryEntry(directory, 1, {
    name: workbookName,
    type: 2,
    right: storageName || streamName ? 2 : FREESECT,
    start: workbookStart,
    size: biff.byteLength,
  });
  if (storageName) {
    writeDirectoryEntry(directory, 2, {
      name: storageName,
      type: 1,
    });
  } else if (streamName) {
    writeDirectoryEntry(directory, 2, {
      name: streamName,
      type: 2,
    });
  }

  if (useMini) {
    const miniFat = new Uint32Array(sectors[miniFatSector].buffer);
    miniFat.fill(FREESECT);
    for (let index = 0; index < workbookMiniSectorCount; index += 1) {
      miniFat[index] =
        index + 1 === workbookMiniSectorCount ? ENDOFCHAIN : index + 1;
    }
    const rootBytes = new Uint8Array(rootSectorCount * sectorSize);
    rootBytes.set(biff);
    for (let index = 0; index < rootSectorCount; index += 1) {
      sectors[rootSectors[index]].set(
        rootBytes.subarray(index * sectorSize, (index + 1) * sectorSize),
      );
    }
  } else {
    for (let index = 0; index < workbookSectors.length; index += 1) {
      sectors[workbookSectors[index]].set(
        biff.subarray(index * sectorSize, (index + 1) * sectorSize),
      );
    }
  }
  return concat([header, ...sectors]);
}

function mockBucket(
  bytes,
  {
    throwCall = -1,
    nullCall = -1,
    truncateCall = -1,
    changedEtagCall = -1,
    bodyErrorCall = -1,
  } = {},
) {
  const calls = [];
  const bucket = {
    calls,
    maxRange: 0,
    async get(key, options = {}) {
      assert.equal(key, "prices/current.xls");
      const callIndex = calls.length;
      calls.push(options);
      if (callIndex === throwCall) throw new Error("temporary R2 failure");
      if (callIndex === nullCall) return null;
      const range = options.range;
      assert.ok(range && "offset" in range && "length" in range);
      const offset = range.offset;
      const length = range.length;
      bucket.maxRange = Math.max(bucket.maxRange, length);
      if (
        offset < 0 ||
        length < 0 ||
        offset + length > bytes.length ||
        (options.onlyIf?.etagMatches &&
          options.onlyIf.etagMatches !== TEST_ETAG)
      ) {
        return null;
      }

      const returnedLength = callIndex === truncateCall ? length - 1 : length;
      const etag = callIndex === changedEtagCall ? "changed-etag" : TEST_ETAG;
      return {
        size: bytes.length,
        etag,
        bodyUsed: false,
        body: new ReadableStream({
          start(controller) {
            if (callIndex === bodyErrorCall) {
              controller.error(new Error("temporary body failure"));
              return;
            }
            let streamed = 0;
            while (streamed < returnedLength) {
              const take = Math.min(4096, returnedLength - streamed);
              controller.enqueue(
                bytes.slice(offset + streamed, offset + streamed + take),
              );
              streamed += take;
            }
            controller.close();
          },
        }),
      };
    },
  };
  return bucket;
}

test("accepts a real BIFF8 XLS through bytes and ETag-pinned R2 ranges", async () => {
  const workbook = new Uint8Array(
    await readFile(new URL("./fixtures/price.xls", import.meta.url)),
  );
  assert.equal(await isValidXlsBytes(workbook), true);
  assert.equal(
    await isValidXlsObject(
      mockBucket(workbook),
      "prices/current.xls",
      workbook.byteLength,
    ),
    true,
  );

  const largeWorkbook = makeCfb({
    biff: makeBiff({ globalPaddingBytes: 3 * 1024 * 1024 }),
    useMini: false,
  });
  const bucket = mockBucket(largeWorkbook);
  assert.equal(
    await isValidXlsObject(
      bucket,
      "prices/current.xls",
      largeWorkbook.byteLength,
    ),
    true,
  );
  assert.ok(bucket.calls.length >= 2);
  assert.ok(bucket.maxRange <= 2 * 1024 * 1024);
  assert.equal(bucket.calls[0].onlyIf, undefined);
  assert.ok(
    bucket.calls
      .slice(1)
      .every((call) => call.onlyIf?.etagMatches === TEST_ETAG),
  );
});

test("supports regular FAT, miniFAT, BIFF8 Book streams, and CFBF v4", async () => {
  assert.equal(await isValidXlsBytes(makeCfb()), true);
  assert.equal(
    await isValidXlsBytes(
      makeCfb({ biff: makeBiff({ paddingBytes: 5000 }), useMini: false }),
    ),
    true,
  );
  assert.equal(await isValidXlsBytes(makeCfb({ workbookName: "Book" })), true);
  assert.equal(await isValidXlsBytes(makeCfb({ version: 4 })), true);

  const extendedDifat = makeCfb({
    biff: makeBiff({ paddingBytes: 8 * 1024 * 1024 }),
    useMini: false,
  });
  assert.ok(new DataView(extendedDifat.buffer).getUint32(44, true) > 109);
  assert.equal(await isValidXlsBytes(extendedDifat), true);
});

test("rejects lookalikes, truncation, corrupt CFBF metadata, and direct oversize", async () => {
  const real = new Uint8Array(
    await readFile(new URL("./fixtures/price.xls", import.meta.url)),
  );
  assert.equal(await isValidXlsBytes(CFBF_SIGNATURE), false);
  assert.equal(
    await isValidXlsBytes(
      concat([CFBF_SIGNATURE, new TextEncoder().encode("Workbook")]),
    ),
    false,
  );
  assert.equal(await isValidXlsBytes(real.subarray(0, real.length - 1)), false);

  const badVersion = new Uint8Array(real);
  new DataView(badVersion.buffer).setUint16(26, 2, true);
  assert.equal(await isValidXlsBytes(badVersion), false);

  const badFat = new Uint8Array(real);
  const firstFatSector = new DataView(badFat.buffer).getUint32(76, true);
  const fatOffset = (firstFatSector + 1) * 512;
  new DataView(badFat.buffer).setUint32(fatOffset + firstFatSector * 4, FREESECT, true);
  assert.equal(await isValidXlsBytes(badFat), false);

  const miniFatCycle = makeCfb();
  new DataView(miniFatCycle.buffer).setUint32((2 + 1) * 512, 0, true);
  assert.equal(await isValidXlsBytes(miniFatCycle), false);

  const regularFatCycle = makeCfb({
    biff: makeBiff({ paddingBytes: 5000 }),
    useMini: false,
  });
  new DataView(regularFatCycle.buffer).setUint32(512 + 2 * 4, 2, true);
  assert.equal(await isValidXlsBytes(regularFatCycle), false);

  const directoryCycle = makeCfb();
  new DataView(directoryCycle.buffer).setUint32(
    (1 + 1) * 512 + 128 + 68,
    1,
    true,
  );
  assert.equal(await isValidXlsBytes(directoryCycle), false);

  const nestedWorkbook = makeCfb({ storageName: "Data" });
  const nestedDirectoryOffset = (1 + 1) * 512;
  const nestedView = new DataView(nestedWorkbook.buffer);
  nestedView.setUint32(nestedDirectoryOffset + 76, 2, true);
  nestedView.setUint32(nestedDirectoryOffset + 128 + 72, FREESECT, true);
  nestedView.setUint32(nestedDirectoryOffset + 256 + 76, 1, true);
  assert.equal(await isValidXlsBytes(nestedWorkbook), false);

  const completeBiff = makeBiff();
  assert.equal(
    await isValidXlsBytes(
      makeCfb({ biff: completeBiff.subarray(0, completeBiff.length - 4) }),
    ),
    false,
  );
  const replacedSheetEof = new Uint8Array(completeBiff);
  new DataView(replacedSheetEof.buffer).setUint16(
    replacedSheetEof.length - 4,
    0x0203,
    true,
  );
  assert.equal(
    await isValidXlsBytes(makeCfb({ biff: replacedSheetEof })),
    false,
  );

  assert.equal(
    await isValidXlsBytes(new Uint8Array(MAX_XLS_BYTES + 1)),
    false,
  );
  assert.equal(MAX_XLS_OBJECT_BYTES, 1024 * 1024 * 1024);
});

test("rejects encrypted, macro, object-storage, and non-worksheet workbooks", async () => {
  assert.equal(
    await isValidXlsBytes(makeCfb({ biff: makeBiff({ filePass: true }) })),
    false,
  );
  assert.equal(
    await isValidXlsBytes(
      makeCfb({ biff: makeBiff({ objectProject: true }) }),
    ),
    false,
  );
  for (const storageName of ["VBA", "_VBA_PROJECT_CUR", "ObjectPool"]) {
    assert.equal(await isValidXlsBytes(makeCfb({ storageName })), false);
  }
  assert.equal(await isValidXlsBytes(makeCfb({ streamName: "Ctls" })), false);
  assert.equal(
    await isValidXlsBytes(makeCfb({ biff: makeBiff({ sheetType: 1 }) })),
    false,
  );
  assert.equal(
    await isValidXlsBytes(
      makeCfb({ biff: makeBiff({ worksheetType: 0x0020 }) }),
    ),
    false,
  );
});

test("rejects deterministic R2 mismatches and invalid object sizes", async () => {
  const workbook = makeCfb();
  await assert.rejects(
    () =>
      isValidXlsObject(
        mockBucket(workbook),
        "prices/current.xls",
        workbook.byteLength + 512,
      ),
    XlsObjectReadError,
  );

  let called = false;
  const neverReadBucket = {
    async get() {
      called = true;
      return null;
    },
  };
  assert.equal(
    await isValidXlsObject(
      neverReadBucket,
      "prices/current.xls",
      MAX_XLS_OBJECT_BYTES + 1,
    ),
    false,
  );
  assert.equal(called, false);
});

test("surfaces R2 request, stream, truncation, and ETag failures as retryable", async () => {
  const workbook = makeCfb({
    biff: makeBiff({ globalPaddingBytes: 3 * 1024 * 1024 }),
    useMini: false,
  });
  for (const options of [
    { throwCall: 0 },
    { bodyErrorCall: 0 },
    { truncateCall: 0 },
    { nullCall: 1 },
    { changedEtagCall: 1 },
  ]) {
    await assert.rejects(
      () =>
        isValidXlsObject(
          mockBucket(workbook, options),
          "prices/current.xls",
          workbook.byteLength,
        ),
      XlsObjectReadError,
    );
  }
});
