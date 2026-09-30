"use client";

import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Email } from "@/lib/types";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import { queryKeys } from "./queries";

/** Star, archive and delete, shared by the list rows and the email page. */
export function useEmailActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ["emails"] }), qc.invalidateQueries({ queryKey: queryKeys.counts })]);

  const run = async (action: () => Promise<Email | void>) => {
    try {
      const updated = await action();
      // Keep the open email page in step without refetching it (a deleted one would 404).
      if (updated) qc.setQueryData<Email>(queryKeys.email(updated.id), (prev) => (prev ? { ...prev, ...updated, attachments: prev.attachments } : prev));
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    } finally {
      await refresh();
    }
  };

  return {
    toggleStar: (email: Email) => run(() => api.updateEmail(email.id, { starred: !email.starred })),

    async setArchived(email: Email, archived: boolean) {
      const ok = await run(() => api.updateEmail(email.id, { archived }));
      if (ok && archived) {
        toast.success("Archived", { label: "Undo", onClick: () => void run(() => api.updateEmail(email.id, { archived: false })) });
      } else if (ok) {
        toast.success(`Moved back to ${email.status === "scheduled" || email.status === "sending" ? "Scheduled" : "Sent"}`);
      }
      return ok;
    },

    async remove(email: Email) {
      const scheduled = email.status === "scheduled";
      const confirmed = await confirm({
        title: scheduled ? "Delete scheduled email?" : "Delete email?",
        message: scheduled
          ? `The email to ${email.to} will be cancelled and never sent.`
          : `The email to ${email.to} will be removed from your mailboxes.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!confirmed) return false;
      const ok = await run(() => api.deleteEmail(email.id));
      if (ok) toast.success(scheduled ? "Scheduled email cancelled and deleted" : "Email deleted");
      return ok;
    },
  };
}
