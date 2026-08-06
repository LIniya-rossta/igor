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
