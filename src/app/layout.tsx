import type { Metadata, Viewport } from "next";
import { PwaRegistration } from "@/components/pwa-registration";
import { AmbientEffects } from "@/components/ambient-effects";
import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "IAC Media Operations",
  description: "Media production coordination for the Imam Ali Center.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#111d31",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><PwaRegistration /><AmbientEffects />{children}</body></html>;
}
