"use client";

import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { toLocalInputValue } from "@/lib/format";
import { Button } from "../ui/Button";
import { Sheet } from "../ui/Sheet";

function tomorrowAt(hour = 9): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

const PRESETS = [
  { label: "Tomorrow", at: () => tomorrowAt() },
  { label: "Tomorrow, 10:00 AM", at: () => tomorrowAt(10) },
  { label: "Tomorrow, 11:00 AM", at: () => tomorrowAt(11) },
  { label: "Tomorrow, 3:00 PM", at: () => tomorrowAt(15) },
];

/** Popover on desktop, bottom sheet on phones. */
export function SendLaterPicker({
  onCancel,
  onDone,
  busy,
  asSheet,
}: {
  onCancel: () => void;
  onDone: (at: Date) => void;
  busy?: boolean;
  asSheet?: boolean;
}) {
  // Captured once when the picker opens; good enough for "is this in the past".
  const [openedAt] = useState(() => Date.now());
  const [value, setValue] = useState("");
  const [preset, setPreset] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const chosen = value ? new Date(value) : null;
  const inPast = chosen !== null && chosen.getTime() < openedAt - 60_000;

  useEffect(() => {
    if (asSheet) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !busy && onCancel();
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onCancel, busy, asSheet]);

  const body = (
    <>
      <h2 className="text-base font-semibold md:text-sm md:font-medium">Send Later</h2>
      <label className="relative mt-4 flex items-center border-b border-line pb-1.5">
        <span className="sr-only">Pick date and time</span>
        <input
          type="datetime-local"
          value={value}
          min={toLocalInputValue(new Date(openedAt))}
          onChange={(e) => {
            setValue(e.target.value);
            setPreset(null);
          }}
          className={`peer min-h-10 w-full bg-transparent text-xs outline-none focus:text-ink md:min-h-0 [&::-webkit-calendar-picker-indicator]:opacity-0 ${value ? "text-ink" : "text-transparent"}`}
        />
        {!value && <span className="pointer-events-none absolute left-0 text-sm text-ink-subtle peer-focus:hidden md:text-xs">Pick date &amp; time</span>}
        <CalendarDays className="pointer-events-none absolute right-0 h-4 w-4 text-ink-muted" aria-hidden />
      </label>
      <ul className="mt-3 flex flex-col md:min-h-[150px]">
        {PRESETS.map((p, i) => (
          <li key={p.label}>
            <button
              type="button"
              onClick={() => {
                setValue(toLocalInputValue(p.at()));
                setPreset(i);
              }}
              className={clsx(
                "w-full rounded-md px-2 py-3 text-left text-sm transition-colors hover:bg-surface-muted md:px-1 md:py-2 md:text-xs",
                preset === i && "bg-brand-50 font-medium",
              )}
            >
              {p.label}
            </button>
          </li>
        ))}
      </ul>
      {inPast && <p className="mt-2 text-xs text-failed-fg">Pick a time in the future.</p>}
      <div className="mt-4 grid grid-cols-2 gap-2 md:flex md:items-center md:justify-end">
        <Button type="button" variant="ghost" className="py-3 md:px-3 md:py-1.5 md:text-xs" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" variant="outline" pill className="py-3 md:px-4 md:py-1.5 md:text-xs" loading={busy} disabled={!chosen || inPast || Number.isNaN(chosen.getTime())} onClick={() => chosen && onDone(chosen)}>
          Done
        </Button>
      </div>
    </>
  );

  if (asSheet) {
    return (
      <Sheet open onClose={onCancel} title="Send later" dismissible={!busy}>
        <div className="px-5 pb-5 pt-2">{body}</div>
      </Sheet>
    );
  }
  return (
    <div ref={ref} role="dialog" aria-label="Send later" className="animate-pop-in absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border border-line bg-surface p-4 shadow-lg">
      {body}
    </div>
  );
}
