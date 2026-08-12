"use client";

import { useEffect, useSyncExternalStore } from "react";

type Language = "ru" | "en";

const STORAGE_KEY = "unb-language";

function getStoredLanguage(): Language {
  if (typeof window === "undefined") return "ru";
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "ru";
  } catch {
    return "ru";
  }
}

function subscribeToLanguage(onChange: () => void) {
  const handleChange = () => onChange();
  window.addEventListener("storage", handleChange);
  window.addEventListener("unb-language-change", handleChange);
  return () => {
    window.removeEventListener("storage", handleChange);
    window.removeEventListener("unb-language-change", handleChange);
  };
}

export default function LanguageToggle() {
  const language = useSyncExternalStore(subscribeToLanguage, getStoredLanguage, () => "ru");

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const selectLanguage = (nextLanguage: Language) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, nextLanguage);
    } catch {
      // The control still works for the current session if storage is blocked.
    }
    window.dispatchEvent(new CustomEvent("unb-language-change", { detail: { language: nextLanguage } }));
  };

  return (
    <div className="language-toggle" role="group" aria-label="Выбор языка">
      <button
        type="button"
        className={`language-toggle__option${language === "ru" ? " is-active" : ""}`}
        aria-pressed={language === "ru"}
        onClick={() => selectLanguage("ru")}
      >
        RU
      </button>
      <span className="language-toggle__divider" aria-hidden="true">/</span>
      <button
        type="button"
        className={`language-toggle__option${language === "en" ? " is-active" : ""}`}
        aria-pressed={language === "en"}
        onClick={() => selectLanguage("en")}
      >
        EN
      </button>
    </div>
  );
}
