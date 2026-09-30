import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ThemeBootstrap } from "@/components/shell/theme-bootstrap";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-nexa-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-nexa-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "NEXA AI — Your Private AI Workspace",
    template: "%s · NEXA AI",
  },
  description:
    "NEXA AI is a local-first private AI workspace: chat, documents, retrieval, tools and agents running against your own models.",
  applicationName: "NEXA AI",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#05070a",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Phase 5.5: the per-request CSP nonce, set by middleware. Reading request
  // headers opts this tree into dynamic rendering, which is what allows a
  // *per-request* nonce — a prerendered page cannot carry one, because the
  // value would be frozen at build time and immediately stale. Five pages were
  // previously prerendered (`/login`, `/signup`, `/forgot-password`,
  // `/reset-password`, `/_not-found`); they now render per request, which for
  // auth pages is the more correct behaviour anyway.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeBootstrap nonce={nonce} />
      </head>
      <body className={`${sans.variable} ${mono.variable} antialiased`}>
        <a
          href="#nexa-main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-100 focus:rounded-control focus:bg-graphite-800 focus:px-3 focus:py-2 focus:text-sm focus:text-ink-100"
        >
          Skip to main content
        </a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
