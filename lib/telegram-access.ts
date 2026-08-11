export const TELEGRAM_ALLOWED_CHATS_SETTING = "telegram_allowed_chat_ids";

export function parseAuthorizedChatIds(value: string | null | undefined): string[] {
  if (!value) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return [...new Set(
      parsed.filter((chatId): chatId is string => typeof chatId === "string" && chatId.length > 0),
    )];
  } catch {
    return [];
  }
}

export function addAuthorizedChatId(
  value: string | null | undefined,
  chatId: string,
): string {
  const ids = parseAuthorizedChatIds(value);
  if (!ids.includes(chatId)) ids.push(chatId);
  return JSON.stringify(ids);
}
