"use client";

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { ConfirmProvider } from "@/components/ui/Confirm";
import { ToastProvider } from "@/components/ui/Toast";

/**
 * A session that ends mid-use (expired, or revoked by logging out elsewhere) sends the user
 * to sign in, instead of every panel showing "Authentication required".
 */
function onApiError(err: unknown) {
  if (!(err instanceof ApiError) || err.status !== 401 || err.code === "invalid_credentials") return;
  if (window.location.pathname.startsWith("/login")) return;
  // A full navigation starts the app over, so no query from the old session survives.
  window.location.replace("/login");
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: onApiError }),
        mutationCache: new MutationCache({ onError: onApiError }),
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: true,
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
