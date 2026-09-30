import DOMPurify from "dompurify";

let hooked = false;

/**
 * Email bodies are untrusted HTML (whoever scheduled them wrote it, and it may come from a
 * paste). Everything that reaches the DOM goes through here: scripts, event handlers and
 * javascript: URLs are stripped by DOMPurify, and on top of that nothing that could restyle
 * or take over the dashboard (style blocks, forms, frames) survives. Links open in a new tab
 * without handing the opened page a reference back to this one.
 */
export function sanitizeEmailHtml(html: string): string {
  if (!hooked) {
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A" && node.getAttribute("href")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      }
    });
    hooked = true;
  }
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "frame", "object", "embed", "base", "meta", "link"],
    // class and id would let a body borrow the dashboard's own styles (Tailwind's "fixed
    // inset-0", say) or collide with its element ids.
    FORBID_ATTR: ["srcset", "formaction", "action", "class", "id"],
    ALLOW_DATA_ATTR: false,
  });
}

/** Only plain web links; anything else (javascript:, data:) is dropped. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
