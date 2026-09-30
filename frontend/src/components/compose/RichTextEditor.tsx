"use client";

import clsx from "clsx";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronsUpDown,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Type,
  Underline,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sanitizeEmailHtml } from "@/lib/sanitize";

interface Command {
  label: string;
  icon: LucideIcon;
  command: string;
  value?: string;
}

interface Menu {
  label: string;
  icon: LucideIcon;
  options: Command[];
}

type Item = Command | Menu;

const cmd = (label: string, icon: LucideIcon, command: string, value?: string): Command => ({ label, icon, command, value });

// Same groups and order as the compose toolbar in the design.
const GROUPS: Item[][] = [
  [cmd("Undo", Undo2, "undo"), cmd("Redo", Redo2, "redo")],
  [
    {
      label: "Text size",
      icon: Type,
      options: [cmd("Small", Type, "fontSize", "2"), cmd("Normal", Type, "fontSize", "3"), cmd("Large", Type, "fontSize", "5")],
    },
  ],
  [cmd("Bold", Bold, "bold"), cmd("Italic", Italic, "italic"), cmd("Underline", Underline, "underline")],
  [
    {
      label: "Alignment",
      icon: AlignCenter,
      options: [cmd("Align left", AlignLeft, "justifyLeft"), cmd("Align center", AlignCenter, "justifyCenter"), cmd("Align right", AlignRight, "justifyRight")],
    },
  ],
  [
    cmd("Numbered list", ListOrdered, "insertOrderedList"),
    cmd("Bulleted list", List, "insertUnorderedList"),
    cmd("Indent", IndentIncrease, "indent"),
    cmd("Outdent", IndentDecrease, "outdent"),
    cmd("Quote", Quote, "formatBlock", "blockquote"),
    cmd("Clear formatting", RemoveFormatting, "removeFormat"),
  ],
  [cmd("Strikethrough", Strikethrough, "strikeThrough")],
];

const toolButton =
  "flex h-9 min-w-9 items-center justify-center gap-0.5 rounded-md px-1.5 text-ink-muted hover:bg-surface-muted hover:text-ink md:h-7 md:min-w-0";

/**
 * A small contentEditable editor. execCommand is deprecated but still universally supported
 * and keeps this dependency free; the output is sanitised again wherever it is displayed.
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  invalid,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  invalid?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [openMenu, setOpenMenu] = useState<{ label: string; top: number; left: number } | null>(null);

  // The toolbar scrolls sideways on phones, so its menus are positioned against the
  // viewport instead of inside it (where they would be clipped). Close them on scroll.
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    const outside = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!t.closest("[role=menu]") && !t.closest("[aria-haspopup=menu]")) close();
    };
    // Capture catches the toolbar's own sideways scroll and the page scrolling alike.
    document.addEventListener("scroll", close, { capture: true, passive: true });
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("scroll", close, { capture: true });
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", close);
    };
  }, [openMenu]);

  const toggleMenu = (label: string, button: HTMLElement) => {
    if (openMenu?.label === label) return setOpenMenu(null);
    const r = button.getBoundingClientRect();
    setOpenMenu({ label, top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 160) });
  };

  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = sanitizeEmailHtml(value);
  }, [value]);

  const run = (c: Command) => {
    ref.current?.focus();
    document.execCommand(c.command, false, c.value);
    onChange(ref.current?.innerHTML ?? "");
    setOpenMenu(null);
  };

  return (
    <div className={clsx("rounded-xl bg-surface-muted p-2.5", invalid && "ring-1 ring-failed-fg")}>
      <div
        className="scroll-x flex flex-nowrap items-center gap-1 rounded-lg bg-surface px-1 py-1 md:flex-wrap md:px-2"
        role="toolbar"
        aria-label="Formatting"
      >
        {GROUPS.map((group, gi) => (
          <div key={gi} className="flex shrink-0 items-center gap-0.5 border-r border-line pr-1 last:border-r-0">
            {group.map((item) =>
              "options" in item ? (
                <div key={item.label}>
                  <button
                    type="button"
                    title={item.label}
                    aria-label={item.label}
                    aria-expanded={openMenu?.label === item.label}
                    aria-haspopup="menu"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => toggleMenu(item.label, e.currentTarget)}
                    className={toolButton}
                  >
                    <item.icon className="h-4 w-4" />
                    <ChevronsUpDown className="h-3 w-3" />
                  </button>
                  {openMenu?.label === item.label && (
                    <div
                      role="menu"
                      style={{ top: openMenu.top, left: openMenu.left }}
                      className="animate-pop-in fixed z-40 w-36 rounded-lg border border-line bg-surface py-1 shadow-md"
                    >
                      {item.options.map((o) => (
                        <button
                          key={o.label}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => run(o)}
                          role="menuitem"
                          className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-surface-muted md:py-1.5 md:text-xs"
                        >
                          <o.icon className="h-3.5 w-3.5" />
                          {o.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <button
                  key={item.label}
                  type="button"
                  title={item.label}
                  aria-label={item.label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => run(item)}
                  className={toolButton}
                >
                  <item.icon className="h-4 w-4" />
                </button>
              ),
            )}
          </div>
        ))}
      </div>
      <div
        ref={ref}
        role="textbox"
        aria-multiline
        aria-label="Email body"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={(e) => onChange((e.target as HTMLDivElement).innerHTML)}
        onPaste={(e) => {
          // Pasted HTML is cleaned before it enters the editor (and so the stored body).
          const html = e.clipboardData.getData("text/html");
          if (!html) return;
          e.preventDefault();
          document.execCommand("insertHTML", false, sanitizeEmailHtml(html));
          onChange(ref.current?.innerHTML ?? "");
        }}
        className={clsx(
          "rich-text min-h-[220px] px-2.5 py-3 text-[13px] leading-relaxed outline-none md:min-h-[280px]",
          "empty:before:pointer-events-none empty:before:text-ink-subtle empty:before:content-[attr(data-placeholder)]",
        )}
      />
    </div>
  );
}
