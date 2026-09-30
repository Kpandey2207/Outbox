"use client";

import { FileSpreadsheet, FileText, FileArchive, File as FileIcon, X } from "lucide-react";
import { api } from "@/lib/api";
import type { Attachment } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { Spinner } from "../ui/Spinner";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const ACCEPTED_ATTACHMENTS = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip";
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;

function DocIcon({ contentType }: { contentType: string }) {
  const cls = "h-7 w-7 text-brand-600";
  if (contentType.includes("sheet") || contentType.includes("excel") || contentType === "text/csv") return <FileSpreadsheet className={cls} />;
  if (contentType === "application/zip") return <FileArchive className={cls} />;
  if (contentType.startsWith("text/") || contentType.includes("pdf") || contentType.includes("word")) return <FileText className={cls} />;
  return <FileIcon className={cls} />;
}

export function AttachmentTile({
  file,
  pendingName,
  onRemove,
}: {
  file?: Attachment;
  /** Shown while the upload is still in flight. */
  pendingName?: string;
  onRemove?: () => void;
}) {
  const name = file?.filename ?? pendingName ?? "";
  const body = !file ? (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-2 text-center">
      <Spinner className="h-5 w-5 text-brand-600" />
      <span className="w-full truncate text-[11px] text-ink-muted">{name}</span>
    </div>
  ) : IMAGE_TYPES.has(file.contentType) ? (
    // eslint-disable-next-line @next/next/no-img-element -- served by the API behind the session cookie
    <img src={api.attachmentUrl(file.id)} alt={file.filename} className="h-full w-full object-cover" />
  ) : (
    <div className="flex h-full flex-col justify-between p-2.5">
      <DocIcon contentType={file.contentType} />
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium text-ink" title={file.filename}>
          {file.filename}
        </p>
        <p className="text-[10px] text-ink-subtle">{formatBytes(file.size)}</p>
      </div>
    </div>
  );

  return (
    <div className="group relative h-20 w-28 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-muted" title={file ? `${file.filename} (${formatBytes(file.size)})` : `Uploading ${name}`}>
      {file ? (
        <a href={api.attachmentUrl(file.id)} target="_blank" rel="noreferrer" className="block h-full w-full">
          {body}
        </a>
      ) : (
        body
      )}
      {onRemove && file && (
        <button
          type="button"
          aria-label={`Remove ${file.filename}`}
          onClick={onRemove}
          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white transition-opacity sm:opacity-0 sm:focus:opacity-100 sm:group-hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
