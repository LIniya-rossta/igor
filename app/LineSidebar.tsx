"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

type Falloff = "linear" | "smooth" | "sharp";

type LineSidebarProps = {
  items: string[];
  accentColor?: string;
  textColor?: string;
  markerColor?: string;
  showIndex?: boolean;
  showMarker?: boolean;
  proximityRadius?: number;
  maxShift?: number;
  falloff?: Falloff;
  markerLength?: number;
  markerGap?: number;
  tickScale?: number;
  scaleTick?: boolean;
  itemGap?: number;
  fontSize?: number;
  smoothing?: number;
  defaultActive?: number | null;
  onItemClick?: (index: number, label: string) => void;
  ariaLabel?: string;
  className?: string;
};

const FALLOFF_CURVES: Record<Falloff, (progress: number) => number> = {
  linear: (progress) => progress,
  smooth: (progress) => progress * progress * (3 - 2 * progress),
  sharp: (progress) => progress * progress * progress,
};

export default function LineSidebar({
  items,
  accentColor = "#e5484d",
  textColor = "#0e1f2e",
  markerColor = "#aab1b5",
  showIndex = true,
  showMarker = true,
  proximityRadius = 110,
  maxShift = 18,
  falloff = "smooth",
  markerLength = 52,
  markerGap = 12,
  tickScale = 0.42,
  scaleTick = true,
  itemGap = 14,
  fontSize = 1,
  smoothing = 100,
  defaultActive = null,
  onItemClick,
  ariaLabel = "Новинки прайс-листа",
  className = "",
}: LineSidebarProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const targetsRef = useRef<number[]>([]);
  const currentRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(0);
  const activeRef = useRef(defaultActive);
  const smoothingRef = useRef(smoothing);
  const [activeIndex, setActiveIndex] = useState(defaultActive);

  activeRef.current = activeIndex;
  smoothingRef.current = smoothing;

  const runFrame = useCallback((now: number) => {
    const dt = Math.min((now - lastRef.current) / 1000, 0.05);
    lastRef.current = now;
    const tau = Math.max(smoothingRef.current, 1) / 1000;
    const factor = 1 - Math.exp(-dt / tau);
    let moving = false;

    for (let index = 0; index < itemRefs.current.length; index += 1) {
      const element = itemRefs.current[index];
      if (!element) continue;
      const target = Math.max(targetsRef.current[index] || 0, activeRef.current === index ? 1 : 0);
      const current = currentRef.current[index] || 0;
      const next = current + (target - current) * factor;
      const settled = Math.abs(target - next) < 0.0015;
      const value = settled ? target : next;
      currentRef.current[index] = value;
      element.style.setProperty("--effect", value.toFixed(4));
      if (!settled) moving = true;
    }

    rafRef.current = moving ? window.requestAnimationFrame(runFrame) : null;
  }, []);

  const startLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    lastRef.current = performance.now();
    rafRef.current = window.requestAnimationFrame(runFrame);
  }, [runFrame]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLUListElement>) => {
    const list = listRef.current;
    if (!list) return;
    const rect = list.getBoundingClientRect();
    const pointerY = event.clientY - rect.top + list.scrollTop;
    const ease = FALLOFF_CURVES[falloff] ?? FALLOFF_CURVES.linear;
    targetsRef.current = itemRefs.current.map((element) => {
      if (!element) return 0;
      const center = element.offsetTop + element.offsetHeight / 2;
      return ease(Math.max(0, 1 - Math.abs(pointerY - center) / proximityRadius));
    });
    startLoop();
  }, [falloff, proximityRadius, startLoop]);

  const handlePointerLeave = useCallback(() => {
    targetsRef.current = targetsRef.current.map(() => 0);
    startLoop();
  }, [startLoop]);

  const handleKeyDown = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setActiveIndex(index);
      onItemClick?.(index, items[index]);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const nextIndex = event.key === "ArrowDown"
      ? Math.min(items.length - 1, index + 1)
      : Math.max(0, index - 1);
    const next = itemRefs.current[nextIndex];
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setActiveIndex(nextIndex);
  };

  useEffect(() => {
    currentRef.current = items.map((_, index) => currentRef.current[index] || 0);
    targetsRef.current = items.map((_, index) => targetsRef.current[index] || 0);
    startLoop();
  }, [items, startLoop]);

  useEffect(() => () => {
    if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <nav
      className={`line-sidebar${showMarker ? " line-sidebar--markers" : ""}${scaleTick ? " line-sidebar--scale-tick" : ""}${className ? ` ${className}` : ""}`}
      aria-label={ariaLabel}
      style={{
        "--accent-color": accentColor,
        "--text-color": textColor,
        "--marker-color": markerColor,
        "--marker-length": `${markerLength}px`,
        "--marker-gap": `${markerGap}px`,
        "--tick-scale": tickScale,
        "--max-shift": `${maxShift}px`,
        "--item-gap": `${itemGap}px`,
        "--font-size": `${fontSize}rem`,
      } as CSSProperties}
    >
      <ul
        ref={listRef}
        className="line-sidebar__list"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        {items.map((label, index) => (
          <li
            key={`${label}-${index}`}
            ref={(element) => { itemRefs.current[index] = element; }}
            className="line-sidebar__item"
            role="button"
            aria-current={activeIndex === index ? "true" : undefined}
            tabIndex={0}
            onClick={() => {
              setActiveIndex(index);
              onItemClick?.(index, label);
            }}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {showMarker && <span className="line-sidebar__marker" aria-hidden="true" />}
            <span className="line-sidebar__label">
              {showIndex && <span className="line-sidebar__index">{String(index + 1).padStart(2, "0")}</span>}
              <span className="line-sidebar__text">{label}</span>
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
