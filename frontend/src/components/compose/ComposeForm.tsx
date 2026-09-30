"use client";

import { useRouter } from "next/navigation";
import clsx from "clsx";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, Clock, Paperclip, Plus } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { Attachment, Me } from "@/lib/types";
import { queryKeys } from "@/hooks/queries";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useToast } from "../ui/Toast";
import { Button, IconButton } from "../ui/Button";
import { InlineError } from "../ui/States";
import { ACCEPTED_ATTACHMENTS, AttachmentTile, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_ATTACHMENTS_TOTAL_BYTES } from "../attachments/AttachmentTile";
import { RecipientsField } from "./RecipientsField";
import { RichTextEditor } from "./RichTextEditor";
import { SendLaterPicker } from "./SendLaterPicker";

type Errors = Partial<Record<"sender" | "to" | "subject" | "body" | "delay" | "limit" | "files" | "form", string>>;

export function ComposeForm({ me }: { me: Me }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [senderId, setSenderId] = useState(me.senders[0]?.id ?? "");
  const { limits } = me;
  const [recipients, setRecipients] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [delaySeconds, setDelaySeconds] = useState("");
  const [hourlyLimit, setHourlyLimit] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [addingSender, setAddingSender] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  // One key per compose session: a double click or a retried request cannot schedule twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const validate = (): Errors => {
    const e: Errors = {};
    if (!senderId) e.sender = "Add a sender first";
    if (recipients.length === 0) e.to = "Add at least one recipient or upload a list";
    else if (recipients.length > limits.maxRecipients) e.to = `Up to ${limits.maxRecipients.toLocaleString()} recipients per campaign`;
    if (!subject.trim()) e.subject = "Subject is required";
    if (!/<img\b/i.test(body) && !body.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;/gi, " ").trim()) e.body = "Write a message";
    const d = Number(delaySeconds);
    if (delaySeconds === "" || !Number.isFinite(d) || d < limits.minDelaySeconds || d > 3600) {
      e.delay = `Seconds between sends, ${limits.minDelaySeconds} to 3600`;
    }
    const l = Number(hourlyLimit);
    if (hourlyLimit === "" || !Number.isInteger(l) || l < 1 || l > limits.maxHourlyLimit) {
      e.limit = `Emails per hour, 1 to ${limits.maxHourlyLimit} per sender`;
    }
    if (uploading.length > 0) e.files = "Wait for the attachments to finish uploading";
    return e;
  };

  const openPicker = () => {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length === 0) setPickerOpen(true);
  };

  const schedule = async (at: Date) => {
    setSubmitting(true);
    setErrors({});
    try {
      const result = await api.createCampaign(
        {
          senderId,
          subject: subject.trim(),
          body,
          recipients,
          startAt: at.toISOString(),
          delayBetweenSeconds: Number(delaySeconds),
          hourlyLimit: Number(hourlyLimit),
          attachmentIds: attachments.map((a) => a.id),
        },
        idempotencyKey,
      );
      await Promise.all([qc.invalidateQueries({ queryKey: ["emails"] }), qc.invalidateQueries({ queryKey: queryKeys.counts })]);
      toast.success(`${result.scheduled} email${result.scheduled === 1 ? "" : "s"} scheduled, first one at ${new Date(result.firstSendAt).toLocaleString()}`);
      router.push("/scheduled");
    } catch (err) {
      const details = err instanceof ApiError && Array.isArray(err.details) ? `: ${err.details.map((d: { message: string }) => d.message).join(", ")}` : "";
      setErrors({ form: `${(err as Error).message}${details}` });
      setPickerOpen(false);
      setSubmitting(false);
    }
  };

  const addFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (fileInput.current) fileInput.current.value = "";
    if (files.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length - uploading.length;
    if (files.length > room) {
      setErrors((e) => ({ ...e, files: `You can attach up to ${MAX_ATTACHMENTS} files` }));
      return;
    }
    const tooBig = files.find((f) => f.size > MAX_ATTACHMENT_BYTES);
    if (tooBig) {
      setErrors((e) => ({ ...e, files: `${tooBig.name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` }));
      return;
    }
    const total = [...attachments.map((a) => a.size), ...files.map((f) => f.size)].reduce((a, b) => a + b, 0);
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
      setErrors((e) => ({ ...e, files: `Attachments can add up to ${MAX_ATTACHMENTS_TOTAL_BYTES / 1024 / 1024} MB per email` }));
      return;
    }
    setErrors((e) => ({ ...e, files: undefined }));
    const names = files.map((f) => f.name);
    setUploading((u) => [...u, ...names]);
    try {
      const { items } = await api.uploadAttachments(files);
      setAttachments((a) => [...a, ...items]);
    } catch (err) {
      setErrors((e) => ({ ...e, files: (err as Error).message }));
    } finally {
      setUploading((u) => u.filter((n) => !names.includes(n)));
    }
  };

  const removeFile = (id: string) => {
    setAttachments((a) => a.filter((f) => f.id !== id));
    // Best effort: an upload that is never scheduled is cleaned up by the server anyway.
    void api.removeAttachment(id).catch(() => undefined);
  };

  const addSender = async () => {
    setAddingSender(true);
    try {
      const sender = await api.addSender();
      await qc.invalidateQueries({ queryKey: queryKeys.me });
      setSenderId(sender.id);
    } catch (err) {
      setErrors({ sender: (err as Error).message });
    } finally {
      setAddingSender(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-1.5 md:h-auto md:gap-2 md:border-0 md:px-4 md:py-3">
        <IconButton aria-label="Back" onClick={() => router.back()}>
          <ArrowLeft className="h-5 w-5 text-ink" />
        </IconButton>
        <h1 className="min-w-0 flex-1 truncate text-base font-medium text-ink md:text-lg md:font-normal">
          <span className="md:hidden">New Email</span>
          <span className="hidden md:inline">Compose New Email</span>
        </h1>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPTED_ATTACHMENTS}
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <IconButton
          aria-label={attachments.length ? `Attach file (${attachments.length} attached)` : "Attach file"}
          title={`Attach images or documents, up to ${MAX_ATTACHMENTS} files of ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB each`}
          onClick={() => fileInput.current?.click()}
          className="relative"
        >
          <Paperclip className="h-4 w-4 text-brand-600" />
          {attachments.length > 0 && (
            <span className="absolute bottom-1.5 right-1 text-[9px] font-semibold leading-none text-brand-600">{attachments.length}</span>
          )}
        </IconButton>
        {/* Same action as Send Later; phones keep just the button to save room. */}
        <span className="hidden md:contents">
          <IconButton aria-label="Schedule" onClick={openPicker}>
            <Clock className="h-4 w-4 text-brand-600" />
          </IconButton>
        </span>
        <div className="relative mr-1.5 md:mr-0">
          <Button variant="outline" pill className="px-4 py-2 text-[13px] md:py-1.5 md:text-xs" onClick={openPicker} loading={submitting}>
            Send Later
          </Button>
          {pickerOpen && (
            <SendLaterPicker asSheet={isMobile} busy={submitting} onCancel={() => setPickerOpen(false)} onDone={schedule} />
          )}
        </div>
      </header>

      <form className="flex-1 overflow-y-auto overscroll-contain px-4 pb-10 pt-2 md:px-8 md:pt-4" onSubmit={(e) => e.preventDefault()} noValidate>
        <div className="mx-auto flex max-w-[720px] flex-col gap-0.5">
          {errors.form && (
            <div className="mb-3 rounded-lg bg-failed-bg px-4 py-3 text-sm text-failed-fg" role="alert">
              {errors.form}
            </div>
          )}

          <Row label="From" htmlFor="from" error={errors.sender}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <div className="relative w-full md:w-auto">
                <select
                  id="from"
                  value={senderId}
                  onChange={(e) => setSenderId(e.target.value)}
                  className="w-full appearance-none truncate rounded-md bg-surface-muted py-2 pl-2.5 pr-8 text-[13px] outline-none focus:ring-2 focus:ring-brand-500 md:w-auto md:py-1.5 md:pr-7"
                >
                  {me.senders.length === 0 && <option value="">No sender yet</option>}
                  {/* Recipients see the signed-in user; the Ethereal account only relays the mail. */}
                  {me.senders.map((s) => (
                    <option key={s.id} value={s.id}>
                      {me.senders.length > 1 ? `${me.user.email} (via ${s.email})` : me.user.email}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
              </div>
              {me.senders.length === 1 && (
                <span className="truncate text-[11px] text-ink-subtle" title="Emails are relayed through this Ethereal test account">
                  via {me.senders[0]!.email}
                </span>
              )}
              <button type="button" onClick={addSender} disabled={addingSender} className="inline-flex min-h-8 items-center gap-1 text-xs text-ink-subtle hover:text-brand-600 disabled:opacity-60 md:min-h-0 md:text-[11px]">
                <Plus className="h-3.5 w-3.5" /> {addingSender ? "Creating…" : "New Ethereal sender"}
              </button>
            </div>
          </Row>

          <RecipientsField value={recipients} onChange={setRecipients} invalid={Boolean(errors.to)} />
          {errors.to && (
            <div className="pl-[72px]">
              <InlineError>{errors.to}</InlineError>
            </div>
          )}

          <Row label="Subject" htmlFor="subject" error={errors.subject}>
            <input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              maxLength={500}
              enterKeyHint="next"
              className="w-full bg-transparent py-1.5 text-[13px] outline-none placeholder:text-ink-subtle md:py-1"
            />
          </Row>

          <div className="grid grid-cols-2 items-start gap-3 py-3 md:flex md:flex-wrap md:gap-x-8">
            <NumberField id="delay" label="Delay between 2 emails" unit="sec" title="Seconds between two sends" value={delaySeconds} onChange={setDelaySeconds} error={errors.delay} />
            <NumberField id="limit" label="Hourly Limit" unit="/ hr" title="Maximum emails per hour" value={hourlyLimit} onChange={setHourlyLimit} error={errors.limit} />
          </div>

          <RichTextEditor value={body} onChange={setBody} placeholder="Type Your Reply..." invalid={Boolean(errors.body)} />
          {errors.body && <InlineError>{errors.body}</InlineError>}

          {(attachments.length > 0 || uploading.length > 0) && (
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Attachments">
              {attachments.map((a) => (
                <AttachmentTile key={a.id} file={a} onRemove={() => removeFile(a.id)} />
              ))}
              {uploading.map((name, i) => (
                <AttachmentTile key={`${name}-${i}`} pendingName={name} />
              ))}
            </div>
          )}
          {errors.files && <InlineError>{errors.files}</InlineError>}

          <p className="mt-3 text-xs text-ink-subtle">
            {recipients.length > 0
              ? hourlyLimit && delaySeconds
                ? `${recipients.length} recipient${recipients.length > 1 ? "s" : ""}. At ${hourlyLimit} per hour with ${delaySeconds}s between sends, the last one goes out about ${estimate(recipients.length, Number(delaySeconds), Number(hourlyLimit))} after the start time.`
                : `${recipients.length} recipient${recipients.length > 1 ? "s" : ""}. Delay is in seconds; the hourly limit caps sends per hour for this sender.`
              : "Pick recipients, then choose when to start with Send Later."}
          </p>
        </div>
      </form>
    </div>
  );
}

function estimate(n: number, delay: number, limit: number): string {
  if (!n || !Number.isFinite(delay) || !limit) return "—";
  let t = 0;
  for (let i = 1; i < n; i++) t = Math.max(t + delay, Math.floor(i / limit) * 3600);
  if (t < 90) return `${Math.round(t)}s`;
  if (t < 5400) return `${Math.round(t / 60)} min`;
  return `${(t / 3600).toFixed(1)} h`;
}

function Row({ label, htmlFor, error, children }: { label: string; htmlFor: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line py-2.5">
      <div className="flex items-center gap-4">
        <label htmlFor={htmlFor} className="w-14 shrink-0 self-start pt-1.5 text-[13px] text-ink md:self-center md:pt-0">
          {label}
        </label>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {error && (
        <div className="pl-[72px]">
          <InlineError>{error}</InlineError>
        </div>
      )}
    </div>
  );
}

function NumberField({
  id,
  label,
  unit,
  value,
  onChange,
  title,
  error,
}: {
  id: string;
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  title?: string;
  error?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* Phones: label above a full-width box. Desktop: the design's inline label and small box. */}
      <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:gap-3">
        <label htmlFor={id} className="text-xs text-ink-muted md:text-[13px] md:text-ink">
          {label}
        </label>
        <div
          title={title}
          className={clsx(
            "flex items-center gap-1 rounded-md border px-3 py-2.5 focus-within:border-brand-500 md:px-2 md:py-1",
            error ? "border-failed-fg" : "border-line",
          )}
        >
          <input
            id={id}
            inputMode="numeric"
            value={value}
            onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="00"
            className="w-full min-w-0 bg-transparent text-[13px] tabular-nums outline-none placeholder:text-ink-subtle md:w-8"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
          />
          <span className="shrink-0 text-xs text-ink-subtle md:hidden">{unit}</span>
        </div>
      </div>
      {error && (
        <span id={`${id}-error`}>
          <InlineError>{error}</InlineError>
        </span>
      )}
    </div>
  );
}
