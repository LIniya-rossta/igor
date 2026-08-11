"use client";

import { useRef, useState, type KeyboardEvent } from "react";

type AnimatedListProps = {
  items: string[];
  onItemSelect?: (item: string, index: number) => void;
  showGradients?: boolean;
  enableArrowNavigation?: boolean;
  displayScrollbar?: boolean;
};

export default function AnimatedList({
  items,
  onItemSelect,
  showGradients = false,
  enableArrowNavigation = false,
  displayScrollbar = false,
}: AnimatedListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const selectItem = (index: number) => {
    setSelectedIndex(index);
    onItemSelect?.(items[index], index);
  };

  const focusItem = (index: number) => {
    const nextIndex = Math.max(0, Math.min(items.length - 1, index));
    const item = listRef.current?.querySelector<HTMLButtonElement>(`[data-animated-index="${nextIndex}"]`);
    item?.focus({ preventScroll: true });
    item?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    selectItem(nextIndex);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!enableArrowNavigation || !items.length) return;
    const current = selectedIndex ?? -1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      focusItem(current + 1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      focusItem(current - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(items.length - 1);
    }
  };

  const className = [
    "animated-list-shell",
    showGradients && "animated-list-shell--gradients",
  ].filter(Boolean).join(" ");
  const listClassName = [
    "animated-list",
    displayScrollbar && "animated-list--scrollbar",
    enableArrowNavigation && "animated-list--keyboard",
  ].filter(Boolean).join(" ");

  return (
    <div className={className}>
      <div
        ref={listRef}
        className={listClassName}
        role="list"
        aria-label="Новые товары"
        tabIndex={enableArrowNavigation ? 0 : undefined}
        onKeyDown={handleKeyDown}
      >
        {items.map((item, index) => (
          <button
            type="button"
            className={`animated-list-item${selectedIndex === index ? " is-selected" : ""}`}
            key={`${item}-${index}`}
            data-animated-index={index}
            style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
            onClick={() => selectItem(index)}
          >
            <span className="animated-list-mark" aria-hidden="true" />
            <span>{item}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
