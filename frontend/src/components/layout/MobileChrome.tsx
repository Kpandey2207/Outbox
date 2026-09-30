"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { PenLine } from "lucide-react";
import type { Me } from "@/lib/types";
import { useCounts } from "@/hooks/queries";
import { Avatar } from "../ui/Avatar";
import { Logo } from "../ui/Logo";
import { Sheet } from "../ui/Sheet";
import { AccountActions, NAV } from "./Sidebar";

/** Mailbox routes get the phone chrome; Compose and an open email are full-screen pages. */
export function isMailboxRoute(pathname: string) {
  return NAV.some((n) => pathname.startsWith(n.href));
}

/** Phone header: the logo and the account button (the sidebar's profile card, as a sheet). */
export function MobileTopBar({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const name = me.user.name ?? me.user.email;
  return (
    <>
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-4 md:hidden">
        <Logo size={24} />
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Account and settings"
          className="-mr-1.5 rounded-full p-1.5 focus-visible:outline-2 focus-visible:outline-brand-500"
        >
          <Avatar src={me.user.avatarUrl} name={name} size={32} />
        </button>
      </header>
      <Sheet open={open} onClose={() => setOpen(false)} title="Account">
        <div className="flex items-center gap-3 border-b border-line px-5 pb-4 pt-3">
          <Avatar src={me.user.avatarUrl} name={name} size={44} />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{name}</p>
            <p className="truncate text-[13px] text-ink-muted">{me.user.email}</p>
          </div>
        </div>
        <div className="py-1">
          <AccountActions me={me} onDone={() => setOpen(false)} />
        </div>
      </Sheet>
    </>
  );
}

/** The sidebar's mailboxes as a bottom tab bar, within thumb reach. */
export function MobileTabBar() {
  const pathname = usePathname();
  const { data: counts } = useCounts();
  return (
    <nav aria-label="Mailboxes" className="pb-safe shrink-0 border-t border-line bg-surface md:hidden">
      <ul className="grid grid-cols-4">
        {NAV.map(({ href, label, icon: Icon, key }) => {
          const active = pathname.startsWith(href);
          const count = counts?.[key] ?? 0;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors",
                  active ? "font-semibold text-brand-700" : "text-ink-muted",
                )}
              >
                <span className={clsx("relative flex h-7 w-12 items-center justify-center rounded-full transition-colors", active && "bg-brand-50")}>
                  <Icon className="h-[18px] w-[18px]" />
                  {count > 0 && (
                    <span className="absolute -right-1.5 -top-1 min-w-[18px] rounded-full bg-brand-500 px-1 text-center text-[10px] font-semibold leading-[18px] text-white tabular-nums">
                      {count > 999 ? "999+" : count}
                    </span>
                  )}
                </span>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function ComposeFab() {
  return (
    <Link
      href="/compose"
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+72px)] right-4 z-30 flex h-12 items-center gap-2 rounded-full border border-brand-500 bg-surface pl-4 pr-5 text-sm font-medium text-brand-600 shadow-lg shadow-black/10 transition-colors active:bg-brand-50 md:hidden"
    >
      <PenLine className="h-4 w-4" />
      Compose
    </Link>
  );
}
