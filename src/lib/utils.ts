import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-aware class name merge. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 1536 -> "1.5 KB" */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** 1234 -> "1,234" */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

/** Relative time, e.g. "4m ago". Prefixes future/invalid values honestly. */
export function formatRelativeTime(input: string | Date | null | undefined): string {
  if (!input) return "—";
  const date = typeof input === "string" ? new Date(input) : input;
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return "—";

  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** 842 -> "842 ms", 3400 -> "3.4 s" */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** First line of a prompt, collapsed and truncated — used for auto titles. */
export function deriveTitle(text: string, maxLength = 60): string {
  const firstLine = text.replace(/\s+/g, " ").trim();
  if (!firstLine) return "New chat";
  if (firstLine.length <= maxLength) return firstLine;
  const cut = firstLine.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/** Return the IANA language id for a display language label, best effort. */
export function languageFromLabel(label: string): string {
  const map: Record<string, string> = {
    typescript: "typescript",
    ts: "typescript",
    tsx: "typescript",
    javascript: "javascript",
    js: "javascript",
    jsx: "javascript",
    python: "python",
    py: "python",
    java: "java",
    c: "c",
    cpp: "cpp",
    "c++": "cpp",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss",
    json: "json",
    jsonc: "json",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
    markdown: "markdown",
    md: "markdown",
    bash: "bash",
    sh: "bash",
    shell: "bash",
    php: "php",
    go: "go",
    rust: "rust",
    diff: "diff",
    text: "text",
    txt: "text",
  };
  return map[label.toLowerCase()] ?? "text";
}