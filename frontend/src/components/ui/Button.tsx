import clsx from "clsx";
import type { ButtonHTMLAttributes } from "react";
import { Spinner } from "./Spinner";

type Variant = "primary" | "outline" | "ghost" | "soft";

const styles: Record<Variant, string> = {
  primary: "bg-brand-500 text-white hover:bg-brand-600 disabled:bg-brand-500/60",
  outline: "border border-brand-500 text-brand-600 bg-white hover:bg-brand-50 disabled:opacity-60",
  soft: "bg-brand-50 text-ink hover:bg-brand-100 disabled:opacity-60",
  ghost: "text-ink-muted hover:bg-surface-muted hover:text-ink disabled:opacity-60",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  pill?: boolean;
}

export function Button({ variant = "primary", loading, pill, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed",
        pill ? "rounded-full" : "rounded-lg",
        styles[variant],
        className,
      )}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

export function IconButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={clsx(
        // 44px touch targets on phones, the design's 36px from md up.
        "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink md:h-9 md:w-9",
        "focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-50",
        className,
      )}
    />
  );
}
