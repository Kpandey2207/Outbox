"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Upload, X } from "lucide-react";
import { api } from "@/lib/api";
import { Spinner } from "../ui/Spinner";
import { InlineError } from "../ui/States";

// Same rule as the server (backend/src/services/scheduling.ts).
const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/;
const VISIBLE_CHIPS = 3;

/** "To" row: type addresses as chips, or upload a CSV of leads with "Upload List". */
export function RecipientsField({ value, onChange, invalid }: { value: string[]; onChange: (v: string[]) => void; invalid?: boolean }) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const add = (raw: string[]) => {
    const next = new Set(value);
    const bad: string[] = [];
    for (const r of raw.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      if (r.length <= 254 && EMAIL_RE.test(r)) next.add(r);
      else bad.push(r);
    }
    onChange([...next]);
    setError(bad.length ? `Not an email address: ${bad.slice(0, 3).join(", ")}` : null);
  };

  const commitDraft = () => {
    if (!draft.trim()) return;
    add(draft.split(/[\s,;]+/));
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (["Enter", ",", ";", " ", "Tab"].includes(e.key) && draft.trim()) {
      e.preventDefault();
      commitDraft();
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const parsed = await api.parseLeads(file);
      const before = value.length;
      const merged = [...new Set([...value, ...parsed.emails])];
      onChange(merged);
      const extras = [
        parsed.invalidCount ? `${parsed.invalidCount} invalid skipped` : "",
        parsed.duplicates ? `${parsed.duplicates} duplicates removed` : "",
      ].filter(Boolean);
      setNote(`${parsed.emails.length} email address${parsed.emails.length === 1 ? "" : "es"} detected in ${file.name}, ${merged.length - before} added${extras.length ? ` (${extras.join(", ")})` : ""}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const shown = expanded ? value : value.slice(0, VISIBLE_CHIPS);
  const hidden = value.length - shown.length;

  return (
    <div className="flex flex-col gap-1.5">
      {/* On phones Upload List drops to its own line under the chips. */}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1 border-b border-line py-2.5 md:flex-nowrap">
        <label htmlFor="to-input" className="w-14 shrink-0 pt-1.5 text-[13px] text-ink md:pt-1">
          To
        </label>
        <div className={`flex min-w-0 flex-1 flex-wrap items-center gap-1.5 ${invalid ? "text-failed-fg" : ""}`}>
          {shown.map((email) => (
            <span key={email} className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-brand-500 bg-brand-50 py-0.5 pl-2 pr-0.5 text-xs text-ink md:gap-1 md:pr-2 md:text-[11px]">
              <span className="truncate">{email}</span>
              <button type="button" aria-label={`Remove ${email}`} onClick={() => onChange(value.filter((v) => v !== email))} className="shrink-0 rounded-full p-1 hover:text-ink md:p-0">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {hidden > 0 && (
            <button type="button" onClick={() => setExpanded(true)} className="rounded-full border border-brand-500 bg-brand-50 px-2.5 py-1 text-xs font-medium text-ink md:px-2 md:py-0.5 md:text-[11px]">
              +{hidden}
            </button>
          )}
          <input
            id="to-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={commitDraft}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (/[\s,;]/.test(text)) {
                e.preventDefault();
                add(text.split(/[\s,;]+/));
              }
            }}
            placeholder={value.length ? "Add more…" : "recipient@example.com"}
            inputMode="email"
            autoCapitalize="off"
            autoCorrect="off"
            enterKeyHint="done"
            className="min-w-[60px] flex-1 bg-transparent py-1 text-[13px] outline-none placeholder:text-ink-subtle"
          />
        </div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="inline-flex min-h-10 shrink-0 basis-full items-center gap-1.5 pl-[72px] text-[13px] text-brand-600 hover:text-brand-700 disabled:opacity-60 md:min-h-0 md:basis-auto md:pl-0 md:pt-1"
        >
          {uploading ? <Spinner className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
          Upload List
        </button>
        <input ref={fileRef} type="file" accept=".csv,.txt,text/csv" hidden onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
      {note && !error && <p className="pl-[72px] text-xs text-ink-muted">{note}</p>}
      {error && (
        <div className="pl-[72px]">
          <InlineError>{error}</InlineError>
        </div>
      )}
    </div>
  );
}
