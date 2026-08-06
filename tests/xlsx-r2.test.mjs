import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isValidXlsxBytes,
  isValidXlsxObject,
  MAX_XLSX_BYTES,
  XlsxObjectReadError,
} from "../lib/xlsx.ts";

const encoder = new TextEncoder();
const TEST_ETAG = "test-etag";

const requiredEntries = [
  [
    "[Content_Types].xml",
    '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  ],
  [
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  ],
  [
    "xl/workbook.xml",
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Price" r:id="rId1"/></sheets></workbook>',
  ],
  [
    "xl/_rels/workbook.xml.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  ],
  [
    "xl/worksheets/sheet1.xml",
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
  ],
];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function asBytes(value) {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function storedZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const [name, content = ""] of entries) {
    const nameBytes = encoder.encode(name);
    const dataBytes = asBytes(content);
    const entryCrc32 = crc32(dataBytes);
    const local = new Uint8Array(30 + nameBytes.length + dataBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, entryCrc32, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(dataBytes, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, entryCrc32, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);

    localRecords.push(local);
    centralRecords.push(central);
    localOffset += local.length;
  }

  const centralSize = centralRecords.reduce(
    (total, record) => total + record.length,
    0,
  );
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, localOffset, true);

  const archive = new Uint8Array(localOffset + centralSize + eocd.length);
  let offset = 0;
  for (const record of [...localRecords, ...centralRecords, eocd]) {
    archive.set(record, offset);
    offset += record.length;
  }
  return archive;
}

function mockBucket(
  bytes,
  { nullCall = -1, truncateRangesOver = Number.POSITIVE_INFINITY } = {},
) {
  const calls = [];
  const bucket = {
    calls,
    maxStreamChunk: 0,
    async get(key, options = {}) {
      assert.equal(key, "prices/current.xlsx");
      const callIndex = calls.length;
      calls.push(options);
      if (callIndex === nullCall) return null;

      const range = options.range;
      assert.ok(range, "validator must always use an R2 range read");
      let offset;
      let length;
      if ("suffix" in range) {
        length = Math.min(range.suffix, bytes.length);
        offset = bytes.length - length;
      } else {
        offset = range.offset ?? 0;
        length = range.length ?? bytes.length - offset;
      }
      if (
        offset < 0 ||
        length < 0 ||
        offset + length > bytes.length ||
        (options.onlyIf?.etagMatches &&
          options.onlyIf.etagMatches !== TEST_ETAG)
      ) {
        return null;
      }

      const returnedLength =
        length > truncateRangesOver ? Math.max(0, length - 1) : length;
      let streamed = 0;
      return {
        size: bytes.length,
        etag: TEST_ETAG,
        bodyUsed: false,
        body: new ReadableStream({
          pull(controller) {
            if (streamed === returnedLength) {
              controller.close();
              return;
            }
            const chunkLength = Math.min(
              64 * 1024,
              returnedLength - streamed,
            );
            const chunk = bytes.slice(
              offset + streamed,
              offset + streamed + chunkLength,
            );
            bucket.maxStreamChunk = Math.max(
              bucket.maxStreamChunk,
              chunk.byteLength,
            );
            streamed += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      };
    },
  };
  return bucket;
}

function clone(bytes) {
  return new Uint8Array(bytes);
}

function eocdOffset(bytes) {
  return bytes.length - 22;
}

function centralOffset(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    eocdOffset(bytes) + 16,
    true,
  );
}

function withWorksheet(content) {
  return requiredEntries.map(([name, currentContent]) => [
    name,
    name === "xl/worksheets/sheet1.xml" ? content : currentContent,
  ]);
}

function storedEntryData(bytes, wantedName) {
  const decoder = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (name === wantedName) return { dataStart, compressedSize };
    offset = dataStart + compressedSize;
  }
  throw new Error(`Missing stored ZIP entry: ${wantedName}`);
}

test("validates an XLSX in R2 using bounded range reads", async () => {
  const workbook = new Uint8Array(
    await readFile(new URL("../public/price.xlsx", import.meta.url)),
  );
  const bucket = mockBucket(workbook);

  assert.equal(
    await isValidXlsxObject(bucket, "prices/current.xlsx", workbook.length),
    true,
  );
  assert.ok(bucket.calls.length >= 12);
  assert.deepEqual(bucket.calls[0].range, {
    suffix: Math.min(workbook.length, 65_557),
  });
  assert.ok(bucket.calls.every((call) => call.range));
  assert.ok(
    bucket.calls
      .slice(1)
      .every((call) => call.onlyIf?.etagMatches === TEST_ETAG),
  );
});

test("accepts an object over Telegram's 20 MiB limit without reading it all", async () => {
  const padding = new Uint8Array(MAX_XLSX_BYTES + 1024);
  const workbook = storedZip([
    ...requiredEntries,
    ["xl/media/padding.bin", padding],
  ]);
  const bucket = mockBucket(workbook);

  assert.ok(workbook.length > MAX_XLSX_BYTES);
  assert.equal(
    await isValidXlsxObject(bucket, "prices/current.xlsx", workbook.length),
    true,
  );
  assert.deepEqual(bucket.calls[0].range, { suffix: 65_557 });

  const requestedBytes = bucket.calls.reduce((total, call) => {
    const range = call.range;
    return total + ("suffix" in range ? range.suffix : range.length);
  }, 0);
  assert.ok(requestedBytes < 100_000);
  assert.ok(requestedBytes < workbook.length / 100);
});

test("streams linked worksheets over 4 MiB and rejects corruption or truncation", async () => {
  const largeWorksheet =
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    " ".repeat(4 * 1024 * 1024 + 1024) +
    "</sheetData></worksheet>";
  const workbook = storedZip(withWorksheet(largeWorksheet));
  const worksheetEntry = storedEntryData(
    workbook,
    "xl/worksheets/sheet1.xml",
  );
  assert.ok(worksheetEntry.compressedSize > 4 * 1024 * 1024);
  assert.equal(await isValidXlsxBytes(workbook), true);

  const bucket = mockBucket(workbook);
  assert.equal(
    await isValidXlsxObject(bucket, "prices/current.xlsx", workbook.length),
    true,
  );
  assert.ok(
    bucket.calls.some(
      (call) => call.range?.length === worksheetEntry.compressedSize,
    ),
  );
  assert.ok(bucket.maxStreamChunk <= 64 * 1024);
  assert.ok(
    bucket.calls.every(
      (call) =>
        "suffix" in call.range || call.range.length < workbook.length,
    ),
  );

  const corrupted = clone(workbook);
  corrupted[
    worksheetEntry.dataStart + worksheetEntry.compressedSize - 32
  ] ^= 0x01;
  assert.equal(await isValidXlsxBytes(corrupted), false);
  assert.equal(
    await isValidXlsxObject(
      mockBucket(corrupted),
      "prices/current.xlsx",
      corrupted.length,
    ),
    false,
  );

  assert.equal(
    await isValidXlsxBytes(workbook.subarray(0, workbook.length - 1)),
    false,
  );

  await assert.rejects(
    () =>
      isValidXlsxObject(
        mockBucket(workbook, { truncateRangesOver: 4 * 1024 * 1024 }),
        "prices/current.xlsx",
        workbook.length,
      ),
    XlsxObjectReadError,
  );
});

test("rejects XLSX objects without a safe linked worksheet", async () => {
  const cases = [
    requiredEntries.filter(
      ([name]) => name !== "xl/_rels/workbook.xml.rels",
    ),
    requiredEntries.filter(
      ([name]) => name !== "xl/worksheets/sheet1.xml",
    ),
    requiredEntries.map(([name, content]) => [
      name,
      name === "xl/workbook.xml"
        ? content.replace(' r:id="rId1"', "")
        : content,
    ]),
    requiredEntries.map(([name, content]) => [
      name,
      name === "xl/_rels/workbook.xml.rels"
        ? content.replace(
            'Target="worksheets/sheet1.xml"',
            'Target="../worksheets/sheet1.xml"',
          )
        : content,
    ]),
    requiredEntries.map(([name, content]) => [
      name,
      name === "xl/_rels/workbook.xml.rels"
        ? content.replace(
            'Target="worksheets/sheet1.xml"',
            'Target="https://example.com/sheet1.xml" TargetMode="External"',
          )
        : content,
    ]),
    requiredEntries.map(([name, content]) => [
      name,
      name === "xl/worksheets/sheet1.xml"
        ? content.replace("<sheetData/>", "<cols/>")
        : content,
    ]),
  ];

  for (const entries of cases) {
    const workbook = storedZip(entries);
    assert.equal(
      await isValidXlsxObject(
        mockBucket(workbook),
        "prices/current.xlsx",
        workbook.length,
      ),
      false,
    );
  }
});

test("rejects corrupt CRC, encryption, multi-disk and ZIP64 markers", async () => {
  const valid = storedZip(requiredEntries);
  const central = centralOffset(valid);
  const eocd = eocdOffset(valid);

  const badCrc = clone(valid);
  const badCrcView = new DataView(badCrc.buffer);
  badCrcView.setUint32(14, 0, true);
  badCrcView.setUint32(central + 16, 0, true);
  assert.equal(
    await isValidXlsxObject(
      mockBucket(badCrc),
      "prices/current.xlsx",
      badCrc.length,
    ),
    false,
  );

  const encrypted = clone(valid);
  const encryptedView = new DataView(encrypted.buffer);
  encryptedView.setUint16(6, 1, true);
  encryptedView.setUint16(central + 8, 1, true);
  assert.equal(
    await isValidXlsxObject(
      mockBucket(encrypted),
      "prices/current.xlsx",
      encrypted.length,
    ),
    false,
  );

  const multiDisk = clone(valid);
  new DataView(multiDisk.buffer).setUint16(eocd + 4, 1, true);
  assert.equal(
    await isValidXlsxObject(
      mockBucket(multiDisk),
      "prices/current.xlsx",
      multiDisk.length,
    ),
    false,
  );

  const zip64 = clone(valid);
  new DataView(zip64.buffer).setUint32(central + 24, 0xffffffff, true);
  assert.equal(
    await isValidXlsxObject(
      mockBucket(zip64),
      "prices/current.xlsx",
      zip64.length,
    ),
    false,
  );
});

test("surfaces unavailable R2 ranges while rejecting invalid object sizes", async () => {
  const valid = storedZip(requiredEntries);
  await assert.rejects(
    () => isValidXlsxObject(
      mockBucket(valid, { nullCall: 0 }),
      "prices/current.xlsx",
      valid.length,
    ),
    XlsxObjectReadError,
  );

  let called = false;
  const neverReadBucket = {
    async get() {
      called = true;
      return null;
    },
  };
  assert.equal(
    await isValidXlsxObject(
      neverReadBucket,
      "prices/current.xlsx",
      1024 * 1024 * 1024 + 1,
    ),
    false,
  );
  assert.equal(called, false);

  const oversizedWorkbook = storedZip([
    requiredEntries[0],
    requiredEntries[1],
    ["xl/workbook.xml", new Uint8Array(4 * 1024 * 1024 + 1)],
  ]);
  assert.equal(
    await isValidXlsxObject(
      mockBucket(oversizedWorkbook),
      "prices/current.xlsx",
      oversizedWorkbook.length,
    ),
    false,
  );
});

test("surfaces R2 request and body stream failures as retryable read errors", async () => {
  const valid = storedZip(requiredEntries);
  const requestFailureBucket = {
    async get() {
      throw new Error("temporary R2 failure");
    },
  };
  await assert.rejects(
    () =>
      isValidXlsxObject(
        requestFailureBucket,
        "prices/current.xlsx",
        valid.length,
      ),
    XlsxObjectReadError,
  );

  const bodyFailureBucket = {
    async get() {
      return {
        size: valid.length,
        etag: TEST_ETAG,
        bodyUsed: false,
        body: new ReadableStream({
          start(controller) {
            controller.error(new Error("temporary stream failure"));
          },
        }),
      };
    },
  };
  await assert.rejects(
    () =>
      isValidXlsxObject(
        bodyFailureBucket,
        "prices/current.xlsx",
        valid.length,
      ),
    XlsxObjectReadError,
  );
});
