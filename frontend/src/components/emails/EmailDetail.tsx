"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Archive, ArchiveRestore, ArrowLeft, ChevronDown, ExternalLink, Star, Trash2 } from "lucide-react";
import { formatLong } from "@/lib/format";
import { safeHttpUrl, sanitizeEmailHtml } from "@/lib/sanitize";
import { useEmail, useMe } from "@/hooks/queries";
import { useEmailActions } from "@/hooks/useEmailActions";
import { Avatar } from "../ui/Avatar";
import { IconButton } from "../ui/Button";
import { PageLoader } from "../ui/Spinner";
import { ErrorState } from "../ui/States";
import { StatusPill } from "../ui/StatusPill";
import { AttachmentTile } from "../attachments/AttachmentTile";

export function EmailDetail({ id }: { id: string }) {
  const router = useRouter();
  const me = useMe();
  const actions = useEmailActions();
  const [showDetails, setShowDetails] = useState(false);
  const email = useEmail(id);
  const html = useMemo(() => (email.data ? sanitizeEmailHtml(email.data.body) : ""), [email.data]);
  const subject = email.data?.subject;
  useEffect(() => {
    if (subject) document.title = `${subject} · Outbox`;
  }, [subject]);

  if (email.isPending) return <PageLoader label="Loading email" />;
  if (email.error) return <ErrorState message={email.error.message} onRetry={() => email.refetch()} />;
  const e = email.data;
  const senderName = e.fromName ?? e.from;
  const archived = Boolean(e.archivedAt);
  const previewUrl = safeHttpUrl(e.previewUrl);

  /** Back to the list the user came from, or to the mailbox this email lives in. */
  const leave = () => {
    if (window.history.length > 1) router.back();
    else router.push(e.status === "scheduled" || e.status === "sending" ? "/scheduled" : "/sent");
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-1.5 md:h-auto md:gap-2 md:border-0 md:px-4 md:py-3">
        <IconButton aria-label="Back" onClick={leave}>
          <ArrowLeft className="h-5 w-5 text-ink" />
        </IconButton>
        {/* On phones the subject wraps in the body instead of being cut off here. */}
        <h1 className="hidden min-w-0 flex-1 truncate text-lg text-ink md:block">{e.subject}</h1>
        <span className="flex-1 md:hidden" />
        <IconButton
          aria-label={e.starred ? "Unstar" : "Star"}
          aria-pressed={e.starred}
          title={e.starred ? "Unstar" : "Star"}
          onClick={() => actions.toggleStar(e)}
        >
          <Star className={clsx("h-4 w-4", e.starred && "fill-amber-400 text-amber-500")} />
        </IconButton>
        <IconButton
          aria-label={archived ? "Move out of archive" : "Archive"}
          title={archived ? "Move out of archive" : "Archive"}
          onClick={async () => {
            if ((await actions.setArchived(e, !archived)) && !archived) leave();
          }}
        >
          {archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        </IconButton>
        <IconButton
          aria-label="Delete"
          title={e.status === "scheduled" ? "Delete (cancels the send)" : e.status === "sending" ? "Being sent right now" : "Delete"}
          disabled={e.status === "sending"}
          onClick={async () => {
            if (await actions.remove(e)) leave();
          }}
        >
          <Trash2 className="h-4 w-4" />
        </IconButton>
        <span className="mx-1 hidden h-6 w-px bg-line md:block" aria-hidden />
        {me.data && (
          <span className="hidden md:block">
            <Avatar src={me.data.user.avatarUrl} name={me.data.user.name ?? me.data.user.email} size={30} />
          </span>
        )}
      </header>

      <article className="flex-1 overflow-y-auto overscroll-contain px-4 pb-10 pt-4">
        <div className="mx-auto max-w-[640px]">
          <p className="mb-4 break-words text-xl font-semibold leading-snug text-ink md:hidden" aria-hidden>
            {e.subject}
          </p>
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500 text-sm font-medium text-white" aria-hidden>
              {senderName.trim()[0]?.toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm md:truncate md:text-[13px]">
                <span className="font-semibold text-ink">{senderName}</span>{" "}
                <span className="block truncate text-[13px] text-ink-subtle md:inline">&lt;{e.from}&gt;</span>
                <span className="block truncate text-xs text-ink-subtle md:ml-1.5 md:inline md:text-[11px]" title="Relayed through this Ethereal test account">
                  via {e.via}
                </span>
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2 md:hidden">
                <time className="text-xs text-ink-muted" dateTime={e.sentAt ?? e.scheduledAt}>
                  {formatLong(e.sentAt ?? e.scheduledAt)}
                </time>
                {e.status !== "sent" && <StatusPill email={e} />}
              </div>
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                aria-expanded={showDetails}
                aria-controls="send-details"
                className="-mx-1 mt-0.5 flex min-h-8 max-w-full items-center gap-1 rounded px-1 text-xs text-ink-muted hover:text-ink md:mx-0 md:mt-0 md:min-h-0 md:px-0 md:text-[11px]"
              >
                <span className="truncate">to {e.to}</span> <ChevronDown className={clsx("h-3 w-3 transition-transform", showDetails && "rotate-180")} aria-hidden />
              </button>
              {showDetails && (
                <dl id="send-details" className="animate-pop-in mt-2 grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-line p-3 text-xs md:grid-cols-[88px_minmax(0,1fr)] md:gap-y-1 md:text-[11px]">
                  <dt className="text-ink-subtle">from</dt>
                  <dd className="break-words text-ink md:truncate">{e.fromName ? `${e.fromName} <${e.from}>` : e.from}</dd>
                  <dt className="text-ink-subtle">reply-to</dt>
                  <dd className="break-words text-ink md:truncate">{e.from}</dd>
                  <dt className="text-ink-subtle">to</dt>
                  <dd className="break-words text-ink md:truncate">{e.to}</dd>
                  <dt className="text-ink-subtle">relayed via</dt>
                  <dd className="break-words text-ink md:truncate">{e.via} (Ethereal)</dd>
                  <dt className="text-ink-subtle">subject</dt>
                  <dd className="break-words text-ink md:truncate">{e.subject}</dd>
                  <dt className="text-ink-subtle">scheduled for</dt>
                  <dd className="text-ink">{formatLong(e.scheduledAt)}</dd>
                  <dt className="text-ink-subtle">sent</dt>
                  <dd className="text-ink">{e.sentAt ? formatLong(e.sentAt) : "Not yet"}</dd>
                  <dt className="text-ink-subtle">status</dt>
                  <dd className="text-ink">
                    {e.status[0]!.toUpperCase() + e.status.slice(1)}
                    {e.attempts > 0 && ` after ${e.attempts} attempt${e.attempts > 1 ? "s" : ""}`}
                    {e.rescheduleCount > 0 && `, moved ${e.rescheduleCount}× by the hourly limit`}
                  </dd>
                </dl>
              )}
            </div>
            <div className="hidden shrink-0 flex-col items-end gap-1 md:flex">
              <time className="text-[11px] text-ink-muted" dateTime={e.sentAt ?? e.scheduledAt}>
                {formatLong(e.sentAt ?? e.scheduledAt)}
              </time>
              {e.status !== "sent" && <StatusPill email={e} />}
            </div>
          </div>

          {e.lastError && e.status !== "sent" && (
            <p className="mt-4 rounded-lg bg-failed-bg md:ml-11 px-4 py-3 text-[13px] text-failed-fg">{e.lastError}</p>
          )}
          {e.rescheduleCount > 0 && e.status === "scheduled" && (
            <p className="mt-4 rounded-lg bg-scheduled-bg md:ml-11 px-4 py-3 text-[13px] text-scheduled-fg">
              Moved {e.rescheduleCount} time{e.rescheduleCount > 1 ? "s" : ""} to stay within the hourly limits.
            </p>
          )}

          <div
            // Painted only inside its own box: an inline `position: fixed` in a body cannot
            // cover the dashboard (contain: paint makes this the containing block and clips).
            className="rich-text relative isolate mt-5 overflow-x-auto break-words [contain:paint] text-[15px] leading-relaxed text-ink md:ml-11 md:text-[13px] [&_img]:h-auto [&_img]:max-w-full"
            dangerouslySetInnerHTML={{ __html: html }} />

          {e.attachments && e.attachments.length > 0 && (
            <div className="mt-6 md:ml-11">
              <p className="mb-2 text-xs text-ink-muted md:text-[11px]">
                {e.attachments.length} attachment{e.attachments.length > 1 ? "s" : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                {e.attachments.map((a) => (
                  <AttachmentTile key={a.id} file={a} />
                ))}
              </div>
            </div>
          )}

          {previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline md:ml-11 md:min-h-0 md:text-[13px]"
            >
              View delivered message on Ethereal <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </article>
    </div>
  );
}
