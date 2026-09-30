"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Sheet } from "./Sheet";

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** `await confirm({...})` with the app's own dialog instead of the browser's. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    resolver.current?.(false);
    setOptions(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOptions(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Sheet open={options !== null} onClose={() => close(false)} title={options?.title ?? "Confirm"}>
        {options && (
          <div className="px-5 pb-5 pt-3 md:p-6">
            <h2 className="text-base font-semibold text-ink">{options.title}</h2>
            {options.message && <p className="mt-2 text-sm leading-relaxed text-ink-muted">{options.message}</p>}
            <div className="mt-6 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
              <Button variant="ghost" className="w-full md:w-auto" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                data-autofocus
                className={options.danger ? "w-full bg-failed-fg hover:bg-failed-fg/90 md:w-auto" : "w-full md:w-auto"}
                onClick={() => close(true)}
              >
                {options.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside ConfirmProvider");
  return ctx;
}
