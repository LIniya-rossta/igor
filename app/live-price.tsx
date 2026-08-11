"use client";

import { useEffect, useState } from "react";
import { priceInfo } from "./price-config";

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

  if (!items.length) return null;

  return (
    <section className="new-items-section shell" id="new-items" aria-labelledby="new-items-title">
      <div className="new-items-heading">
        <span className="section-kicker">Новое в прайсе</span>
        <h2 id="new-items-title">Новинки</h2>
      </div>
      <div className="new-items-list">
        {items.map((item, index) => (
          <div className="new-item" key={`${item}-${index}`}>
            <span className="new-item-mark" aria-hidden="true" />
            <span>{item}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
