import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  excelContentDisposition,
  excelFallbackFilename,
  excelFileFormat,
  excelMimeType,
  isExcelFilename,
  safeExcelUploadFilename,
} from "../lib/excel-file.ts";
import {
  isValidXlsxBytes,
  isXlsxFilename,
  MAX_XLSX_BYTES,
} from "../lib/xlsx.ts";
import { publicPriceHeaders } from "../lib/public-api.ts";

function testCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const encoder = new TextEncoder();
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const [name, content = ""] of entries) {
    const nameBytes = encoder.encode(name);
    const dataBytes = encoder.encode(content);
    const crc32 = testCrc32(dataBytes);
    const local = new Uint8Array(30 + nameBytes.length + dataBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, crc32, true);
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
    centralView.setUint32(16, crc32, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
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

const linkedWorksheetEntries = [
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

let workerModule;

async function renderPage(pathname = "/", requestHeaders = {}) {
  if (!workerModule) {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
    workerModule = import(workerUrl.href);
  }
  const { default: worker } = await workerModule;

  return worker.fetch(
    new Request(new URL(pathname, "https://unb.example/"), {
      headers: {
        accept: "text/html",
        host: "unb.example",
        "x-forwarded-host": "unb.example",
        "x-forwarded-proto": "https",
        ...requestHeaders,
      },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the UnB price landing page and social metadata", async () => {
  const response = await renderPage();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>UnB computers — компьютеры и комплектующие<\/title>/i);
  assert.match(html, /Технологии/);
  assert.match(html, /Скачать актуальный прайс/);
  assert.match(html, /\/api\/price\/download/);
  assert.match(html, /\/api\/price\/download/);
  assert.match(html, /data-availability-card/);
  assert.match(html, /https:\/\/unb\.example\/og-unb\.png/);
  assert.match(html, /Поддержка XLS и XLSX/);
  assert.match(html, /https:\/\/t\.me\/unb_computers/);
  assert.match(html, /Написать в Telegram/);
  assert.match(html, /<meta name="color-scheme" content="only light"\s*\/?>/i);
  assert.match(html, /<meta name="darkreader-lock"\s*\/?>/i);
  assert.match(html, /<meta name="theme-color" content="#f3f0e8"\s*\/?>/i);
  assert.doesNotMatch(html, /WhatsApp: \+996 555 342 425/);
});

test("serves a GitHub Pages frontend backed by the public price API", async () => {
  const html = await readFile(
    new URL("../docs/index.html", import.meta.url),
    "utf8",
  );
  const script = await readFile(
    new URL("../docs/app.js", import.meta.url),
    "utf8",
  );
  const rootHtml = await readFile(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  const githubPagesDownload = await readFile(
    new URL("../api/price/download/index.html", import.meta.url),
    "utf8",
  );
  const docsDownload = await readFile(
    new URL("../docs/api/price/download/index.html", import.meta.url),
    "utf8",
  );
  const staticStyles = await readFile(
    new URL("../docs/styles.css", import.meta.url),
    "utf8",
  );
  const appStyles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );

  assert.match(html, /<title>UnB computers — компьютеры и комплектующие<\/title>/i);
  assert.match(html, /data-price-download/);
  assert.match(html, /\.\/styles\.css/);
  assert.match(html, /https:\/\/unb-computers\.up\.railway\.app\/api\/price\/download/);
  assert.match(html, /data-availability-card/);
  assert.match(html, /https:\/\/t\.me\/unb_computers/);
  assert.doesNotMatch(html, /WhatsApp: \+996 555 342 425/);
  assert.match(rootHtml, /\.\/docs\/styles\.css/);
  assert.match(rootHtml, /\.\/docs\/app\.js/);
  assert.match(rootHtml, /https:\/\/unb-computers\.up\.railway\.app\/api\/price\/download/);
  assert.match(rootHtml, /data-availability-card/);
  assert.match(
    githubPagesDownload,
    /https:\/\/unb-computers\.up\.railway\.app\/api\/price\/download/,
  );
  assert.match(
    docsDownload,
    /https:\/\/unb-computers\.up\.railway\.app\/api\/price\/download/,
  );
  assert.match(rootHtml, /https:\/\/t\.me\/unb_computers/);
  assert.doesNotMatch(rootHtml, /WhatsApp: \+996 555 342 425/);
  assert.match(rootHtml, /<meta name="color-scheme" content="only light"\s*\/?>/i);
  assert.match(rootHtml, /<meta name="darkreader-lock"\s*\/?>/i);
  assert.match(rootHtml, /<meta name="theme-color" content="#f3f0e8"\s*\/?>/i);
  assert.match(script, /unb-computers\.up\.railway\.app/);
  assert.match(script, /\/api\/price\/meta/);
  assert.match(script, /availability-card-pinned/);
  assert.match(staticStyles, /@media \(max-width: 640px\)/);
  assert.match(staticStyles, /@media \(max-width: 380px\)/);
  assert.match(staticStyles, /color-scheme: only light/);
  assert.match(staticStyles, /\.header-action span \{ width: 44px; height: 44px;/);
  assert.match(staticStyles, /\.price-window \{ max-width: 100%; min-width: 0;/);
  assert.match(staticStyles, /\.contact-button \{ width: 100%; min-height: 64px;/);
  assert.equal(
    appStyles.replace(/^@import "tailwindcss";\s*/, "").trim(),
    staticStyles.trim(),
  );

  const allowed = publicPriceHeaders("https://liniya-rossta.github.io");
  assert.equal(
    allowed.get("access-control-allow-origin"),
    "https://liniya-rossta.github.io",
  );

  const denied = publicPriceHeaders("https://example.com");
  assert.equal(denied.get("access-control-allow-origin"), null);
});

test("renders a secure uploader for XLS and XLSX", async () => {
  const response = await renderPage("/price-upload");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /UNB PRICE MANAGER \/ XLS \+ XLSX/);
  assert.match(html, /\.xls,\.xlsx,application\/vnd\.ms-excel/);
  assert.match(html, /Перетащите XLS или XLSX сюда/);
});

test("accepts a real XLSX and rejects lookalike files", async () => {
  const workbook = new Uint8Array(
    await readFile(new URL("../public/price.xlsx", import.meta.url)),
  );

  assert.equal(await isValidXlsxBytes(workbook), true);
  assert.equal(await isValidXlsxBytes(storedZip(linkedWorksheetEntries)), true);
  assert.equal(
    await isValidXlsxBytes(
      storedZip(
        linkedWorksheetEntries.filter(
          ([name]) => name !== "xl/_rels/workbook.xml.rels",
        ),
      ),
    ),
    false,
  );
  assert.equal(
    await isValidXlsxBytes(
      storedZip(
        linkedWorksheetEntries.filter(
          ([name]) => name !== "xl/worksheets/sheet1.xml",
        ),
      ),
    ),
    false,
  );
  assert.equal(await isValidXlsxBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), false);
  assert.equal(
    await isValidXlsxBytes(new TextEncoder().encode("PK\u0003\u0004xl/workbook.xml")),
    false,
  );
  assert.equal(await isValidXlsxBytes(workbook.subarray(0, workbook.length - 12)), false);
  assert.equal(
    await isValidXlsxBytes(
      storedZip([
        ["[Content_Types].xml"],
        ["_rels/.rels"],
        ["xl/workbook.xml"],
      ]),
    ),
    false,
  );
  assert.equal(
    await isValidXlsxBytes(
      storedZip([
        [
          "[Content_Types].xml",
          '<Types><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml">',
        ],
        [
          "_rels/.rels",
          '<Relationships><Relationship Type="x/relationships/officeDocument" Target="/xl/workbook.xml">',
        ],
        [
          "xl/workbook.xml",
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet>',
        ],
      ]),
    ),
    false,
  );
  assert.equal(isXlsxFilename("PRICE.XLSX"), true);
  assert.equal(isXlsxFilename("price.xls"), false);
  assert.equal(MAX_XLSX_BYTES, 20 * 1024 * 1024);
});

test("recognizes safe Excel filenames and format-specific MIME types", () => {
  assert.equal(isExcelFilename("PRICE.XLS"), true);
  assert.equal(isExcelFilename("PRICE.XLSX"), true);
  assert.equal(isExcelFilename("price.xlsm"), false);
  assert.equal(isExcelFilename("price.xls.exe"), false);
  assert.equal(excelFileFormat("Прайс.XLS"), "xls");
  assert.equal(excelFileFormat("Прайс.xlsx"), "xlsx");
  assert.equal(excelMimeType("Прайс.xls"), "application/vnd.ms-excel");
  assert.equal(
    excelMimeType("Прайс.xlsx"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(excelFallbackFilename("Прайс.xls"), "UnB-price.xls");
  assert.equal(excelFallbackFilename("Прайс.xlsx"), "UnB-price.xlsx");
  assert.equal(
    excelContentDisposition("Прайс август.xls"),
    "attachment; filename=\"UnB-price.xls\"; filename*=UTF-8''%D0%9F%D1%80%D0%B0%D0%B9%D1%81%20%D0%B0%D0%B2%D0%B3%D1%83%D1%81%D1%82.xls",
  );
  assert.equal(safeExcelUploadFilename(" Прайс.XLS "), "Прайс.XLS");
  assert.equal(safeExcelUploadFilename("../price.xls"), null);
  assert.equal(safeExcelUploadFilename("price.xls\\evil"), null);
  assert.equal(safeExcelUploadFilename("price.xls\n"), "price.xls");
});
