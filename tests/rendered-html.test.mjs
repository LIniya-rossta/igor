import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isValidXlsxBytes,
  isXlsxFilename,
  MAX_XLSX_BYTES,
} from "../lib/xlsx.ts";

function emptyStoredZip(names) {
  const encoder = new TextEncoder();
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const name of names) {
    const nameBytes = encoder.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);

    localRecords.push(local);
    centralRecords.push(central);
    localOffset += local.length;
  }

  const centralSize = centralRecords.reduce((size, record) => size + record.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, names.length, true);
  eocdView.setUint16(10, names.length, true);
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

async function renderHome() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://unb.example/", {
      headers: {
        accept: "text/html",
        host: "unb.example",
        "x-forwarded-host": "unb.example",
        "x-forwarded-proto": "https",
      },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the UnB price landing page and social metadata", async () => {
  const response = await renderHome();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>UnB computers — компьютеры и комплектующие<\/title>/i);
  assert.match(html, /Технологии/);
  assert.match(html, /Скачать актуальный прайс/);
  assert.match(html, /\/api\/price\/download/);
  assert.match(html, /https:\/\/unb\.example\/og-unb\.png/);
});

test("accepts a real XLSX and rejects lookalike files", async () => {
  const workbook = new Uint8Array(
    await readFile(new URL("../public/price.xlsx", import.meta.url)),
  );

  assert.equal(await isValidXlsxBytes(workbook), true);
  assert.equal(await isValidXlsxBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), false);
  assert.equal(
    await isValidXlsxBytes(new TextEncoder().encode("PK\u0003\u0004xl/workbook.xml")),
    false,
  );
  assert.equal(await isValidXlsxBytes(workbook.subarray(0, workbook.length - 12)), false);
  assert.equal(
    await isValidXlsxBytes(
      emptyStoredZip(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"]),
    ),
    false,
  );
  assert.equal(isXlsxFilename("PRICE.XLSX"), true);
  assert.equal(isXlsxFilename("price.xls"), false);
  assert.equal(MAX_XLSX_BYTES, 20 * 1024 * 1024);
});
