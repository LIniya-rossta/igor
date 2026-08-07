import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLocalTelegramApiReachable,
  isLocalTelegramApiBaseUrl,
  logOutCloudBot,
  normalizeTelegramApiBaseUrl,
  parseDevVars,
  requireLocalTelegramApiOrigin,
  waitForReady,
} from "../scripts/telegram-script-utils.mjs";

test("parses quoted local variables without evaluating their contents", () => {
  assert.deepEqual(
    parseDevVars(`
      # comment
      TELEGRAM_BOT_TOKEN="123456:secret_value"
      TELEGRAM_API_BASE_URL='http://127.0.0.1:8081'
      INVALID_LINE
    `),
    {
      TELEGRAM_BOT_TOKEN: "123456:secret_value",
      TELEGRAM_API_BASE_URL: "http://127.0.0.1:8081",
    },
  );
});

test("accepts only an explicit IPv4 loopback origin for Local Bot API", () => {
  assert.equal(
    normalizeTelegramApiBaseUrl(" http://127.0.0.1:8081/ "),
    "http://127.0.0.1:8081",
  );
  assert.equal(
    requireLocalTelegramApiOrigin("http://127.0.0.1:8081/"),
    "http://127.0.0.1:8081",
  );
  assert.equal(isLocalTelegramApiBaseUrl("http://127.0.0.1:8081"), true);

  for (const value of [
    "http://localhost:8081",
    "http://[::1]:8081",
    "https://127.0.0.1:8081",
    "http://127.0.0.1:8081/bot",
  ]) {
    assert.throws(() => requireLocalTelegramApiOrigin(value));
  }
});

test("waits for a transiently unavailable Local Bot API", async () => {
  let probes = 0;
  const sleeps = [];
  const result = await waitForReady({
    attempts: 4,
    intervalMs: 25,
    async probe() {
      probes += 1;
      if (probes < 3) throw new Error("not ready");
      return { username: "ready_bot" };
    },
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
    },
  });

  assert.deepEqual(result, { username: "ready_bot" });
  assert.equal(probes, 3);
  assert.deepEqual(sleeps, [25, 25]);
});

test("checks the local listener before allowing cloud logOut", async () => {
  const token = `123456:${"c".repeat(24)}`;
  const requests = [];
  await assertLocalTelegramApiReachable("http://127.0.0.1:8081", token, {
    async fetchImpl(url, init) {
      requests.push({ url, init });
      return Response.json({
        ok: true,
        result: { id: 123456, is_bot: true, username: "ready_bot" },
      });
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `http://127.0.0.1:8081/bot${token}/getMe`,
  );
  assert.equal(requests[0].init.method, "POST");

  await assert.rejects(
    () =>
      assertLocalTelegramApiReachable("http://127.0.0.1:8081", token, {
        async fetchImpl() {
          throw new Error("offline");
        },
      }),
    /logOut was not attempted/,
  );

  await assert.rejects(
    () =>
      assertLocalTelegramApiReachable("http://127.0.0.1:8081", token, {
        async fetchImpl() {
          return new Response("not telegram", { status: 200 });
        },
      }),
    /not Telegram Bot API/,
  );

  await assert.rejects(
    () =>
      assertLocalTelegramApiReachable("http://127.0.0.1:8081", token, {
        async fetchImpl() {
          return Response.json(
            { ok: false, description: "Unauthorized" },
            { status: 401 },
          );
        },
      }),
    /did not authenticate this bot/,
  );
});

test("cloud logOut never exposes the bot token in failures", async () => {
  const token = `123456:${"a".repeat(24)}`;
  await assert.rejects(
    () =>
      logOutCloudBot(token, {
        async fetchImpl() {
          throw new Error(`request leaked ${token}`);
        },
      }),
    (error) => !error.message.includes(token) && /not completed/.test(error.message),
  );
});

test("cloud logOut uses the official cloud endpoint once", async () => {
  const token = `123456:${"b".repeat(24)}`;
  const requests = [];
  await logOutCloudBot(token, {
    async fetchImpl(url, init) {
      requests.push({ url, init });
      return Response.json({ ok: true, result: true });
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://api.telegram.org/bot${token}/logOut`);
  assert.equal(requests[0].init.method, "POST");
});
