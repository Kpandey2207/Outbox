"use client";

import clsx from "clsx";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A modal panel: a bottom sheet on phones, a centred dialog from `md` up. Closes on Escape
 * and on the backdrop, locks page scroll while open and returns focus when it closes.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  className,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
  dismissible?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = panel.current?.querySelector<HTMLElement>("[data-autofocus], button, [href], input, select");
    focusable?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) onClose();
      if (e.key === "Tab" && panel.current) {
        // Keep Tab inside the panel.
        const items = [...panel.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, select, textarea")];
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, onClose, dismissible]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-6">
      <div className="animate-fade-in absolute inset-0 bg-black/40" onClick={() => dismissible && onClose()} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          "relative max-h-[90dvh] w-full overflow-y-auto bg-surface shadow-xl",
          "animate-sheet-up pb-safe rounded-t-2xl md:animate-pop-in md:max-w-sm md:rounded-2xl md:pb-0",
          className,
        )}
      >
        <div className="flex justify-center pt-2.5 md:hidden" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-line" />
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
