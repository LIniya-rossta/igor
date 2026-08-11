const API_ORIGIN = "https://unb-computers-kg.zilolatashievaz.chatgpt.site";
const META_URL = `${API_ORIGIN}/api/price/meta`;
const DOWNLOAD_URL = "https://liniya-rossta.github.io/igor/api/price/download";
const REFRESH_INTERVAL_MS = 60_000;
const PIN_GAP_PX = 12;

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

document.querySelectorAll("[data-price-download]").forEach((link) => {
  link.href = DOWNLOAD_URL;
});

const availabilityCard = document.querySelector("[data-availability-card]");
const heroVisual = availabilityCard?.closest(".hero-visual");

if (availabilityCard && heroVisual) {
  let pinAt = 0;

  const measureAvailabilityCard = () => {
    const wasPinned = availabilityCard.classList.contains("availability-card-pinned");
    if (wasPinned) availabilityCard.classList.remove("availability-card-pinned");

    const cardRect = availabilityCard.getBoundingClientRect();
    const header = document.querySelector(".site-header");
    const headerHeight = header?.getBoundingClientRect().height ?? 86;
    pinAt = Math.max(0, window.scrollY + cardRect.top - headerHeight - PIN_GAP_PX);

    if (wasPinned) availabilityCard.classList.add("availability-card-pinned");
  };

  const updateAvailabilityCard = () => {
    availabilityCard.classList.toggle(
      "availability-card-pinned",
      window.scrollY >= pinAt,
    );
  };

  measureAvailabilityCard();
  updateAvailabilityCard();
  window.addEventListener("scroll", updateAvailabilityCard, { passive: true });
  window.addEventListener("resize", measureAvailabilityCard);
}

void refreshPriceMeta();
window.setInterval(refreshPriceMeta, REFRESH_INTERVAL_MS);
