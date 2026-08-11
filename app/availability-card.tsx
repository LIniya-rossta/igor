"use client";

import { LivePriceDate } from "./live-price";

export default function AvailabilityCard() {
  return (
    <div className="availability-card" data-availability-card>
      <span className="availability-icon" aria-hidden="true">✓</span>
      <span><b>Прайс актуален</b><small><LivePriceDate /></small></span>
    </div>
  );
}
