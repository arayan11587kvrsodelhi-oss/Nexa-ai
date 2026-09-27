"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss. Pass 0 to require manual dismissal. */
  durationMs?: number;
}

interface ToastRecord extends Required<Omit<ToastInput, "description">> {
  id: string;
  description?: string;
}

interface ToastContextValue {
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_STYLES: Record<ToastTone, { ring: string; icon: ReactNode }> = {
  info: {
    ring: "nexa-wash-accent",
    icon: <Info className="size-4 nexa-accent-text" aria-hidden />,
  },
  success: {
    ring: "nexa-wash-success",
    icon: (
      <CheckCircle2
        className="size-4"
        style={{ color: "var(--nexa-success-strong)" }}
        aria-hidden
      />
    ),
  },
  warning: {
    ring: "nexa-wash-warning",
    icon: (
      <AlertTriangle
        className="size-4"
        style={{ color: "var(--nexa-warn-strong)" }}
        aria-hidden
      />
    ),
  },
  error: {
    ring: "nexa-wash-danger",
    icon: (
      <XCircle
        className="size-4"
        style={{ color: "var(--nexa-danger-strong)" }}
        aria-hidden
      />
    ),
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const record: ToastRecord = {
        id,
        title: input.title,
        description: input.description,
        tone: input.tone ?? "info",
        durationMs: input.durationMs ?? (input.tone === "error" ? 8000 : 4500),
      };
      setToasts((prev) => [...prev.slice(-4), record]);
      if (record.durationMs > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), record.durationMs)
        );
      }
      return id;
    },
    [dismiss]
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
    };
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-4 right-4 z-100 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((t) => {
          const tone = TONE_STYLES[t.tone];
          return (
            <div
              key={t.id}
              role="status"
              aria-live={t.tone === "error" ? "assertive" : "polite"}
              className={cn(
                "nexa-enter pointer-events-auto flex items-start gap-3 rounded-panel border bg-graphite-900/95 px-3.5 py-3 shadow-panel backdrop-blur",
                tone.ring
              )}
            >
              <span className="mt-0.5 shrink-0">{tone.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium nexa-text">{t.title}</p>
                {t.description ? (
                  <p className="mt-0.5 text-xs leading-relaxed nexa-muted">
                    {t.description}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="shrink-0 rounded p-1 nexa-muted nexa-hoverable hover:text-ink-200"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}