import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "IAC Media Operations",
    short_name: "IAC Media",
    description: "Media production coordination for the Imam Ali Center.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#111d31",
    theme_color: "#111d31",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
