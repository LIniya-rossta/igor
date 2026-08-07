export const GITHUB_PAGES_ORIGIN = "https://liniya-rossta.github.io";

export function publicPriceHeaders(requestOrigin: string | null) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (requestOrigin === GITHUB_PAGES_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", GITHUB_PAGES_ORIGIN);
    headers.set("Vary", "Origin");
  }
  return headers;
}
