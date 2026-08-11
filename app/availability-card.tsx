"use client";

import { useEffect, useState } from "react";
import { LivePriceDate } from "./live-price";

const PIN_GAP_PX = 12;

export default function AvailabilityCard() {
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    const card = document.querySelector<HTMLElement>("[data-availability-card]");
    const hero = card?.closest<HTMLElement>(".hero-visual");
    if (!card || !hero) return;

    let pinAt = 0;

    const measure = () => {
      const wasPinned = card.classList.contains("availability-card-pinned");
      if (wasPinned) card.classList.remove("availability-card-pinned");

      const heroRect = hero.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const header = document.querySelector<HTMLElement>(".site-header");
      const headerHeight = header?.getBoundingClientRect().height ?? 86;
      pinAt = Math.max(
        0,
        window.scrollY + cardRect.top - headerHeight - PIN_GAP_PX,
      );

      if (wasPinned) card.classList.add("availability-card-pinned");
      return heroRect;
    };

    const update = () => {
      setPinned((current) => {
        const next = window.scrollY >= pinAt;
        return current === next ? current : next;
      });
    };

    measure();
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <div
      className={`availability-card${pinned ? " availability-card-pinned" : ""}`}
      data-availability-card
    >
      <span className="availability-icon" aria-hidden="true">✓</span>
      <span><b>Прайс актуален</b><small><LivePriceDate /></small></span>
    </div>
  );
}
