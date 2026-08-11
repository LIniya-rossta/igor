"use client";

import { useEffect, useRef, useState } from "react";

type CountUpProps = {
  from?: number;
  to: number;
  separator?: string;
  direction?: "up" | "down";
  duration?: number;
  delay?: number;
  className?: string;
};

function formatValue(value: number, separator: string) {
  const rounded = Math.round(value);
  if (!separator) return String(rounded);
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

export default function CountUp({
  from = 0,
  to,
  separator = "",
  direction = "up",
  duration = 1,
  delay = 0,
  className,
}: CountUpProps) {
  const [value, setValue] = useState(direction === "down" ? to : from);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    const startValue = direction === "down" ? to : from;
    const endValue = direction === "down" ? from : to;
    const durationMs = Math.max(0, duration * 1000);
    const delayMs = Math.max(0, delay * 1000);

    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setValue(startValue);

    const run = () => {
      if (!active) return;
      const startedAt = performance.now();
      const tick = (now: number) => {
        if (!active) return;
        const progress = durationMs === 0 ? 1 : Math.min(1, (now - startedAt) / durationMs);
        const eased = 1 - Math.pow(1 - progress, 3);
        setValue(startValue + (endValue - startValue) * eased);
        if (progress < 1) {
          frameRef.current = window.requestAnimationFrame(tick);
        }
      };
      frameRef.current = window.requestAnimationFrame(tick);
    };

    if (delayMs > 0) timerRef.current = window.setTimeout(run, delayMs);
    else run();

    return () => {
      active = false;
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [delay, direction, duration, from, to]);

  return <span className={className}>{formatValue(value, separator)}</span>;
}
