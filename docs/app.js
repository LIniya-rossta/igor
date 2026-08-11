const API_ORIGIN = "https://unb-computers-kg.zilolatashievaz.chatgpt.site";
const META_URL = `${API_ORIGIN}/api/price/meta`;
const NEW_ITEMS_URL = `${API_ORIGIN}/api/price/new-items`;
const DOWNLOAD_URL = `${API_ORIGIN}/api/price/download`;
const REFRESH_INTERVAL_MS = 60_000;

function setText(selector, value) {
  document.querySelectorAll(selector).forEach((element) => {
    element.textContent = value;
  });
}

function formatItemsCount(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} позиция`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} позиции`;
  return `${count} позиций`;
}

function formatCountValue(value, separator) {
  const rounded = Math.round(value);
  return separator ? String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, separator) : String(rounded);
}

function animateItemsCount(count) {
  document.querySelectorAll("[data-new-items-count]").forEach((element) => {
    const previous = Number(element.dataset.countValue || 0);
    if (previous === count && element.dataset.countReady === "true") return;

    element.dataset.countValue = String(count);
    element.dataset.countReady = "true";
    const noun = count === 0 ? "" : formatItemsCount(count).replace(/^\d+\s*/, "");
    const startedAt = performance.now();
    const duration = 1000;
    const tick = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = previous + (count - previous) * eased;
      element.textContent = count === 0
        ? "Пока пусто"
        : `${formatCountValue(value, ",")} ${noun}`;
      if (progress < 1) window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });
}

function enableStaticAnimatedList(list) {
  if (list.dataset.keyboardReady === "true") return;
  list.dataset.keyboardReady = "true";
  list.addEventListener("keydown", (event) => {
    const items = [...list.querySelectorAll("[data-animated-index]")];
    if (!items.length) return;
    const active = items.findIndex((item) => item.classList.contains("is-selected"));
    const current = active < 0 ? 0 : active;
    let next = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = Math.min(items.length - 1, current + 1);
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = Math.max(0, current - 1);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next === null) return;
    event.preventDefault();
    items.forEach((item) => item.classList.remove("is-selected"));
    const selected = items[next];
    selected.classList.add("is-selected");
    selected.scrollIntoView({ behavior: "smooth", block: "nearest" });
    selected.focus({ preventScroll: true });
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
  enableStaticAnimatedList(list);

  const items = Array.isArray(payload.items)
    ? payload.items.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];

  animateItemsCount(items.length);

  const rows = items.map((item, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "animated-list-item";
      row.dataset.animatedIndex = String(index);
      row.style.animationDelay = `${Math.min(index, 12) * 45}ms`;
      const mark = document.createElement("span");
      mark.className = "animated-list-mark";
      mark.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.textContent = item.trim();
      row.append(mark, name);
      row.addEventListener("click", () => {
        list.querySelectorAll(".is-selected").forEach((selected) => selected.classList.remove("is-selected"));
        row.classList.add("is-selected");
      });
      return row;
  });
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "new-items-empty";
    empty.textContent = "Новые товары появятся после следующего обновления прайса.";
    rows.push(empty);
  }
  list.replaceChildren(...rows);
  section.hidden = false;
}

async function refreshNewItems() {
  try {
    const response = await fetch(NEW_ITEMS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("New items are unavailable");
    applyNewItems(await response.json());
  } catch {
    // Keep the server-rendered empty state if the API is unavailable.
  }
}

document.querySelectorAll("[data-price-download]").forEach((link) => {
  link.href = DOWNLOAD_URL;
});

void refreshPriceMeta();
void refreshNewItems();
window.setInterval(refreshPriceMeta, REFRESH_INTERVAL_MS);
window.setInterval(refreshNewItems, REFRESH_INTERVAL_MS);
