"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Filter, RefreshCw, Search, Star, X } from "lucide-react";
import clsx from "clsx";
import { queryKeys, useEmails } from "@/hooks/queries";
import { useEmailActions } from "@/hooks/useEmailActions";
import { useDebounced } from "@/hooks/useDebounced";
import { formatRowTime, stripHtml } from "@/lib/format";
import type { Email, EmailStatus, EmailView } from "@/lib/types";
import { Button, IconButton } from "../ui/Button";
import { EmptyState, ErrorState } from "../ui/States";
import { StatusPill } from "../ui/StatusPill";

const TITLES: Record<EmailView, string> = { scheduled: "Scheduled", sent: "Sent", starred: "Starred", archived: "Archived" };

const EMPTY: Record<EmailView, { title: string; message: string }> = {
  scheduled: { title: "No scheduled emails", message: "Emails you schedule from Compose will wait here until they go out." },
  sent: { title: "No sent emails yet", message: "Once scheduled emails are delivered they will show up here." },
  starred: { title: "No starred emails", message: "Star an email to find it here quickly." },
  archived: { title: "Nothing archived", message: "Archived emails leave Scheduled and Sent and wait here. Scheduled ones still go out on time." },
};

/** What the Filter menu offers in each mailbox. */
const FILTERS: Record<EmailView, { label: string; only?: EmailStatus }[]> = {
  scheduled: [{ label: "All scheduled" }, { label: "Waiting", only: "scheduled" }, { label: "Sending now", only: "sending" }],
  sent: [{ label: "All sent" }, { label: "Delivered", only: "sent" }, { label: "Failed", only: "failed" }],
  starred: [{ label: "All starred" }, { label: "Scheduled", only: "scheduled" }, { label: "Delivered", only: "sent" }, { label: "Failed", only: "failed" }],
  archived: [{ label: "All archived" }, { label: "Scheduled", only: "scheduled" }, { label: "Delivered", only: "sent" }, { label: "Failed", only: "failed" }],
};

export function EmailList({ view }: { view: EmailView }) {
  const [search, setSearch] = useState("");
  const [only, setOnly] = useState<EmailStatus | undefined>();
  const q = useDebounced(search.trim(), 300);
  const emails = useEmails(view, q, only);
  const activeFilter = FILTERS[view].find((f) => f.only === only);
  const qc = useQueryClient();
  const actions = useEmailActions();

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["emails"] });
    void qc.invalidateQueries({ queryKey: queryKeys.counts });
  };

  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">{TITLES[view]} emails</h1>
      <header className="flex items-center gap-1 px-3 pb-2 pt-3 md:gap-2 md:px-4 md:pb-3 md:pt-4">
        <label className="relative w-full max-w-[640px]">
          <span className="sr-only">Search {TITLES[view].toLowerCase()} emails</span>
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />
          <input
            type="search"
            maxLength={200}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${TITLES[view].toLowerCase()}`}
            enterKeyHint="search"
            className="w-full rounded-full bg-surface-muted py-2.5 pl-10 pr-10 text-[13px] outline-none ring-brand-500 placeholder:text-ink-subtle focus:ring-2 md:py-2 [&::-webkit-search-cancel-button]:hidden"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch("")}
              className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-ink-subtle hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </label>
        <FilterMenu options={FILTERS[view]} value={only} onChange={setOnly} />
        <IconButton aria-label="Refresh" title="Refresh" onClick={refresh}>
          <RefreshCw className={clsx("h-4 w-4", emails.isFetching && "animate-spin")} />
        </IconButton>
      </header>

      {/* Bottom padding on phones keeps the last row clear of the floating Compose button. */}
      <div className="flex-1 overflow-y-auto overscroll-contain pb-24 md:pb-0">
        {emails.isPending ? (
          <ListSkeleton />
        ) : emails.error ? (
          <ErrorState message={emails.error.message} onRetry={() => emails.refetch()} />
        ) : emails.data.items.length === 0 ? (
          q ? (
            <EmptyState title="No matches" message={`Nothing in ${view} matches “${q}”.`} />
          ) : only ? (
            <EmptyState title="Nothing here" message={`No emails in ${view} match the filter “${activeFilter?.label}”.`} />
          ) : (
            <EmptyState {...EMPTY[view]} />
          )
        ) : (
          <>
            <ul className="divide-y divide-line border-y border-line md:mx-4" aria-label={`${view} emails`}>
              {emails.data.items.map((email) => (
                <EmailRow key={email.id} email={email} onStar={() => actions.toggleStar(email)} />
              ))}
            </ul>
            <div className="flex flex-col items-center justify-center gap-3 px-4 py-5 text-[12px] text-ink-muted md:flex-row md:py-4">
              <span>
                Showing {emails.data.items.length} of {emails.data.total}
              </span>
              {emails.hasNextPage && (
                <Button
                  variant="outline"
                  pill
                  className="min-h-11 px-6 text-sm md:min-h-0 md:px-4 md:py-1.5 md:text-xs"
                  loading={emails.isFetchingNextPage}
                  onClick={() => emails.fetchNextPage()}
                >
                  Load more
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EmailRow({ email, onStar }: { email: Email; onStar: () => void }) {
  const delivered = email.status === "sent" || email.status === "failed";
  const preview = stripHtml(email.body);
  return (
    <li className="flex items-center transition-colors hover:bg-surface-muted active:bg-surface-muted">
      <Link
        href={`/emails/${email.id}`}
        className="min-w-0 flex-1 py-3 pl-4 focus-visible:bg-surface-muted focus-visible:outline-none lg:flex lg:items-center lg:gap-4 lg:py-3.5 lg:pl-3"
      >
        {/* Phones and tablets */}
        <span className="flex flex-col gap-1 lg:hidden">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{email.to}</span>
            {email.status === "sent" ? (
              <time className="shrink-0 text-xs tabular-nums text-ink-muted" dateTime={email.sentAt ?? undefined}>
                {email.sentAt ? formatRowTime(email.sentAt) : ""}
              </time>
            ) : (
              <StatusPill email={email} />
            )}
          </span>
          <span className="truncate text-sm text-ink">{email.subject}</span>
          <span className="truncate text-[13px] text-ink-subtle">{preview}</span>
        </span>

        {/* Desktop: the design's single-line row. */}
        <span className="hidden w-[190px] shrink-0 truncate text-[13px] text-ink lg:block">To: {email.to}</span>
        <span className="hidden min-w-0 flex-1 items-center gap-2 lg:flex">
          <StatusPill email={email} />
          <span className="min-w-0 flex-1 truncate text-[13px]">
            <span className="font-medium text-ink">{email.subject}</span>
            <span className="text-ink-subtle"> - {preview}</span>
          </span>
        </span>
        {delivered && (
          <time className="hidden shrink-0 text-[11px] tabular-nums text-ink-muted lg:block" dateTime={email.sentAt ?? undefined}>
            {email.sentAt ? formatRowTime(email.sentAt) : "Not sent"}
          </time>
        )}
      </Link>
      <button
        type="button"
        onClick={onStar}
        aria-label={email.starred ? `Unstar ${email.subject}` : `Star ${email.subject}`}
        aria-pressed={email.starred}
        className="mx-1 flex h-11 w-11 shrink-0 items-center justify-center self-start rounded-md text-ink-subtle hover:text-amber-500 focus-visible:outline-2 focus-visible:outline-brand-500 lg:mx-2 lg:h-8 lg:w-8 lg:self-center"
      >
        <Star className={clsx("h-4 w-4", email.starred && "fill-amber-400 text-amber-500")} />
      </button>
    </li>
  );
}

/** Placeholder rows shaped like the real ones, so the page doesn't jump when data arrives. */
function ListSkeleton() {
  return (
    <ul className="divide-y divide-line border-y border-line md:mx-4" aria-busy="true" aria-label="Loading emails">
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="px-4 py-3.5 lg:flex lg:items-center lg:gap-4 lg:px-3">
          <div className="flex flex-col gap-2 lg:hidden">
            <div className="flex justify-between gap-6">
              <span className="skeleton h-4 w-1/2" />
              <span className="skeleton h-4 w-16" />
            </div>
            <span className="skeleton h-3.5 w-3/4" />
            <span className="skeleton h-3 w-11/12" />
          </div>
          <span className="skeleton hidden h-3.5 w-[160px] lg:block" />
          <span className="skeleton hidden h-5 w-[110px] rounded-full lg:block" />
          <span className="skeleton hidden h-3.5 flex-1 lg:block" style={{ maxWidth: `${55 + ((i * 13) % 30)}%` }} />
        </li>
      ))}
    </ul>
  );
}

function FilterMenu({
  options,
  value,
  onChange,
}: {
  options: { label: string; only?: EmailStatus }[];
  value?: EmailStatus;
  onChange: (only?: EmailStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = value !== undefined;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <IconButton
        aria-label={active ? `Filter: ${options.find((o) => o.only === value)?.label}` : "Filter"}
        title="Filter"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={clsx("relative", active && "text-brand-600")}
      >
        <Filter className={clsx("h-4 w-4", active && "fill-brand-100")} />
        {active && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden />}
      </IconButton>
      {open && (
        <div role="menu" className="animate-pop-in absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg">
          {options.map((o) => {
            const selected = o.only === value;
            return (
              <button
                key={o.label}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onChange(o.only);
                  setOpen(false);
                }}
                className={clsx("flex w-full items-center gap-2 px-3 py-3 text-left text-sm hover:bg-surface-muted md:py-2 md:text-[13px]", selected && "font-medium")}
              >
                <Check className={clsx("h-3.5 w-3.5 text-brand-600", !selected && "invisible")} />
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
