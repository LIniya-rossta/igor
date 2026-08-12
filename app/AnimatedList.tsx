"use client";

import { useState } from "react";

type AnimatedListProps = {
  items: string[];
  showGradients?: boolean;
  displayScrollbar?: boolean;
  initialVisibleItems?: number;
};

export default function AnimatedList({
  items,
  showGradients = false,
  displayScrollbar = false,
  initialVisibleItems = 6,
}: AnimatedListProps) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? items : items.slice(0, initialVisibleItems);
  const hasMore = items.length > initialVisibleItems;

  const className = [
    "animated-list-shell",
    showGradients && "animated-list-shell--gradients",
  ].filter(Boolean).join(" ");
  const listClassName = [
    "animated-list",
    displayScrollbar && "animated-list--scrollbar",
  ].filter(Boolean).join(" ");

  return (
    <div className={className}>
      <div className="animated-list-header">
        <span>Новые позиции</span>
      </div>
      <div className={listClassName} role="list" aria-label="Новые товары">
        {visibleItems.map((item, index) => (
          <div
            className="animated-list-item"
            key={`${item}-${index}`}
            style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
            role="listitem"
          >
            <span className="animated-list-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <span className="animated-list-mark" aria-hidden="true" />
            <span>{item}</span>
          </div>
        ))}
      </div>
      {hasMore && (
        <button
          type="button"
          className="animated-list-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span>{expanded ? "Свернуть список" : `Показать все · ${items.length} позиций`}</span>
          <span aria-hidden="true">{expanded ? "↑" : "↓"}</span>
        </button>
      )}
    </div>
  );
}
