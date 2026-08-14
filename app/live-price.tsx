"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { priceInfo } from "./price-config";
import CountUp from "./CountUp";
import LineSidebar from "./LineSidebar";
import { useLanguage } from "@/components/ui/language-toggle";
import { siteCopy, type Language } from "@/lib/site-copy";

type PriceMeta = {
  updated: string;
  version: string;
  filename: string;
  fileSize: number | null;
  uploadedAt: string | null;
  source: "telegram" | "fallback";
};

type NewItemsResponse = {
  items: string[];
};

type LiveNewItemsProps = {
  initialItems?: string[];
};

const fallbackMeta: PriceMeta = {
  updated: priceInfo.updated,
  version: priceInfo.version,
  filename: "UnB-price.xlsx",
  fileSize: null,
  uploadedAt: null,
  source: "fallback",
};

const META_TTL_MS = 60_000;
let newItemsCache: { request: Promise<string[]>; expiresAt: number } | null = null;

// All price labels share one small external store. Previously each label
// started its own interval and request, which meant four timers and four
// metadata refreshes on every page. One store keeps the UI in sync while
// avoiding duplicate work.
let sharedMeta = fallbackMeta;
let metaStoreStarted = false;
const metaListeners = new Set<() => void>();

function formatNewItemsNoun(count: number, language: Language) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (language === "en") return count === 1 ? "item" : "items";
  if (mod10 === 1 && mod100 !== 11) return "позиция";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "позиции";
  return "позиций";
}

const englishMonths: Record<string, string> = {
  января: "January", февраля: "February", марта: "March", апреля: "April",
  мая: "May", июня: "June", июля: "July", августа: "August",
  сентября: "September", октября: "October", ноября: "November", декабря: "December",
};

function formatUpdatedDate(value: string, language: Language) {
  if (language === "ru") return value;
  const match = /^(\d{1,2})\s+([^\s]+)\s+(\d{4})/.exec(value.trim().toLowerCase());
  if (!match) return value;
  const month = englishMonths[match[2]];
  return month ? `${month} ${Number(match[1])}, ${match[3]}` : value;
}

function loadMeta() {
  return fetch("/api/price/meta", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("Price metadata request failed");
      return response.json() as Promise<PriceMeta>;
    })
    .catch(() => fallbackMeta);
}

function refreshSharedMeta() {
  void loadMeta().then((nextMeta) => {
    const changed = JSON.stringify(nextMeta) !== JSON.stringify(sharedMeta);
    if (!changed) return;
    sharedMeta = nextMeta;
    metaListeners.forEach((listener) => listener());
  });
}

function startMetaStore() {
  if (metaStoreStarted || typeof window === "undefined") return;
  metaStoreStarted = true;
  refreshSharedMeta();
  window.setInterval(refreshSharedMeta, META_TTL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshSharedMeta();
  }, { passive: true });
}

function subscribeMeta(listener: () => void) {
  startMetaStore();
  metaListeners.add(listener);
  return () => metaListeners.delete(listener);
}

function getMetaSnapshot() {
  return sharedMeta;
}

function getServerMetaSnapshot() {
  return fallbackMeta;
}

function loadNewItems() {
  const now = Date.now();
  if (newItemsCache && newItemsCache.expiresAt > now) return newItemsCache.request;

  const request = fetch("/api/price/new-items", { cache: "default" })
    .then((response) => {
      if (!response.ok) throw new Error("New items request failed");
      return response.json() as Promise<NewItemsResponse>;
    })
    .then((payload) =>
      Array.isArray(payload.items)
        ? payload.items.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
    )
    .catch(() => []);
  newItemsCache = { request, expiresAt: now + META_TTL_MS };
  return request;
}

function usePriceMeta() {
  return useSyncExternalStore(subscribeMeta, getMetaSnapshot, getServerMetaSnapshot);
}

export function LivePriceDate() {
  const meta = usePriceMeta();
  const language = useLanguage();
  return <span aria-live="polite">{formatUpdatedDate(meta.updated, language)}</span>;
}

export function LivePriceFileLine() {
  const meta = usePriceMeta();
  const language = useLanguage();
  const copy = siteCopy[language].price;
  return (
    <p aria-live="polite">
      {copy.versionLabel} {meta.version} · {copy.updatedLabel} {formatUpdatedDate(meta.updated, language)}
    </p>
  );
}

export function LivePriceFilename() {
  const meta = usePriceMeta();
  return <span aria-live="polite">{meta.filename}</span>;
}

export function LivePriceFormat() {
  const meta = usePriceMeta();
  return <span aria-live="polite">{meta.filename.toLowerCase().endsWith(".xls") ? "XLS" : "XLSX"}</span>;
}

export function LiveNewItems({ initialItems = [] }: LiveNewItemsProps) {
  const [items, setItems] = useState<string[]>(initialItems);
  const language = useLanguage();
  const copy = siteCopy[language].newItems;

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void loadNewItems().then((nextItems) => {
        if (active) setItems(nextItems);
      });
    };
    refresh();
    const interval = window.setInterval(refresh, META_TTL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <section className="new-items-section shell" id="new-items" aria-labelledby="new-items-title">
      <div className="new-items-heading">
        <span className="section-kicker">{copy.kicker}</span>
        <div className="new-items-title-row">
          <h2 id="new-items-title">{copy.title}</h2>
          <span className="new-items-count" aria-live="polite">
            {items.length ? (
              <>
                <CountUp from={0} to={items.length} separator="," direction="up" duration={1} className="count-up-text" delay={0} />{" "}
                {formatNewItemsNoun(items.length, language)}
              </>
            ) : copy.emptyCount}
          </span>
        </div>
      </div>
      {items.length ? (
        <LineSidebar
          items={items}
          accentColor="#e5484d"
          textColor="#0e1f2e"
          markerColor="#aab1b5"
          proximityRadius={110}
          maxShift={18}
          falloff="smooth"
          markerLength={52}
          markerGap={12}
          tickScale={0.42}
          scaleTick
          itemGap={14}
          fontSize={1}
          smoothing={180}
          ariaLabel={copy.aria}
        />
      ) : (
        <div className="new-items-empty">{copy.empty}</div>
      )}
    </section>
  );
}
