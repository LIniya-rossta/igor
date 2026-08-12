"use client";

import { useEffect, useState } from "react";
import { priceInfo } from "./price-config";
import AnimatedList from "./AnimatedList";
import CountUp from "./CountUp";

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

const fallbackMeta: PriceMeta = {
  updated: priceInfo.updated,
  version: priceInfo.version,
  filename: "UnB-price.xlsx",
  fileSize: null,
  uploadedAt: null,
  source: "fallback",
};

const META_TTL_MS = 60_000;
let metaCache: { request: Promise<PriceMeta>; expiresAt: number } | null = null;
let newItemsCache: { request: Promise<string[]>; expiresAt: number } | null = null;

function formatNewItemsNoun(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "позиция";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "позиции";
  return "позиций";
}

function loadMeta() {
  const now = Date.now();
  if (metaCache && metaCache.expiresAt > now) return metaCache.request;

  const request = fetch("/api/price/meta", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("Price metadata request failed");
      return response.json() as Promise<PriceMeta>;
    })
    .catch(() => fallbackMeta);
  metaCache = { request, expiresAt: now + META_TTL_MS };
  return request;
}

function loadNewItems() {
  const now = Date.now();
  if (newItemsCache && newItemsCache.expiresAt > now) return newItemsCache.request;

  const request = fetch("/api/price/new-items", { cache: "no-store" })
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
  const [meta, setMeta] = useState(fallbackMeta);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void loadMeta().then((nextMeta) => {
        if (active) setMeta(nextMeta);
      });
    };
    refresh();
    const interval = window.setInterval(refresh, META_TTL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  return meta;
}

export function LivePriceDate() {
  const meta = usePriceMeta();
  return <span aria-live="polite">{meta.updated}</span>;
}

export function LivePriceFileLine() {
  const meta = usePriceMeta();
  return (
    <p aria-live="polite">
      Версия {meta.version} · обновлено {meta.updated}
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

export function LiveNewItems() {
  const [items, setItems] = useState<string[]>([]);

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
        <span className="section-kicker">Новое в прайсе</span>
        <div className="new-items-title-row">
          <h2 id="new-items-title">Новинки</h2>
          <span className="new-items-count" aria-live="polite">
            {items.length ? (
              <>
                <CountUp from={0} to={items.length} separator="," direction="up" duration={1} className="count-up-text" delay={0} />{" "}
                {formatNewItemsNoun(items.length)}
              </>
            ) : "Пока пусто"}
          </span>
        </div>
      </div>
      {items.length ? (
        <AnimatedList
          items={items}
          showGradients
          displayScrollbar
        />
      ) : (
        <div className="new-items-empty">Новые товары появятся после следующего обновления прайса.</div>
      )}
    </section>
  );
}
