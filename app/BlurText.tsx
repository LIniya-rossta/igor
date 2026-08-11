"use client";

import { useEffect, useMemo } from "react";

type BlurTextProps = {
  text: string;
  delay?: number;
  animateBy?: "words" | "letters";
  direction?: "top" | "bottom" | "left" | "right";
  onAnimationComplete?: () => void;
  className?: string;
};

/** Lightweight BlurText animation with no runtime dependency. */
export default function BlurText({
  text,
  delay = 0,
  animateBy = "words",
  direction = "top",
  onAnimationComplete,
  className = "",
}: BlurTextProps) {
  const items = useMemo(
    () => (animateBy === "letters" ? Array.from(text) : text.split(" ")),
    [animateBy, text],
  );

  useEffect(() => {
    if (!onAnimationComplete) return;

    const duration = delay + Math.max(items.length - 1, 0) * 55 + 760;
    const timer = window.setTimeout(onAnimationComplete, duration);
    return () => window.clearTimeout(timer);
  }, [delay, items.length, onAnimationComplete]);

  return (
    <span
      className={`blur-text blur-text-${direction} ${className}`.trim()}
      aria-label={text}
    >
      <span aria-hidden="true">
        {items.map((item, index) => (
          <span
            className="blur-text-item"
            key={`${item}-${index}`}
            style={{ animationDelay: `${delay + index * 55}ms` }}
          >
            {item}
            {animateBy === "words" && index < items.length - 1 ? " " : ""}
          </span>
        ))}
      </span>
    </span>
  );
}
