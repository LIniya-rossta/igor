import assert from "node:assert/strict";
import test from "node:test";
import {
  addAuthorizedChatId,
  parseAuthorizedChatIds,
} from "../lib/telegram-access.ts";

test("parses and deduplicates authorized Telegram chat ids", () => {
  assert.deepEqual(parseAuthorizedChatIds('["100", "100", "200", 300, ""]'), ["100", "200"]);
  assert.deepEqual(parseAuthorizedChatIds("not-json"), []);
  assert.deepEqual(parseAuthorizedChatIds(null), []);
});

test("adds a Telegram chat without removing existing access", () => {
  assert.equal(addAuthorizedChatId('["100"]', "200"), '["100","200"]');
  assert.equal(addAuthorizedChatId('["100","200"]', "200"), '["100","200"]');
});
