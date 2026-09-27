import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "muted";

/**
 * Tone colours come from the semantic variables so a badge is legible in both
 * themes. The strong text colour is paired with a faint wash of the same hue and
 * a mid-strength border, which is what makes a 10px label readable.
 */
const TONE_STYLE: Record<BadgeTone, React.CSSProperties> = {
  neutral: {
    backgroundColor: "var(--nexa-overlay-tint)",
    borderColor: "var(--nexa-border-strong)",
    color: "var(--nexa-text)",
  },
  accent: {
    backgroundColor: "var(--nexa-accent-wash)",
    borderColor: "var(--nexa-accent-wash-line)",
    color: "var(--nexa-accent-strong)",
  },
  success: {
    backgroundColor: "var(--nexa-success-wash)",
    borderColor: "var(--nexa-success-wash-line)",
    color: "var(--nexa-success-strong)",
  },
  warning: {
    backgroundColor: "var(--nexa-warn-wash)",
    borderColor: "var(--nexa-warn-wash-line)",
    color: "var(--nexa-warn-strong)",
  },
  danger: {
    backgroundColor: "var(--nexa-danger-wash)",
    borderColor: "var(--nexa-danger-wash-line)",
    color: "var(--nexa-danger-strong)",
  },
  muted: {
    backgroundColor: "transparent",
    borderColor: "var(--nexa-border-strong)",
    color: "var(--nexa-text-muted)",
  },
};

export function Badge({
  tone = "neutral",
  className,
  children,
  mono = false,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium whitespace-nowrap",
        mono && "font-mono",
        className
      )}
      style={TONE_STYLE[tone]}
    >
      {children}
    </span>
  );
}

/** Small status dot. `pulse` adds a live ring for in-flight states. */
export function StatusDot({
  tone = "neutral",
  pulse = false,
  className,
}: {
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  pulse?: boolean;
  className?: string;
}) {
  const colors: Record<string, string> = {
    neutral: "bg-ink-500",
    accent: "bg-teal-500 text-teal-500",
    success: "bg-success-500 text-success-500",
    warning: "bg-warn-500 text-warn-500",
    danger: "bg-danger-500 text-danger-500",
  };
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        colors[tone],
        pulse && "nexa-live-ring",
        className
      )}
    />
  );
}