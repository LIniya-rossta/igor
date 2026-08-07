import {
  assertLocalTelegramApiReachable,
  logOutCloudBot,
  readDevVars,
  requireLocalTelegramApiOrigin,
} from "./telegram-script-utils.mjs";

const projectRoot = new URL("../", import.meta.url);
const devVars = await readDevVars(projectRoot);
const botToken = devVars.TELEGRAM_BOT_TOKEN || "";

const localApiOrigin = requireLocalTelegramApiOrigin(
  devVars.TELEGRAM_API_BASE_URL || "",
);
await assertLocalTelegramApiReachable(localApiOrigin, botToken);
await logOutCloudBot(botToken);

process.stdout.write(
  "Cloud Bot API logOut completed. Start the local polling process now.\n",
);
