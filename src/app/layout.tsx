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
  // Phase 5.5: this tree must render **per request**, not be prerendered. The
  // CSP policy carries a fresh nonce on every response (see `src/middleware.ts`),
  // so a cached HTML document would ship a stale nonce while the browser
  // enforces the new one — and the browser would then block every script,
  // including the React runtime itself. Touching `headers()` is what opts the
  // tree into dynamic rendering. Five pages used to be prerendered
  // (`/login`, `/signup`, `/forgot-password`, `/reset-password`,
  // `/_not-found`), which was incompatible with a per-request nonce.
  //
  // The nonce itself is deliberately *not* read or passed down here. Next.js
  // parses it straight off this same `content-security-policy` request header
  // and stamps it onto the scripts it emits, `ThemeBootstrap` included, which
  // is also what keeps React from ever reconciling that browser-managed
  // attribute. See the comment in `theme-bootstrap.tsx` for the full rationale.
  await headers();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeBootstrap />
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
