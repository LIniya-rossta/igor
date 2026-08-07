import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import {
  readDevVars,
  requireLocalTelegramApiOrigin,
} from "./telegram-script-utils.mjs";

const projectRoot = new URL("../", import.meta.url);
const projectRootPath = fileURLToPath(projectRoot);
const devVars = await readDevVars(projectRoot);
const apiId = process.env.TELEGRAM_API_ID || devVars.TELEGRAM_API_ID || "";
const apiHash = process.env.TELEGRAM_API_HASH || devVars.TELEGRAM_API_HASH || "";
const configuredBinary =
  process.env.TELEGRAM_LOCAL_API_BINARY ||
  devVars.TELEGRAM_LOCAL_API_BINARY ||
  ".telegram-bot-api/bin/telegram-bot-api";
const binary = isAbsolute(configuredBinary)
  ? configuredBinary
  : resolve(projectRootPath, configuredBinary);
const filesRoot =
  process.env.TELEGRAM_LOCAL_FILES_ROOT ||
  devVars.TELEGRAM_LOCAL_FILES_ROOT ||
  join(projectRootPath, ".telegram-bot-api", "data");
const configuredBaseUrl =
  process.env.TELEGRAM_API_BASE_URL ||
  devVars.TELEGRAM_API_BASE_URL ||
  "http://127.0.0.1:8081";

if (!/^\d{4,12}$/.test(apiId) || !/^[a-fA-F0-9]{32}$/.test(apiHash)) {
  throw new Error(
    "Add TELEGRAM_API_ID and TELEGRAM_API_HASH from my.telegram.org to .dev.vars",
  );
}
if (!filesRoot || !isAbsolute(filesRoot)) {
  throw new Error("TELEGRAM_LOCAL_FILES_ROOT must be an absolute directory");
}
try {
  await access(binary, fsConstants.X_OK);
} catch {
  throw new Error(
    "Telegram Local Bot API binary is missing or not executable; build .telegram-bot-api/bin/telegram-bot-api or set TELEGRAM_LOCAL_API_BINARY",
  );
}

const baseUrl = new URL(requireLocalTelegramApiOrigin(configuredBaseUrl));

const httpPort = baseUrl.port || "80";
const temporaryRoot = join(filesRoot, "temp");
await mkdir(filesRoot, { recursive: true, mode: 0o700 });
await chmod(filesRoot, 0o700);
await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
await chmod(temporaryRoot, 0o700);

const child = spawn(
  binary,
  [
    "--local",
    "--http-ip-address=127.0.0.1",
    `--http-port=${httpPort}`,
    `--dir=${filesRoot}`,
    `--temp-dir=${temporaryRoot}`,
  ],
  {
    cwd: filesRoot,
    env: {
      ...process.env,
      TELEGRAM_API_ID: apiId,
      TELEGRAM_API_HASH: apiHash,
    },
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  process.stderr.write(`Could not start Telegram Local Bot API: ${error.message}\n`);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("exit", (code, signal) => {
  if (signal) process.stdout.write(`Telegram Local Bot API stopped by ${signal}.\n`);
  process.exitCode = code ?? (signal ? 0 : 1);
});
