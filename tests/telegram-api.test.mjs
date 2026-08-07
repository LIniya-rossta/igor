import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TELEGRAM_API_BASE_URL,
  normalizeTelegramApiBaseUrl,
  telegramMethodUrl,
} from "../lib/telegram-api.ts";

test("normalizes public and local Telegram Bot API roots", () => {
  assert.equal(normalizeTelegramApiBaseUrl(), DEFAULT_TELEGRAM_API_BASE_URL);
  assert.equal(
    normalizeTelegramApiBaseUrl(" http://127.0.0.1:8081/ "),
    "http://127.0.0.1:8081",
  );
  assert.equal(
    telegramMethodUrl(
      {
        TELEGRAM_BOT_TOKEN: "123456:test-token",
        TELEGRAM_API_BASE_URL: "http://localhost:8081/",
      },
      "sendMessage",
    ),
    "http://localhost:8081/bot123456:test-token/sendMessage",
  );
});

test("rejects unsafe Telegram API roots and method names", () => {
  for (const value of [
    "file:///tmp/telegram",
    "http://user:password@localhost:8081",
    "http://localhost:8081?token=secret",
    "http://localhost:8081#fragment",
  ]) {
    assert.throws(() => normalizeTelegramApiBaseUrl(value));
  }

  assert.throws(() =>
    telegramMethodUrl({ TELEGRAM_BOT_TOKEN: "token" }, "../getFile"),
  );
  assert.throws(() => telegramMethodUrl({}, "getMe"));
});
