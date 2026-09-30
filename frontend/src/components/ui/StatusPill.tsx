import clsx from "clsx";
import { AlertCircle, Clock, Loader2 } from "lucide-react";
import { formatRowTime } from "@/lib/format";
import type { Email } from "@/lib/types";

/** Scheduled rows show when they go out; sent rows show a grey "Sent" chip, as in the design. */
export function StatusPill({ email }: { email: Email }) {
  const base = "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium";
  switch (email.status) {
    case "scheduled":
      return (
        <span className={clsx(base, "bg-scheduled-bg text-scheduled-fg")}>
          <Clock className="h-3 w-3" />
          {formatRowTime(email.scheduledAt)}
        </span>
      );
    case "sending":
      return (
        <span className={clsx(base, "bg-scheduled-bg text-scheduled-fg")}>
          <Loader2 className="h-3 w-3 animate-spin" />
          Sending
        </span>
      );
    case "sent":
      return <span className={clsx(base, "bg-sent-bg text-sent-fg")}>Sent</span>;
    case "failed":
      return (
        <span className={clsx(base, "bg-failed-bg text-failed-fg")}>
          <AlertCircle className="h-3 w-3" />
          Failed
        </span>
      );
    default:
      return <span className={clsx(base, "bg-sent-bg text-sent-fg")}>Cancelled</span>;
  }
}
