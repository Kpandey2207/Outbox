"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ComposeFab, isMailboxRoute, MobileTabBar, MobileTopBar } from "@/components/layout/MobileChrome";
import { Sidebar, SlackResultToast } from "@/components/layout/Sidebar";
import { ErrorState } from "@/components/ui/States";
import { PageLoader } from "@/components/ui/Spinner";
import { useMe } from "@/hooks/queries";
import { ApiError } from "@/lib/api";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const me = useMe();
  // The query cache's 401 handler (providers.tsx) is already navigating to /login.
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;

  if (me.isPending || unauthenticated) return <PageLoader />;
  if (me.error) return <ErrorState message={me.error.message} onRetry={() => me.refetch()} />;

  // Phones: Compose and an open email are full-screen pages with their own header.
  const mailbox = isMailboxRoute(pathname);
  return (
    <div className="flex h-dvh overflow-hidden">
      <SlackResultToast />
      <Sidebar me={me.data} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {mailbox && <MobileTopBar me={me.data} />}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
        {mailbox && (
          <>
            <ComposeFab />
            <MobileTabBar />
          </>
        )}
      </div>
    </div>
  );
}
