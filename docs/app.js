const API_ORIGIN = "https://unb-computers.up.railway.app";
const META_URL = `${API_ORIGIN}/api/price/meta`;
const NEW_ITEMS_URL = `${API_ORIGIN}/api/price/new-items`;
const DOWNLOAD_URL = `${API_ORIGIN}/api/price/download`;
const REFRESH_INTERVAL_MS = 60_000;

function setText(selector, value) {
  document.querySelectorAll(selector).forEach((element) => {
    element.textContent = value;
  });
}

function applyMeta(meta) {
  const filename = typeof meta.filename === "string" ? meta.filename : "UnB-price.xlsx";
  const updated = typeof meta.updated === "string" ? meta.updated : "6 августа 2026";
  const version = typeof meta.version === "string" ? meta.version : "06.08.26";
  const format = filename.toLowerCase().endsWith(".xls") ? "XLS" : "XLSX";

  setText("[data-price-date]", updated);
  setText("[data-price-filename]", filename);
  setText("[data-price-format]", format);
  setText("[data-price-file-line]", `Версия ${version} · обновлено ${updated}`);
}

async function refreshPriceMeta() {
  try {
    const response = await fetch(META_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("Price metadata is unavailable");
    applyMeta(await response.json());
  } catch {
    // The server-rendered fallback remains visible while the API is unavailable.
  }
}

function applyNewItems(payload) {
  const section = document.querySelector("#new-items");
  const list = document.querySelector("[data-new-items-list]");
  if (!section || !list) return;

  const items = Array.isArray(payload.items)
    ? payload.items.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];

  list.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("div");
      row.className = "new-item";
      const mark = document.createElement("span");
      mark.className = "new-item-mark";
      mark.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.textContent = item.trim();
      row.append(mark, name);
      return row;
    }),
  );
  section.hidden = items.length === 0;
}

async function refreshNewItems() {
  try {
    const response = await fetch(NEW_ITEMS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("New items are unavailable");
    applyNewItems(await response.json());
  } catch {
    // Keep the section hidden if the API is unavailable or has no migration yet.
  }
}

document.querySelectorAll("[data-price-download]").forEach((link) => {
  link.href = DOWNLOAD_URL;
});

void refreshPriceMeta();
void refreshNewItems();
window.setInterval(refreshPriceMeta, REFRESH_INTERVAL_MS);
window.setInterval(refreshNewItems, REFRESH_INTERVAL_MS);
