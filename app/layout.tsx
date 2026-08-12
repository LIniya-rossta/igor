import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./LineSidebar.css";

const title = "UnB computers — компьютеры и комплектующие";
const description =
  "Компьютеры, комплектующие и периферия для дома и бизнеса. Скачайте актуальный прайс-лист UnB computers.";

export const viewport: Viewport = {
  themeColor: "#f3f0e8",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || requestHeaders.get("host") || "unb-computers-kg.zilolatashievaz.chatgpt.site";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  const protocol = forwardedProtocol === "http" || isLocalHost ? "http" : "https";
  let origin = "https://unb-computers-kg.zilolatashievaz.chatgpt.site";

  try {
    origin = new URL(`${protocol}://${host}`).origin;
  } catch {
    // Keep the deployed origin when preview headers are malformed.
  }

  const socialImage = `${origin}/og-unb.png`;
  return {
    title,
    description,
    icons: {
      icon: "/unb-logo.png",
      shortcut: "/unb-logo.png",
    },
    openGraph: {
      type: "website",
      locale: "ru_RU",
      title,
      description,
      images: [{ url: socialImage, width: 1731, height: 909, alt: "UnB computers" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <head>
        <meta name="color-scheme" content="only light" />
        <meta name="darkreader-lock" />
      </head>
      <body>{children}</body>
    </html>
  );
}
