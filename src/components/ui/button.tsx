"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "icon" | "icon-sm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "font-semibold border",
  secondary: "nexa-raised nexa-hoverable hover:text-ink-100",
  ghost: "bg-transparent border border-transparent nexa-muted nexa-hoverable hover:text-ink-100",
  danger:
    "bg-transparent nexa-wash-danger nexa-hoverable hover:text-danger-400",
};

/** Primary reads its colours from the theme so light mode stays legible. */
const PRIMARY_STYLE = {
  backgroundColor: "var(--nexa-accent)",
  borderColor: "var(--nexa-accent)",
  color: "var(--nexa-accent-contrast)",
} as const;

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  icon: "size-9 justify-center",
  "icon-sm": "size-7 justify-center",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest },
    ref
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        style={variant === "primary" ? PRIMARY_STYLE : undefined}
        className={cn(
          "inline-flex select-none items-center rounded-control transition-colors duration-150",
          "disabled:cursor-not-allowed disabled:opacity-45",
          VARIANTS[variant],
          SIZES[size],
          className
        )}
        {...rest}
      >
        {loading ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        ) : (
          icon
        )}
        {children}
      </button>
    );
  }
);

export function IconButton({
  label,
  className,
  ...rest
}: ButtonProps & { label: string }) {
  return (
    <Button
      aria-label={label}
      title={label}
      size="icon-sm"
      variant="ghost"
      className={cn("nexa-muted hover:text-ink-100", className)}
      {...rest}
    />
  );
}