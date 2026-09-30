"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Archive, BellOff, BellRing, ChevronDown, Clock, LayoutList, LogOut, Send, Star } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import type { Me } from "@/lib/types";
import { queryKeys, useCounts } from "@/hooks/queries";
import { Avatar } from "../ui/Avatar";
import { Logo } from "../ui/Logo";
import { useToast } from "../ui/Toast";

export const NAV = [
  { href: "/scheduled", label: "Scheduled", icon: Clock, key: "scheduled" as const },
  { href: "/sent", label: "Sent", icon: Send, key: "sent" as const },
  { href: "/starred", label: "Starred", icon: Star, key: "starred" as const },
  { href: "/archived", label: "Archived", icon: Archive, key: "archived" as const },
];

export function Sidebar({ me }: { me: Me }) {
  const pathname = usePathname();
  const { data: counts } = useCounts();

  return (
    <aside className="hidden h-full w-[240px] shrink-0 flex-col gap-5 border-r border-line bg-surface px-3.5 py-5 md:flex">
      <div className="px-1.5">
        <Logo />
      </div>

      <UserMenu me={me} />

      <Link
        href="/compose"
        className="flex items-center justify-center rounded-full border border-brand-500 py-2 text-[13px] font-medium text-brand-600 transition-colors hover:bg-brand-50"
      >
        Compose
      </Link>

      <nav aria-label="Mailboxes" className="flex flex-col gap-1">
        <p className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-subtle">Core</p>
        {NAV.map(({ href, label, icon: Icon, key }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                active ? "bg-brand-50 font-semibold text-ink" : "text-ink-muted hover:bg-surface-muted hover:text-ink",
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1">{label}</span>
              {counts && <span className="text-[11px] tabular-nums text-ink-muted">{counts[key]}</span>}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

function UserMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const name = me.user.name ?? me.user.email;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl bg-surface-muted px-2.5 py-2 text-left transition-colors hover:bg-line"
      >
        <Avatar src={me.user.avatarUrl} name={name} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{name}</span>
          <span className="block truncate text-[10px] text-ink-muted">{me.user.email}</span>
        </span>
        <ChevronDown className={clsx("h-4 w-4 text-ink-muted transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="animate-pop-in absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg">
          <AccountActions me={me} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

// Taller rows on phones, where these sit in a bottom sheet.
const menuItem = "flex w-full items-center gap-3 px-5 py-3.5 text-left text-[15px] hover:bg-surface-muted md:gap-2 md:px-3 md:py-2 md:text-sm";

/** Slack, queue dashboard and log out: the sidebar's profile menu and the phone account sheet. */
export function AccountActions({ me, onDone }: { me: Me; onDone: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();

  const logout = async () => {
    try {
      await api.logout();
    } catch (err) {
      // An expired session is already logged out; anything else is worth a retry.
      if (!(err instanceof ApiError && err.status === 401)) {
        toast.error("Could not log out. Check your connection and try again.");
        return;
      }
    }
    qc.clear();
    router.replace("/login");
  };

  return (
    <>
      <SlackMenuItems me={me} onDone={onDone} />
      {/* Bull Board sees every user's jobs, so the server only lets operators in. */}
      {me.features.queueDashboard && (
        <a href="/admin/queues" target="_blank" rel="noopener noreferrer" className={menuItem}>
          <LayoutList className="h-4 w-4" />
          Queue dashboard
        </a>
      )}
      <button onClick={logout} className={menuItem}>
        <LogOut className="h-4 w-4" />
        Log out
      </button>
    </>
  );
}

/**
 * Reports the result of the Slack OAuth round trip once, then cleans the URL. Mounted by the
 * dashboard layout, so it runs on return even though the account menu is closed.
 */
export function SlackResultToast() {
  const toast = useToast();
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("slack");
    if (!result) return;
    if (result === "connected") toast.success("Slack connected. Rate limit alerts will be posted there.");
    else toast.error(result === "denied" ? "Slack connection was cancelled." : "Could not connect Slack. Please try again.");
    url.searchParams.delete("slack");
    window.history.replaceState(null, "", url.toString());
  }, [toast]);
  return null;
}

/** The worker reads the Slack connection on every limit hit, so changes apply immediately. */
function SlackMenuItems({ me, onDone }: { me: Me; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();

  const run = async (fn: () => Promise<unknown>, success: string) => {
    onDone();
    try {
      await fn();
      toast.success(success);
      await qc.invalidateQueries({ queryKey: queryKeys.me });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  if (!me.features.slack) {
    return (
      <button className={menuItem} onClick={() => { onDone(); toast.error("Slack is not configured on this server (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET)."); }}>
        <BellRing className="h-4 w-4" />
        Connect Slack
      </button>
    );
  }
  if (!me.slack.connected) {
    return (
      <a href="/integrations/slack/install" className={menuItem}>
        <BellRing className="h-4 w-4" />
        Connect Slack
      </a>
    );
  }
  return (
    <>
      <p className="px-5 pb-1 pt-2 text-xs text-ink-muted md:px-3 md:text-[11px]">
        Slack alerts on #{me.slack.channelName?.replace(/^#/, "") ?? "channel"}
        {me.slack.teamName ? ` in ${me.slack.teamName}` : ""}
      </p>
      <button className={menuItem} onClick={() => run(api.testSlack, "Test message sent to Slack.")}>
        <BellRing className="h-4 w-4 text-brand-600" />
        Send Slack test message
      </button>
      <button className={menuItem} onClick={() => run(api.disconnectSlack, "Slack disconnected. Alerts are off.")}>
        <BellOff className="h-4 w-4" />
        Disconnect Slack
      </button>
    </>
  );
}
