"use client";

import clsx from "clsx";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type Tone = "success" | "error";
interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
  action?: ToastAction;
}

interface ToastApi {
  /** An action (e.g. Undo) keeps the toast up a little longer and dismisses it when used. */
  success: (message: string, action?: ToastAction) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (tone: Tone, message: string, action?: ToastAction) => {
      const id = Date.now() + Math.random();
      setItems((all) => [...all.slice(-2), { id, tone, message, action }]);
      setTimeout(() => dismiss(id), tone === "error" || action ? 7000 : 4000);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(() => ({ success: (m, a) => push("success", m, a), error: (m) => push("error", m) }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+84px)] z-[60] flex flex-col items-stretch gap-2 md:inset-x-auto md:bottom-5 md:right-5 md:items-end"
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={clsx(
              "animate-toast-in pointer-events-auto flex w-full items-center gap-2 rounded-xl border bg-surface px-3.5 py-3 text-sm shadow-lg md:w-auto md:max-w-sm md:rounded-lg md:py-2.5 md:text-[13px]",
              t.tone === "error" ? "border-failed-fg/30 text-failed-fg" : "border-brand-100 text-ink",
            )}
          >
            {t.tone === "error" ? <AlertCircle className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-brand-600" />}
            <span className="flex-1">{t.message}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
                className="-my-2 px-2 py-2 font-medium text-brand-600 hover:underline"
              >
                {t.action.label}
              </button>
            )}
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="-m-2 p-2 text-ink-subtle hover:text-ink">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
