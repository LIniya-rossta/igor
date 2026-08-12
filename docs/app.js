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

function renderStaticLineSidebar(nav, items) {
  nav.style.setProperty("--accent-color", "#e5484d");
  nav.style.setProperty("--text-color", "#0e1f2e");
  nav.style.setProperty("--marker-color", "#aab1b5");
  nav.style.setProperty("--marker-length", "52px");
  nav.style.setProperty("--marker-gap", "12px");
  nav.style.setProperty("--tick-scale", "0.42");
  nav.style.setProperty("--max-shift", "18px");
  nav.style.setProperty("--item-gap", "14px");
  nav.style.setProperty("--font-size", "1rem");

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "new-items-empty";
    empty.textContent = "Новые товары появятся после следующего обновления прайса.";
    nav.replaceChildren(empty);
    return;
  }

  const list = document.createElement("ul");
  list.className = "line-sidebar__list";
  list.setAttribute("aria-label", "Новые товары");
  const rows = items.map((item, index) => {
    const row = document.createElement("li");
    row.className = "line-sidebar__item";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.setAttribute("aria-label", `Новинка ${index + 1}: ${item.trim()}`);
    const marker = document.createElement("span");
    marker.className = "line-sidebar__marker";
    marker.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "line-sidebar__label";
    const number = document.createElement("span");
    number.className = "line-sidebar__index";
    number.setAttribute("aria-hidden", "true");
    number.textContent = String(index + 1).padStart(2, "0");
    const text = document.createElement("span");
    text.className = "line-sidebar__text";
    text.textContent = item.trim();
    label.append(number, text);
    row.append(marker, label);
    list.append(row);
    return row;
  });
  nav.replaceChildren(list);

  let activeIndex = -1;
  let targets = rows.map(() => 0);
  let current = rows.map(() => 0);
  let raf = null;
  let last = performance.now();
  const startLoop = () => {
    if (raf !== null) cancelAnimationFrame(raf);
    last = performance.now();
    raf = requestAnimationFrame(runFrame);
  };
  const runFrame = (now) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const factor = 1 - Math.exp(-dt / 0.1);
    let moving = false;
    rows.forEach((row, index) => {
      const target = Math.max(targets[index], activeIndex === index ? 1 : 0);
      const next = current[index] + (target - current[index]) * factor;
      current[index] = Math.abs(target - next) < 0.0015 ? target : next;
      row.style.setProperty("--effect", current[index].toFixed(4));
      if (Math.abs(target - current[index]) >= 0.0015) moving = true;
    });
    raf = moving ? requestAnimationFrame(runFrame) : null;
  };
  list.addEventListener("pointermove", (event) => {
    const rect = list.getBoundingClientRect();
    const pointerY = event.clientY - rect.top + list.scrollTop;
    targets = rows.map((row) => {
      const center = row.offsetTop + row.offsetHeight / 2;
      const progress = Math.max(0, 1 - Math.abs(pointerY - center) / 110);
      return progress * progress * (3 - 2 * progress);
    });
    startLoop();
  });
  list.addEventListener("pointerleave", () => {
    targets = targets.map(() => 0);
    startLoop();
  });
  rows.forEach((row, index) => {
    const activate = () => {
      activeIndex = index;
      rows.forEach((item, itemIndex) => item.toggleAttribute("aria-current", itemIndex === index));
      startLoop();
    };
    row.addEventListener("click", activate);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const nextIndex = event.key === "ArrowDown"
          ? Math.min(rows.length - 1, index + 1)
          : Math.max(0, index - 1);
        rows[nextIndex].focus({ preventScroll: true });
        rows[nextIndex].scrollIntoView({ behavior: "smooth", block: "nearest" });
        activeIndex = nextIndex;
        startLoop();
      }
    });
  });
  startLoop();
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
    const response = await fetch(META_URL, { cache: "default" });
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

  animateItemsCount(items.length);
  renderStaticLineSidebar(list, items);
  section.hidden = false;
}

async function refreshNewItems() {
  try {
    const response = await fetch(NEW_ITEMS_URL, { cache: "default" });
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
