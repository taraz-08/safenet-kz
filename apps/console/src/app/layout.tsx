import type { Metadata, Viewport } from "next";
import { Providers } from "@/components/providers";
import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  title: "SafeNet AI · Security Operations",
  description: "Explainable public-source risk intelligence for Kazakhstan. Evidence-led review, browser agents and human decisions.",
  icons: { icon: "/icon.svg" },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: "#10161e", width: "device-width", initialScale: 1 };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" className="dark"><body><Providers>{children}</Providers></body></html>;
}
