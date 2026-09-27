import { cn } from "@/lib/utils";

/**
 * NEXA mark. A restrained hexagonal aperture with a teal core —
 * no gradients, no simulated "AI glow".
 */
export function NexaMark({
  className,
  size = 26,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={cn("shrink-0", className)}
      style={{ color: "var(--nexa-accent)", display: "block" }}
    >
      <path
        d="M16 2.6 27.4 9.2v13.6L16 29.4 4.6 22.8V9.2L16 2.6Z"
        stroke="var(--nexa-border-strong)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M11.4 21.2V10.8l9.2 10.4V10.8"
        stroke="var(--nexa-accent)"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function NexaWordmark({
  collapsed = false,
  className,
}: {
  collapsed?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <NexaMark />
      {collapsed ? null : (
        <div className="min-w-0 flex-1 leading-none">
          <span className="block text-[13px] font-semibold tracking-[0.14em] nexa-text">
            NEXA<span style={{ color: "var(--nexa-accent)" }}> AI</span>
          </span>
          <span className="mt-1 block truncate text-[10px] tracking-wide nexa-muted">
            Your Private AI Workspace
          </span>
        </div>
      )}
    </div>
  );
}