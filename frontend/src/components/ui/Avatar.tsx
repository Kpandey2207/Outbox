import clsx from "clsx";
import { initials } from "@/lib/format";

export function Avatar({ src, name, size = 40, className }: { src?: string | null; name: string; size?: number; className?: string }) {
  const style = { width: size, height: size };
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" style={style} referrerPolicy="no-referrer" className={clsx("rounded-full object-cover", className)} />;
  }
  return (
    <div
      style={style}
      aria-hidden
      className={clsx("flex items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700", className)}
    >
      {initials(name)}
    </div>
  );
}
