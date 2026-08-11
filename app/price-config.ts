export const priceInfo = {
  updated: "6 августа 2026",
  version: "06.08.26",
  format: "XLS / XLSX",
  updateFrequency: "ежедневно",
  // Keep this relative so the server-rendered site always downloads from the
  // same deployment that serves the current price file (Railway in production).
  downloadUrl: "/api/price/download",
} as const;
