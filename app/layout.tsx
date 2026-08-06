import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UnB computers — компьютеры и комплектующие",
  description:
    "Компьютеры, комплектующие и периферия для дома и бизнеса. Скачайте актуальный прайс-лист UnB computers.",
  icons: {
    icon: "/unb-logo.png",
    shortcut: "/unb-logo.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
