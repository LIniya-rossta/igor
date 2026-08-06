import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { excelFileFormat, excelMimeType } from "../lib/excel-file.ts";
import { isValidXlsBytes } from "../lib/xls.ts";
import { isValidXlsxBytes } from "../lib/xlsx.ts";

test("keeps XLS and XLSX content matched to their filename format", async () => {
  const [xls, xlsx] = await Promise.all([
    readFile(new URL("./fixtures/price.xls", import.meta.url)),
    readFile(new URL("../public/price.xlsx", import.meta.url)),
  ]);

  assert.equal(excelFileFormat("price.xls"), "xls");
  assert.equal(excelFileFormat("price.xlsx"), "xlsx");
  assert.equal(excelMimeType("price.xls"), "application/vnd.ms-excel");
  assert.equal(
    excelMimeType("price.xlsx"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );

  assert.equal(await isValidXlsBytes(new Uint8Array(xls)), true);
  assert.equal(await isValidXlsxBytes(new Uint8Array(xlsx)), true);
  assert.equal(await isValidXlsBytes(new Uint8Array(xlsx)), false);
  assert.equal(await isValidXlsxBytes(new Uint8Array(xls)), false);
});
