import type { Metadata, Viewport } from "next";
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

export default function RootLayout({ children }: { children: ReactNode }) {
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
