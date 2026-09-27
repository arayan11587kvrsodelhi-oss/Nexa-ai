"use client";

import { AlertTriangle, Info, RefreshCw, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/** A plain loading block used while a panel fetches. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("nexa-skeleton", className)} aria-hidden />;
}

const LINE_WIDTHS = ["w-full", "w-[92%]", "w-[78%]", "w-[88%]", "w-[64%]"];

export function SkeletonLines({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn("h-3", LINE_WIDTHS[i % LINE_WIDTHS.length])}
        />
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-panel border border-dashed px-6 py-10 text-center",
        className
      )}
      style={{ borderColor: "var(--nexa-border-strong)" }}
    >
      {icon ? (
        <div className="nexa-raised grid size-10 place-items-center rounded-full nexa-muted">
          {icon}
        </div>
      ) : null}
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium nexa-text">{title}</p>
        {description ? (
          <p className="text-xs leading-relaxed nexa-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export type ErrorTone = "error" | "warning" | "info";

const ERROR_ICON: Record<ErrorTone, ReactNode> = {
  error: (
    <XCircle className="size-4" style={{ color: "var(--nexa-danger-strong)" }} aria-hidden />
  ),
  warning: (
    <AlertTriangle className="size-4" style={{ color: "var(--nexa-warn-strong)" }} aria-hidden />
  ),
  info: <Info className="size-4 nexa-accent-text" aria-hidden />,
};

const ERROR_STYLE: Record<ErrorTone, string> = {
  error: "nexa-wash-danger",
  warning: "nexa-wash-warning",
  info: "nexa-wash-accent",
};

/**
 * The single, canonical way to show a failure or a blocked state.
 * `message` must always be a human sentence produced by the server's
 * sanitized error layer — never a raw stack trace or driver message.
 */
export function ErrorState({
  tone = "error",
  title,
  message,
  detail,
  action,
  onRetry,
  className,
}: {
  tone?: ErrorTone;
  title: string;
  message?: string;
  detail?: string;
  action?: ReactNode;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-panel border px-4 py-3.5",
        ERROR_STYLE[tone],
        className
      )}
    >
      <span className="mt-0.5 shrink-0">{ERROR_ICON[tone]}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium nexa-text">{title}</p>
        {message ? (
          <p className="mt-1 text-xs leading-relaxed nexa-muted">{message}</p>
        ) : null}
        {detail ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] nexa-muted hover:text-ink-300">
              Technical detail
            </summary>
            <pre className="nexa-raised mt-1.5 max-h-40 overflow-auto rounded-control p-2 font-mono text-[11px] leading-relaxed nexa-muted">
              {detail}
            </pre>
          </details>
        ) : null}
        {onRetry || action ? (
          <div className="mt-2.5 flex items-center gap-2">
            {onRetry ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={onRetry}
                icon={<RefreshCw className="size-3.5" aria-hidden />}
              >
                Retry
              </Button>
            ) : null}
            {action}
          </div>
        ) : null}
      </div>
    </div>
  );
}